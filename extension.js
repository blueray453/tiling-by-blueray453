import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { initLogging, stopLogging, createLogger, flushBuffer } from './logger.js';

const journal = createLogger(import.meta.url);

const WINDOW_ANIMATION_TIME = 250;
const EDGE_ZONE = 25;
const CORNER_ZONE = 100;
const TILE_MATCH_THRESHOLD = 8;

const Display = global.get_display();

const TilePreview = GObject.registerClass(
  class TilePreview extends St.Widget {
    _init() {
      super._init();
      global.window_group.add_child(this);
      this._reset();
      this._showing = false;
    }

    open(window, tileRect, monitorIndex) {
      const windowActor = window.get_compositor_private();
      if (!windowActor) return;
      global.window_group.set_child_above_sibling(this, windowActor);
      if (this._rect && this._rect.equal(tileRect)) return;
      const changeMonitor = this._monitorIndex === -1 || this._monitorIndex !== monitorIndex;
      this._monitorIndex = monitorIndex;
      this._rect = tileRect;
      const monitor = Main.layoutManager.monitors[monitorIndex];
      this._updateStyle(monitor);
      if (!this._showing || changeMonitor) {
        const monitorRect = new Mtk.Rectangle({
          x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
        });
        const [, rect] = window.get_frame_rect().intersect(monitorRect);
        this.set_size(rect.width, rect.height);
        this.set_position(rect.x, rect.y);
        this.opacity = 0;
      }
      this._showing = true;
      this.show();
      this.ease({
        x: tileRect.x, y: tileRect.y, width: tileRect.width, height: tileRect.height,
        opacity: 255, duration: WINDOW_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
    }

    close() {
      if (!this._showing) return;
      this._showing = false;
      this.ease({
        opacity: 0, duration: WINDOW_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => this._reset(),
      });
    }

    _reset() {
      this.hide();
      this._rect = null;
      this._monitorIndex = -1;
    }

    _updateStyle(monitor) {
      const styles = ['tile-preview'];
      if (this._monitorIndex === Main.layoutManager.primaryIndex)
        styles.push('on-primary');
      if (this._rect.x === monitor.x)
        styles.push('tile-preview-left');
      if (this._rect.x + this._rect.width === monitor.x + monitor.width)
        styles.push('tile-preview-right');
      this.style_class = styles.join(' ');
    }
  });

function getTileZone(px, py, workArea) {
  const nearCornerTop = py <= workArea.y + CORNER_ZONE;
  const nearCornerBottom = py >= workArea.y + workArea.height - CORNER_ZONE;
  const nearCornerLeft = px <= workArea.x + CORNER_ZONE;
  const nearCornerRight = px >= workArea.x + workArea.width - CORNER_ZONE;
  if (nearCornerTop && nearCornerLeft) return 'top-left';
  if (nearCornerTop && nearCornerRight) return 'top-right';
  if (nearCornerBottom && nearCornerLeft) return 'bottom-left';
  if (nearCornerBottom && nearCornerRight) return 'bottom-right';
  if (py <= workArea.y + EDGE_ZONE) return 'maximize';
  if (px <= workArea.x + EDGE_ZONE) return 'left';
  if (px >= workArea.x + workArea.width - EDGE_ZONE) return 'right';
  return null;
}

function getRectForZone(zone, workArea, hfraction = 0.5) {
  const leftW = Math.round(workArea.width * hfraction);
  const rightW = workArea.width - leftW;
  const halfH = Math.floor(workArea.height / 2);
  switch (zone) {
    case 'left':
      return new Mtk.Rectangle({ x: workArea.x, y: workArea.y, width: leftW, height: workArea.height });
    case 'right':
      return new Mtk.Rectangle({ x: workArea.x + leftW, y: workArea.y, width: rightW, height: workArea.height });
    case 'maximize':
      return new Mtk.Rectangle({ x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height });
    case 'top-left':
      return new Mtk.Rectangle({ x: workArea.x, y: workArea.y, width: Math.floor(workArea.width / 2), height: halfH });
    case 'top-right':
      return new Mtk.Rectangle({ x: workArea.x + Math.floor(workArea.width / 2), y: workArea.y, width: workArea.width - Math.floor(workArea.width / 2), height: halfH });
    case 'bottom-left':
      return new Mtk.Rectangle({ x: workArea.x, y: workArea.y + halfH, width: Math.floor(workArea.width / 2), height: workArea.height - halfH });
    case 'bottom-right':
      return new Mtk.Rectangle({ x: workArea.x + Math.floor(workArea.width / 2), y: workArea.y + halfH, width: workArea.width - Math.floor(workArea.width / 2), height: workArea.height - halfH });
    default:
      return null;
  }
}

export default class JsTilingExtension extends Extension {
  enable() {
    initLogging(this.uuid, { output: 'both', level: 'debug', enabled: false });
    journal(`Enable`);

    this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    this._mutterSettings.set_boolean('edge-tiling', false);

    this._tilePreview = null;
    this._grabbedWindow = null;
    this._pendingZone = null;
    this._resizingWindow = null;

    // Dedicated per-drag context objects. Using these (instead of `this`)
    // as the connectObject context means a single disconnectObject() call
    // removes exactly the handlers we added for that drag — not every
    // handler this extension has ever registered on the window.
    this._dragContext = null;
    this._resizeContext = null;

    this._pendingMoveResizeIds = new Map();

    // Tracks windows we've already attached a 'unmanaging' cleanup handler
    // to, so repeated moves of the same window don't stack handlers.
    this._moveResizeTracked = new WeakSet();

    this._tileStates = new WeakMap();
    this._cleanupTracked = new WeakSet();

    this._grabBeginId = Display.connect('grab-op-begin', this._onGrabOpBegin.bind(this));
    this._grabEndId = Display.connect('grab-op-end', this._onGrabOpEnd.bind(this));
  }

  disable() {
    if (this._grabBeginId) { Display.disconnect(this._grabBeginId); this._grabBeginId = null; }
    if (this._grabEndId) { Display.disconnect(this._grabEndId); this._grabEndId = null; }

    if (this._grabbedWindow && this._dragContext) {
      this._grabbedWindow.disconnectObject(this._dragContext);
      this._grabbedWindow = null;
      this._dragContext = null;
    }
    if (this._resizingWindow && this._resizeContext) {
      this._resizingWindow.disconnectObject(this._resizeContext);
      this._resizingWindow = null;
      this._resizeContext = null;
    }

    if (this._tilePreview) { this._tilePreview.destroy(); this._tilePreview = null; }
    this._pendingZone = null;

    for (const id of this._pendingMoveResizeIds.values())
      GLib.Source.remove(id);
    this._pendingMoveResizeIds.clear();

    // Fresh WeakMap, not null: windows tracked via _trackForCleanup still
    // hold 'unmanaging' handlers keyed on this extension, and those handlers
    // call _clearTileState() -> this._tileStates.get(). If we nulled this,
    // closing any tiled window after disable() would throw.
    this._tileStates = new WeakMap();
    this._moveResizeTracked = new WeakSet();
    this._cleanupTracked = new WeakSet();

    if (this._mutterSettings) {
      this._mutterSettings.set_boolean('edge-tiling', true);
      this._mutterSettings = null;
    }

    flushBuffer();
    stopLogging();
  }

  // ---- tile state helpers ----
  _getTileState(window) {
    return this._tileStates.get(window) ?? null;
  }

  _setTileState(window, patch) {
    const existing = this._tileStates.get(window) ?? {};
    const next = { ...existing, ...patch };
    this._tileStates.set(window, next);
    return next;
  }

  _clearTileState(window) {
    if (!this._tileStates) return;
    const state = this._tileStates.get(window);
    if (state?.match) {
      const matchState = this._tileStates.get(state.match);
      if (matchState)
        this._tileStates.set(state.match, { ...matchState, match: null, zone: undefined, fraction: undefined });
    }
    this._tileStates.delete(window);
  }

  _trackForCleanup(window) {
    if (this._cleanupTracked.has(window))
      return;
    this._cleanupTracked.add(window);
    window.connectObject('unmanaging', () => this._clearTileState(window), this);
  }

  // Idle-deferred move_resize_frame. Use this only from inside
  // grab-op-begin / grab-op-end handlers, where mutter's own grab
  // machinery is still running.
  _moveResizeWindow(metaWindow, x, y, width, height, onComplete = null) {
    const existingId = this._pendingMoveResizeIds.get(metaWindow);
    if (existingId) {
      GLib.Source.remove(existingId);
      this._pendingMoveResizeIds.delete(metaWindow);
    }

    if (!this._moveResizeTracked.has(metaWindow)) {
      this._moveResizeTracked.add(metaWindow);
      metaWindow.connectObject('unmanaging', () => {
        const id = this._pendingMoveResizeIds.get(metaWindow);
        if (id) {
          GLib.Source.remove(id);
          this._pendingMoveResizeIds.delete(metaWindow);
        }
      }, this);
    }

    const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._pendingMoveResizeIds.delete(metaWindow);
      metaWindow.move_resize_frame(true, x, y, width, height);
      if (onComplete)
        onComplete();
      return GLib.SOURCE_REMOVE;
    });

    this._pendingMoveResizeIds.set(metaWindow, idleId);
  }

  // ---- clone-based snap animation ----
  //
  // Take a static snapshot of the window before the geometry change, hide
  // the real window actor, put the snapshot on top, apply the geometry
  // change (window actor is invisible so its jump doesn't matter), ease the
  // snapshot from old to new rect, then destroy the snapshot and show the
  // real window actor again — which is by then already at its final rect.
  //
  // Hiding the actor is what keeps the real window from ever peeking
  // through: previously it was underneath the clone, which works until a
  // shadow, rounded corner, or CSD edge pokes out. With the actor hidden
  // there's nothing underneath to peek.
  //
  // The tile preview is placed *above* the clone so it remains fully
  // visible for the whole animation and fades out only at the end.
  _playCloneAnimation(metaWindow, targetRect, applyAction, onComplete = null) {
    const actor = metaWindow.get_compositor_private();

    const finish = () => {
      if (actor) actor.show();
      if (this._tilePreview) this._tilePreview.close();
      if (onComplete) onComplete();
    };

    if (!actor) { applyAction(); finish(); return; }

    const frameRect = metaWindow.get_frame_rect();

    let actorContent = null;
    try {
      actorContent = actor.paint_to_content(frameRect);
    } catch (e) {
      actorContent = null;
    }
    if (!actorContent) { applyAction(); finish(); return; }

    const clone = new St.Widget({ content: actorContent });
    clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
    clone.set_position(frameRect.x, frameRect.y);
    clone.set_size(frameRect.width, frameRect.height);
    global.window_group.add_child(clone);

    actor.hide();

    if (this._tilePreview && this._tilePreview.visible)
      global.window_group.set_child_above_sibling(this._tilePreview, clone);

    applyAction();

    clone.ease({
      x: targetRect.x, y: targetRect.y,
      width: targetRect.width, height: targetRect.height,
      duration: WINDOW_ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        clone.destroy();
        finish();
      },
    });
  }

  _animateWindowTo(metaWindow, x, y, width, height, onComplete = null) {
    this._playCloneAnimation(
      metaWindow,
      { x, y, width, height },
      () => this._moveResizeWindow(metaWindow, x, y, width, height),
      onComplete);
  }

  _animateMaximize(metaWindow, onComplete = null) {
    const actor = metaWindow.get_compositor_private();
    const frameRect = metaWindow.get_frame_rect();
    const workArea = metaWindow.get_work_area_for_monitor(metaWindow.get_monitor());

    const finish = () => {
      if (this._tilePreview) this._tilePreview.close();
      if (onComplete) onComplete();
    };

    if (!actor) {
      metaWindow.maximize(Meta.MaximizeFlags.BOTH);
      finish();
      return;
    }

    let actorContent = null;
    try {
      actorContent = actor.paint_to_content(frameRect);
    } catch (e) {
      actorContent = null;
    }
    if (!actorContent) {
      metaWindow.maximize(Meta.MaximizeFlags.BOTH);
      finish();
      return;
    }

    const clone = new St.Widget({ content: actorContent });
    clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
    clone.set_position(frameRect.x, frameRect.y);
    clone.set_size(frameRect.width, frameRect.height);
    global.window_group.add_child(clone);

    actor.hide();

    // Mutter's compositor sync re-shows the actor on the frame after
    // maximize(). Keep it suppressed for the whole animation.
    const showId = actor.connect('show', () => actor.hide());

    if (this._tilePreview && this._tilePreview.visible)
      global.window_group.set_child_above_sibling(this._tilePreview, clone);

    metaWindow.maximize(Meta.MaximizeFlags.BOTH);

    clone.ease({
      x: workArea.x, y: workArea.y,
      width: workArea.width, height: workArea.height,
      duration: WINDOW_ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        actor.disconnect(showId);
        clone.destroy();
        actor.show();
        finish();
      },
    });
  }

  _isTileable(window) {
    if (!window) return false;
    if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (window.is_override_redirect()) return false;
    const maxState = window.get_maximized();
    if (maxState & Meta.MaximizeFlags.BOTH)
      return true;
    if (!window.allows_resize() || !window.allows_move()) return false;
    return true;
  }

  _monitorForPoint(x, y) {
    return Display.get_monitor_index_for_rect(new Mtk.Rectangle({ x, y, width: 1, height: 1 }));
  }

  _findTileMatch(window) {
    const zone = this._getTileState(window)?.zone;
    if (zone !== 'left' && zone !== 'right') return null;
    const wantZone = zone === 'left' ? 'right' : 'left';
    const rect = window.get_frame_rect();
    const monitor = window.get_monitor();
    const workspace = window.get_workspace();

    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
      const other = actors[i].get_meta_window();
      if (other === window || !other || other.minimized) continue;
      if (this._getTileState(other)?.zone !== wantZone) continue;
      if (other.get_monitor() !== monitor) continue;
      if (other.get_workspace() !== workspace) continue;

      const otherRect = other.get_frame_rect();
      const gap = zone === 'left'
        ? Math.abs(otherRect.x - (rect.x + rect.width))
        : Math.abs(rect.x - (otherRect.x + otherRect.width));
      if (gap > TILE_MATCH_THRESHOLD) continue;

      return other;
    }
    return null;
  }

  _findAutoTilePartner(window, monitorIndex) {
    const workspace = window.get_workspace();
    const actors = global.get_window_actors();
    const candidates = [];

    for (let i = actors.length - 1; i >= 0; i--) {
      const other = actors[i].get_meta_window();
      if (other === window || !other) continue;
      if (other.minimized) continue;
      if (this._getTileState(other)?.zone) continue;
      if (!this._isTileable(other)) continue;
      if (other.get_workspace() !== workspace) continue;
      if (other.get_monitor() !== monitorIndex) continue;
      candidates.push(other);
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  _onGrabOpBegin(display, window, op) {
    if (!this._isTileable(window)) return;

    if (op === Meta.GrabOp.MOVING) {
      const state = this._getTileState(window);
      const isMaximized = (window.get_maximized() & Meta.MaximizeFlags.BOTH) === Meta.MaximizeFlags.BOTH;

      if (state?.zone || isMaximized) {
        let untiled;

        if (state?.zone) {
          untiled = state.untiledRect ?? window.get_frame_rect().copy();
          if (isMaximized)
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        } else {
          window.unmaximize(Meta.MaximizeFlags.BOTH);
          untiled = window.get_frame_rect().copy();
        }

        const cur = window.get_frame_rect();
        const [px, py] = global.get_pointer();
        const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;
        const newX = Math.round(px - fracX * untiled.width);
        const newY = Math.round(py - Math.min(20, untiled.height * 0.05));

        window.move_resize_frame(true, newX, newY, untiled.width, untiled.height);
        this._clearTileState(window);
      }

      this._grabbedWindow = window;
      this._pendingZone = null;

      this._setTileState(window, { untiledRect: window.get_frame_rect().copy() });

      this._dragContext = new GObject.Object();
      window.connectObject('position-changed', this._onWindowPositionChanged.bind(this), this._dragContext);
      return;
    }

    const tileState = this._getTileState(window);
    if (tileState?.zone && tileState?.match) {
      this._resizingWindow = window;
      this._resizeContext = new GObject.Object();
      window.connectObject('size-changed', this._onTiledWindowResized.bind(this), this._resizeContext);
    }
  }

  _onTiledWindowResized(window) {
    const state = this._getTileState(window);
    const match = state?.match;
    const matchZone = match ? this._getTileState(match)?.zone : null;
    if (!match || !matchZone) return;

    const monitorIndex = window.get_monitor();
    const workArea = window.get_work_area_for_monitor(monitorIndex);
    const rect = window.get_frame_rect();

    let hfraction;
    if (state.zone === 'left')
      hfraction = rect.width / workArea.width;
    else
      hfraction = 1 - (rect.width / workArea.width);
    hfraction = Math.min(0.9, Math.max(0.1, hfraction));

    this._setTileState(window, { fraction: hfraction });
    this._setTileState(match, { fraction: hfraction });

    const leftWin = state.zone === 'left' ? window : match;
    const rightWin = leftWin === window ? match : window;
    const leftRect = getRectForZone('left', workArea, hfraction);
    const rightRect = getRectForZone('right', workArea, hfraction);

    if (rightWin !== window)
      this._moveResizeWindow(rightWin, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
    if (leftWin !== window)
      this._moveResizeWindow(leftWin, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
  }

  _onGrabOpEnd(display, window, op) {
    if (this._resizingWindow === window) {
      if (this._resizeContext)
        window.disconnectObject(this._resizeContext);
      this._resizeContext = null;
      this._resizingWindow = null;
      return;
    }

    if (window !== this._grabbedWindow) return;

    if (this._dragContext)
      window.disconnectObject(this._dragContext);
    this._dragContext = null;
    this._grabbedWindow = null;

    // The preview stays open here on purpose — the clone animation closes
    // it on completion, so it remains fully visible for the whole glide.

    const zone = this._pendingZone;
    this._pendingZone = null;
    if (!zone) {
      if (this._tilePreview) this._tilePreview.close();
      this._clearTileState(window);
      return;
    }

    const monitorIndex = window.get_monitor();
    const workArea = window.get_work_area_for_monitor(monitorIndex);

    if (zone === 'maximize' || !(zone === 'left' || zone === 'right')) {
      if (zone === 'maximize') {
        this._animateMaximize(window);
      } else {
        const rect = getRectForZone(zone, workArea);
        this._animateWindowTo(window, rect.x, rect.y, rect.width, rect.height);
      }
      this._clearTileState(window);
      return;
    }

    const hfraction = this._getTileState(window)?.fraction ?? 0.5;
    const fraction = zone === 'left' ? hfraction : 1 - hfraction;
    const leftRect = getRectForZone('left', workArea, fraction);
    const rightRect = getRectForZone('right', workArea, fraction);

    let leftWin, rightWin;
    if (zone === 'left') {
      leftWin = window;
      rightWin = this._findTileMatch(window);
    } else {
      rightWin = window;
      leftWin = this._findTileMatch(window);
    }

    if (!leftWin || !rightWin) {
      const partner = this._findAutoTilePartner(window, monitorIndex);
      if (partner) {
        if (zone === 'left') {
          leftWin = window;
          rightWin = partner;
        } else {
          rightWin = window;
          leftWin = partner;
        }
      }
    }

    if (leftWin && rightWin) {
      this._setTileState(leftWin, { zone: 'left', fraction, match: rightWin });
      this._setTileState(rightWin, { zone: 'right', fraction, match: leftWin });
      this._trackForCleanup(leftWin);
      this._trackForCleanup(rightWin);

      if (leftWin.get_maximized?.())
        leftWin.unmaximize(Meta.MaximizeFlags.BOTH);
      if (rightWin.get_maximized?.())
        rightWin.unmaximize(Meta.MaximizeFlags.BOTH);

      this._animateWindowTo(leftWin, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
      this._animateWindowTo(rightWin, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
    } else {
      this._setTileState(window, { zone, fraction, match: null });
      this._trackForCleanup(window);
      const rect = zone === 'left' ? leftRect : rightRect;
      this._animateWindowTo(window, rect.x, rect.y, rect.width, rect.height, () => {
        const match = this._findTileMatch(window);
        if (match) {
          this._setTileState(window, { match });
          this._setTileState(match, { match: window, fraction, zone: zone === 'left' ? 'right' : 'left' });
          this._trackForCleanup(match);
          const otherRect = zone === 'left' ? rightRect : leftRect;
          this._animateWindowTo(match, otherRect.x, otherRect.y, otherRect.width, otherRect.height);
        }
      });
    }
  }

  _onWindowPositionChanged(window) {
    const [px, py] = global.get_pointer();
    const monitorIndex = this._monitorForPoint(px, py);
    if (monitorIndex < 0) return;
    const workArea = window.get_work_area_for_monitor(monitorIndex);
    const zone = getTileZone(px, py, workArea);

    this._pendingZone = zone;
    if (zone) {
      const rect = getRectForZone(zone, workArea);
      if (!this._tilePreview) this._tilePreview = new TilePreview();
      this._tilePreview.open(window, rect, monitorIndex);
    } else if (this._tilePreview) {
      this._tilePreview.close();
    }
  }
}