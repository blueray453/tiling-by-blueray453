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
const POINTER_POLL_MS = 15;

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
      global.window_group.set_child_below_sibling(this, windowActor);
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
    this._lastLoggedZone = '<unset>';
    this._pointerPollId = 0;

    this._pendingMoveResizeIds = new Map();

    this._grabBeginId = Display.connect('grab-op-begin', this._onGrabOpBegin.bind(this));
    this._grabEndId = Display.connect('grab-op-end', this._onGrabOpEnd.bind(this));
  }

  disable() {
    this._stopPointerPoll();
    if (this._grabBeginId) { Display.disconnect(this._grabBeginId); this._grabBeginId = null; }
    if (this._grabEndId) { Display.disconnect(this._grabEndId); this._grabEndId = null; }
    if (this._grabbedWindow) { this._grabbedWindow.disconnectObject(this); this._grabbedWindow = null; }
    if (this._resizingWindow) { this._resizingWindow.disconnectObject(this); this._resizingWindow = null; }
    if (this._tilePreview) { this._tilePreview.destroy(); this._tilePreview = null; }
    this._pendingZone = null;

    for (const id of this._pendingMoveResizeIds.values())
      GLib.Source.remove(id);
    this._pendingMoveResizeIds.clear();

    if (this._mutterSettings) {
      this._mutterSettings.set_boolean('edge-tiling', true);
      this._mutterSettings = null;
    }

    flushBuffer();
    stopLogging();
  }

  _startPointerPoll(window) {
    this._stopPointerPoll();
    this._pointerPollId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT_IDLE,
      POINTER_POLL_MS,
      () => {
        if (!this._grabbedWindow || this._grabbedWindow !== window) {
          this._pointerPollId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._onWindowPositionChanged(window);
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopPointerPoll() {
    if (this._pointerPollId) {
      GLib.Source.remove(this._pointerPollId);
      this._pointerPollId = 0;
    }
  }

  _moveResizeWindow(metaWindow, x, y, width, height, onComplete = null) {
    const existingId = this._pendingMoveResizeIds.get(metaWindow);
    if (existingId) {
      GLib.Source.remove(existingId);
      this._pendingMoveResizeIds.delete(metaWindow);
    }

    metaWindow.connectObject('unmanaging', () => {
      const id = this._pendingMoveResizeIds.get(metaWindow);
      if (id) {
        GLib.Source.remove(id);
        this._pendingMoveResizeIds.delete(metaWindow);
      }
    }, this);

    const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._pendingMoveResizeIds.delete(metaWindow);
      metaWindow.move_resize_frame(true, x, y, width, height);
      if (onComplete)
        onComplete();
      return GLib.SOURCE_REMOVE;
    });

    this._pendingMoveResizeIds.set(metaWindow, idleId);
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
    const zone = window._jsTileZone;
    if (zone !== 'left' && zone !== 'right') return null;
    const wantZone = zone === 'left' ? 'right' : 'left';
    const rect = window.get_frame_rect();
    const monitor = window.get_monitor();
    const workspace = window.get_workspace();

    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
      const other = actors[i].get_meta_window();
      if (other === window || !other || other.minimized) continue;
      if (other._jsTileZone !== wantZone) continue;
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
      if (other._jsTileZone) continue;
      if (!this._isTileable(other)) continue;
      if (other.get_workspace() !== workspace) continue;
      if (other.get_monitor() !== monitorIndex) continue;
      candidates.push(other);
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  _clearTileState(window) {
    if (window._jsTileMatch) {
      delete window._jsTileMatch._jsTileMatch;
      delete window._jsTileMatch._jsTileZone;
      delete window._jsTileMatch._jsTileFraction;
    }
    delete window._jsTileZone;
    delete window._jsUntiledRect;
    delete window._jsTileFraction;
    delete window._jsTileMatch;
  }

  _onGrabOpBegin(display, window, op) {
    if (!this._isTileable(window)) return;

    if (op === Meta.GrabOp.MOVING) {
      if (window._jsTileZone) {
        const untiled = window._jsUntiledRect ?? window.get_frame_rect().copy();
        const cur = window.get_frame_rect();
        const [px, py] = global.get_pointer();
        const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;
        const newX = Math.round(px - fracX * untiled.width);
        const newY = Math.round(py - Math.min(20, untiled.height * 0.05));

        this._moveResizeWindow(window, newX, newY, untiled.width, untiled.height);
        this._clearTileState(window);
      }
      this._grabbedWindow = window;
      this._pendingZone = null;
      this._lastLoggedZone = '<unset>';
      window._jsUntiledRect = window._jsUntiledRect ?? window.get_frame_rect().copy();

      window.connectObject('position-changed', this._onWindowPositionChanged.bind(this), this);
      this._startPointerPoll(window);
      return;
    }

    if (window._jsTileZone && window._jsTileMatch) {
      this._resizingWindow = window;
      window.connectObject('size-changed', this._onTiledWindowResized.bind(this), this);
    }
  }

  _onTiledWindowResized(window) {
    const match = window._jsTileMatch;
    if (!match || !match._jsTileZone) return;
    const monitorIndex = window.get_monitor();
    const workArea = window.get_work_area_for_monitor(monitorIndex);
    const rect = window.get_frame_rect();

    let hfraction;
    if (window._jsTileZone === 'left')
      hfraction = rect.width / workArea.width;
    else
      hfraction = 1 - (rect.width / workArea.width);
    hfraction = Math.min(0.9, Math.max(0.1, hfraction));

    window._jsTileFraction = hfraction;
    match._jsTileFraction = hfraction;

    const leftWin = window._jsTileZone === 'left' ? window : match;
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
      window.disconnectObject(this);
      this._resizingWindow = null;
      return;
    }

    if (window !== this._grabbedWindow) return;

    this._stopPointerPoll();
    window.disconnectObject(this);
    this._grabbedWindow = null;
    if (this._tilePreview) this._tilePreview.close();

    const zone = this._pendingZone;
    this._pendingZone = null;
    if (!zone) {
      this._clearTileState(window);
      return;
    }

    const monitorIndex = window.get_monitor();
    const workArea = window.get_work_area_for_monitor(monitorIndex);

    if (zone === 'maximize' || !(zone === 'left' || zone === 'right')) {
      if (zone === 'maximize') {
        window.maximize(Meta.MaximizeFlags.BOTH);
      } else {
        const rect = getRectForZone(zone, workArea);
        this._moveResizeWindow(window, rect.x, rect.y, rect.width, rect.height);
      }
      this._clearTileState(window);
      return;
    }

    // if (window.get_maximized?.())
    //   window.unmaximize(Meta.MaximizeFlags.BOTH);

    const hfraction = window._jsTileFraction ?? 0.5;
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
      leftWin._jsTileZone = 'left';
      rightWin._jsTileZone = 'right';
      leftWin._jsTileFraction = fraction;
      rightWin._jsTileFraction = fraction;
      leftWin._jsTileMatch = rightWin;
      rightWin._jsTileMatch = leftWin;
      this._moveResizeWindow(leftWin, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
      this._moveResizeWindow(rightWin, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
    } else {
      window._jsTileZone = zone;
      window._jsTileFraction = fraction;
      window._jsTileMatch = null;
      const rect = zone === 'left' ? leftRect : rightRect;
      this._moveResizeWindow(window, rect.x, rect.y, rect.width, rect.height, () => {
        const match = this._findTileMatch(window);
        if (match) {
          window._jsTileMatch = match;
          match._jsTileMatch = window;
          match._jsTileFraction = fraction;
          match._jsTileZone = zone === 'left' ? 'right' : 'left';
          const otherRect = zone === 'left' ? rightRect : leftRect;
          this._moveResizeWindow(match, otherRect.x, otherRect.y, otherRect.width, otherRect.height);
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

    if (zone !== this._lastLoggedZone) {
      this._lastLoggedZone = zone;
    }

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