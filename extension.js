import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const WINDOW_ANIMATION_TIME = 250;
const EDGE_ZONE = 25;
const CORNER_ZONE = 100;
const TILE_MATCH_THRESHOLD = 8;

const Display = global.get_display();

import {
  initLogging,
  stopLogging,
  createLogger,
  flushBuffer,
} from './logger.js';

const journal = createLogger(import.meta.url);

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
    initLogging(this.uuid, { output: 'file', level: 'debug', enabled: false });
    journal(`Enabled`);

    this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    this._mutterSettings.set_boolean('edge-tiling', false);

    this._tilePreview = null;
    this._grabbedWindow = null;
    this._pendingZone = null;
    this._resizeSignalId = null;

    this._grabBeginId = Display.connect('grab-op-begin', this._onGrabOpBegin.bind(this));
    this._grabEndId = Display.connect('grab-op-end', this._onGrabOpEnd.bind(this));
  }

  disable() {
    if (this._grabBeginId) { Display.disconnect(this._grabBeginId); this._grabBeginId = null; }
    if (this._grabEndId) { Display.disconnect(this._grabEndId); this._grabEndId = null; }
    if (this._grabbedWindow) { this._grabbedWindow.disconnectObject(this); this._grabbedWindow = null; }
    if (this._tilePreview) { this._tilePreview.destroy(); this._tilePreview = null; }
    this._pendingZone = null;

    if (this._mutterSettings) {
      this._mutterSettings.set_boolean('edge-tiling', true);
      this._mutterSettings = null;
    }
    flushBuffer();
    stopLogging();
  }

  _isTileable(window) {
    if (!window) return false;
    if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
    if (window.is_override_redirect()) return false;
    if (!window.allows_resize() || !window.allows_move()) return false;
    return true;
  }

  _monitorForPoint(x, y) {
    return Display.get_monitor_index_for_rect(new Mtk.Rectangle({ x, y, width: 1, height: 1 }));
  }

  // Custom tile match finder (mirrors Mutter's logic)
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

  _clearTileState(window) {
    if (window._jsTileMatch) {
      delete window._jsTileMatch._jsTileMatch;
      delete window._jsTileMatch;
    }
    delete window._jsTileZone;
    delete window._jsUntiledRect;
    delete window._jsTileFraction;
  }

  _onGrabOpBegin(display, window, op) {
    if (!this._isTileable(window)) return;

    if (op === Meta.GrabOp.MOVING) {
      // If side‑tiled, untile and reposition under pointer
      if (window._jsTileZone) {
        const untiled = window._jsUntiledRect;
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
      window._jsUntiledRect = window._jsUntiledRect ?? window.get_frame_rect().copy();
      window.connectObject('position-changed', this._onWindowPositionChanged.bind(this), this);
      return;
    }

    // Resize grab on a side‑tiled window: mirror resize to match
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
      rightWin.move_resize_frame(true, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
    if (leftWin !== window)
      leftWin.move_resize_frame(true, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
  }

  _onGrabOpEnd(display, window, op) {
    if (this._resizingWindow === window) {
      window.disconnectObject(this);
      this._resizingWindow = null;
      return;
    }

    if (window !== this._grabbedWindow) return;
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

    // Maximize and corners: just move and clear tile state
    if (zone === 'maximize' || !(zone === 'left' || zone === 'right')) {
      const rect = getRectForZone(zone, workArea);
      window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
      this._clearTileState(window);
      return;
    }

    // Now handle left/right tiling
    const hfraction = window._jsTileFraction ?? 0.5;
    const fraction = zone === 'left' ? hfraction : 1 - hfraction;
    const leftRect = getRectForZone('left', workArea, fraction);
    const rightRect = getRectForZone('right', workArea, fraction);

    let leftWin, rightWin;
    if (zone === 'left') {
      leftWin = window;
      const match = this._findTileMatch(window);
      rightWin = match || null;
    } else { // zone === 'right'
      rightWin = window;
      const match = this._findTileMatch(window);
      leftWin = match || null;
    }

    // Set tile state and move both windows if both exist; otherwise set state for current and try to find partner after move
    if (leftWin && rightWin) {
      leftWin._jsTileZone = 'left';
      rightWin._jsTileZone = 'right';
      leftWin._jsTileFraction = fraction;
      rightWin._jsTileFraction = fraction;
      leftWin._jsTileMatch = rightWin;
      rightWin._jsTileMatch = leftWin;
      leftWin.move_resize_frame(true, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
      rightWin.move_resize_frame(true, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
    } else {
      // Only one window – set its state, move it, then try to find a partner again
      window._jsTileZone = zone;
      window._jsTileFraction = fraction;
      window._jsTileMatch = null;
      const rect = zone === 'left' ? leftRect : rightRect;
      window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
      // After moving, attempt to find a partner (in case one appears)
      const match = this._findTileMatch(window);
      if (match) {
        window._jsTileMatch = match;
        match._jsTileMatch = window;
        match._jsTileFraction = fraction;
        match._jsTileZone = zone === 'left' ? 'right' : 'left';
        // Move the partner to its correct rectangle
        const otherRect = zone === 'left' ? rightRect : leftRect;
        match.move_resize_frame(true, otherRect.x, otherRect.y, otherRect.width, otherRect.height);
      }
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