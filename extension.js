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

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

// ===========================================================================
// CONFIG
// ===========================================================================
const ANIMATION_TIME = 250;
const EDGE_ZONE = 25;
const CORNER_ZONE = 100;
const POINTER_POLL_MS = 15;
const DRAG_THRESHOLD = 8;
const AUTO_TILE_NEW_WINDOWS = true;

// ===========================================================================
// GEOMETRY: helpers still used from more than one place
// ===========================================================================
function getRectForZone(zone, workArea, hfraction = 0.5) {
  const leftW = Math.round(workArea.width * hfraction);
  const rightW = workArea.width - leftW;
  const halfH = Math.floor(workArea.height / 2);
  const halfW = Math.floor(workArea.width / 2);
  const R = (x, y, width, height) => new Mtk.Rectangle({ x, y, width, height });
  switch (zone) {
    case 'left': return R(workArea.x, workArea.y, leftW, workArea.height);
    case 'right': return R(workArea.x + leftW, workArea.y, rightW, workArea.height);
    case 'maximize': return R(workArea.x, workArea.y, workArea.width, workArea.height);
    case 'top-left': return R(workArea.x, workArea.y, halfW, halfH);
    case 'top-right': return R(workArea.x + halfW, workArea.y, workArea.width - halfW, halfH);
    case 'bottom-left': return R(workArea.x, workArea.y + halfH, halfW, workArea.height - halfH);
    case 'bottom-right': return R(workArea.x + halfW, workArea.y + halfH, workArea.width - halfW, workArea.height - halfH);
    default: return null;
  }
}

function oppositeZone(zone) {
  if (zone === 'left') return 'right';
  if (zone === 'right') return 'left';
  return null;
}

function isTileable(window) {
  if (!window) return false;
  if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
  if (window.is_override_redirect()) return false;
  if (window.get_maximized() & Meta.MaximizeFlags.BOTH) return true;
  if (!window.allows_resize() || !window.allows_move()) return false;
  return true;
}

function isMaximized(window) {
  return (window.get_maximized() & Meta.MaximizeFlags.BOTH) === Meta.MaximizeFlags.BOTH;
}

function workAreaOf(win) {
  return win.get_work_area_for_monitor(win.get_monitor());
}

function sameWorkspace(a, b) {
  return a.get_workspace() === b.get_workspace() ||
    a.is_on_all_workspaces() || b.is_on_all_workspaces();
}

// ===========================================================================
// OPS
// ===========================================================================
const ops = (() => {
  const BOTH = Meta.MaximizeFlags.BOTH;

  const teardowns = new Set();
  const busy = new Map();

  function abort() {
    for (const t of [...teardowns]) t(false);
    teardowns.clear();
    busy.clear();
  }

  function isBusy(win) {
    return (busy.get(win) ?? 0) > 0;
  }

  function hasAnimations() {
    return teardowns.size > 0;
  }

  function bump(win, delta) {
    const n = (busy.get(win) ?? 0) + delta;
    if (n <= 0) busy.delete(win);
    else busy.set(win, n);
  }

  function label(win) {
    try { return `"${win.get_title()}"`; } catch (e) { return '<window>'; }
  }

  function animateChange(win, targetRect, apply, { suppressReshow = false, onComplete = null } = {}) {
    const actor = win.get_compositor_private();

    const finish = () => {
      if (actor) { try { actor.show(); } catch (e) { /* destroyed */ } }
      animationHooks.onEnd();
      onComplete?.();
    };

    if (!actor) { apply(); finish(); return; }

    const frameRect = win.get_frame_rect();
    let content = null;
    try {
      content = actor.paint_to_content(frameRect);
    } catch (e) {
      content = null;
    }
    if (!content) { apply(); finish(); return; }

    const clone = new St.Widget({ content });
    clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
    clone.set_position(frameRect.x, frameRect.y);
    clone.set_size(frameRect.width, frameRect.height);
    global.window_group.add_child(clone);

    actor.hide();
    const showId = suppressReshow ? actor.connect('show', () => actor.hide()) : null;

    bump(win, +1);
    let done = false;
    const end = (runFinish) => {
      if (done) return;
      done = true;
      teardowns.delete(end);
      bump(win, -1);
      try { if (showId) actor.disconnect(showId); } catch (e) { /* destroyed */ }
      clone.destroy();
      if (runFinish) finish();
      else { try { actor.show(); } catch (e) { /* destroyed */ } }
    };
    teardowns.add(end);

    animationHooks.onStart(clone);
    apply();

    clone.ease({
      x: targetRect.x, y: targetRect.y,
      width: targetRect.width, height: targetRect.height,
      duration: ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => end(true),
    });
  }

  function moveResize(win, rect, { animate = true, reason = '', onComplete = null } = {}) {
    if (!win) return false;
    journal(`moveResize ${label(win)} -> ${rect.x},${rect.y} ${rect.width}x${rect.height} [${reason}]`);

    const apply = () => {
      if (win.get_maximized()) win.unmaximize(BOTH);
      win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    };

    if (!animate) {
      apply();
      onComplete?.();
      return true;
    }
    animateChange(win, rect, apply, { onComplete });
    return true;
  }

  function maximize(win, { animate = true, reason = '', onComplete = null } = {}) {
    if (!win || win.minimized || isMaximized(win) || !win.can_maximize())
      return false;
    journal(`maximize ${label(win)} animate=${animate} [${reason}]`);

    if (!animate) {
      win.maximize(BOTH);
      onComplete?.();
      return true;
    }
    const workArea = win.get_work_area_for_monitor(win.get_monitor());
    animateChange(win, workArea, () => win.maximize(BOTH), { suppressReshow: true, onComplete });
    return true;
  }

  function unmaximize(win, { reason = '' } = {}) {
    if (!win || !win.get_maximized()) return false;
    journal(`unmaximize ${label(win)} [${reason}]`);
    win.unmaximize(BOTH);
    return true;
  }

  function unminimize(win, { reason = '' } = {}) {
    if (!win || !win.minimized) return false;
    journal(`unminimize ${label(win)} [${reason}]`);
    win.unminimize();
    return true;
  }

  function activate(win, { reason = '' } = {}) {
    if (!win) return false;
    journal(`activate ${label(win)} [${reason}]`);
    win.get_workspace()?.activate_with_focus(win, global.get_current_time());
    return true;
  }

  function restore(win, { maximize: wantMax = false, focus = true, reason = '' } = {}) {
    if (!win) return false;
    unminimize(win, { reason });
    if (wantMax && !isMaximized(win) && win.can_maximize()) {
      journal(`maximize ${label(win)} [${reason}]`);
      win.maximize(BOTH);
    }
    if (focus) activate(win, { reason });
    return true;
  }

  return {
    abort, isBusy, hasAnimations,
    moveResize, maximize, unmaximize, unminimize, activate, restore,
  };
})();

// ===========================================================================
// TILES
// ===========================================================================
const tiles = (() => {
  const UNLINKED = { zone: undefined, match: null, fraction: undefined, suspended: null };

  let states = new WeakMap();
  let tracked = new WeakSet();
  let cleanupContext = null;

  function init() {
    states = new WeakMap();
    tracked = new WeakSet();
    cleanupContext = new GObject.Object();
  }

  function destroy() {
    cleanupContext?.run_dispose();
    cleanupContext = null;
    states = new WeakMap();
    tracked = new WeakSet();
  }

  function track(win) {
    if (!win || !cleanupContext || tracked.has(win)) return;
    tracked.add(win);
    win.connectObject('unmanaging', () => handleClosing(win), cleanupContext);
  }

  function get(win) {
    return states.get(win) ?? null;
  }

  function patch(win, fields) {
    const next = { ...(states.get(win) ?? {}), ...fields };
    states.set(win, next);
    return next;
  }

  function zoneOf(win) {
    return states.get(win)?.zone ?? null;
  }

  function activePartner(win) {
    return states.get(win)?.match ?? null;
  }

  function hasLink(win) {
    const s = states.get(win);
    return !!(s && (s.zone || s.match || s.suspended));
  }

  function release(win) {
    const s = states.get(win);
    if (!s) return null;
    const partner = s.match ?? s.suspended?.partner ?? null;
    if (partner) {
      const ps = states.get(partner);
      if (ps && (ps.match === win || ps.suspended?.partner === win))
        states.set(partner, { ...ps, ...UNLINKED });
    }
    states.set(win, { ...s, ...UNLINKED });
    return partner;
  }

  function tileSingle(win, zone, fraction) {
    release(win);
    patch(win, { zone, fraction, match: null, suspended: null });
    track(win);
  }

  function pairUp(left, right, fraction) {
    release(left);
    release(right);
    patch(left, { zone: 'left', fraction, match: right, suspended: null });
    patch(right, { zone: 'right', fraction, match: left, suspended: null });
    track(left);
    track(right);
  }

  function suspendPair(win) {
    const s = states.get(win);
    const partner = s?.match;
    if (!partner) return null;

    const ps = states.get(partner);
    const winZone = s.zone;
    const partnerZone = ps?.zone ?? oppositeZone(winZone);
    const fraction = s.fraction ?? 0.5;

    patch(win, { ...UNLINKED, suspended: { partner, zone: winZone, fraction } });
    patch(partner, { ...UNLINKED, suspended: { partner: win, zone: partnerZone, fraction } });
    return partner;
  }

  function suspendedLink(win) {
    const link = states.get(win)?.suspended;
    if (!link) return null;
    return states.get(link.partner)?.suspended?.partner === win ? link : null;
  }

  return {
    init, destroy, track, get, patch, zoneOf, activePartner, hasLink,
    tileSingle, pairUp, suspendPair, suspendedLink, release,
  };
})();

// ===========================================================================
// TILING ACTIONS
// ===========================================================================

// Left window's share of the work area, from the partner's real geometry.
function leftFractionOf(partner, workArea) {
  const r = partner.get_frame_rect();
  const f = tiles.zoneOf(partner) === 'left'
    ? r.width / workArea.width
    : (r.x - workArea.x) / workArea.width;
  return Math.min(0.9, Math.max(0.1, f));
}

function place(win, rect, reason) {
  if (!tiles.get(win)?.untiledRect && !isMaximized(win))
    tiles.patch(win, { untiledRect: win.get_frame_rect().copy() });

  if (!isMaximized(win) && win.get_frame_rect().equal(rect)) return;
  ops.moveResize(win, rect, { animate: true, reason });
}

// Tile two windows as a linked pair.
function layoutPair(left, right, fraction, reason = 'pair') {
  const workArea = workAreaOf(left);
  tiles.pairUp(left, right, fraction);
  place(left, getRectForZone('left', workArea, fraction), reason);
  place(right, getRectForZone('right', workArea, fraction), reason);
}

// Everything that happens when a drag is dropped in `zone`.
function snapWindow(window, zone) {
  const workArea = workAreaOf(window);

  if (zone === 'maximize') {
    tiles.release(window);
    ops.maximize(window, { reason: 'snap: top edge' });
    return;
  }

  if (zone !== 'left' && zone !== 'right') {
    tiles.release(window);
    ops.moveResize(window, getRectForZone(zone, workArea), { reason: `snap: ${zone}` });
    return;
  }

  // Look for a single-tiled window already on the opposite side.
  let partner = null;
  {
    const wantZone = oppositeZone(zone);
    const monitor = window.get_monitor();
    const actors = global.get_window_actors();
    for (let i = actors.length - 1; i >= 0; i--) {
      const other = actors[i].get_meta_window();
      if (!other || other === window || other.minimized) continue;
      if (tiles.zoneOf(other) !== wantZone || tiles.activePartner(other)) continue;
      if (other.get_monitor() !== monitor || !sameWorkspace(other, window)) continue;
      partner = other;
      break;
    }
  }

  let fraction = 0.5;
  if (partner) {
    fraction = leftFractionOf(partner, workArea);
  } else {
    // Otherwise, the only other untiled, tileable window on this monitor.
    const workspace = window.get_workspace();
    const monitorIndex = window.get_monitor();
    const candidates = [];
    for (const actor of global.get_window_actors()) {
      const other = actor.get_meta_window();
      if (!other || other === window || other.minimized) continue;
      if (tiles.zoneOf(other)) continue;
      if (!isTileable(other)) continue;
      if (other.get_workspace() !== workspace) continue;
      if (other.get_monitor() !== monitorIndex) continue;
      candidates.push(other);
    }
    if (candidates.length === 1) partner = candidates[0];
  }

  journal(`snap ${zone}, partner=${partner ? 'yes' : 'no'}`);

  if (partner) {
    const [left, right] = zone === 'left' ? [window, partner] : [partner, window];
    layoutPair(left, right, fraction, `snap: ${zone}`);
    return;
  }

  tiles.tileSingle(window, zone, fraction);
  ops.moveResize(window, getRectForZone(zone, workArea, fraction), { reason: `snap: ${zone}` });
}

// ===========================================================================
// TILE PREVIEW widget
// ===========================================================================
class TilePreview extends St.Widget {
  static { GObject.registerClass(this); }

  constructor() {
    super();
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
      opacity: 255, duration: ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  close() {
    if (!this._showing) return;
    this._showing = false;
    this.ease({
      opacity: 0, duration: ANIMATION_TIME,
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
}

// ===========================================================================
// DRAG: state at module scope, bracketed by initGrabs / destroyGrabs
// ===========================================================================
let preview = null;
let grabbedWindow = null;
let pendingZone = null;
let resizingWindow = null;
let pointerPollId = 0;
let dragContext = null;
let resizeContext = null;
let grabBeginId = 0;
let grabEndId = 0;
let dragStart = null;
let onGrabEndCallback = null;

function isDragging() {
  return !!grabbedWindow;
}

const animationHooks = {
  onStart(clone) {
    if (preview?.visible)
      global.window_group.set_child_above_sibling(preview, clone);
  },
  onEnd() {
    if (!grabbedWindow) preview?.close();
  },
};

function initGrabs({ onGrabEnd } = {}) {
  onGrabEndCallback = onGrabEnd ?? null;
  grabBeginId = Display.connect('grab-op-begin', onGrabOpBegin);
  grabEndId = Display.connect('grab-op-end', onGrabOpEnd);
}

function destroyGrabs() {
  if (grabBeginId) { Display.disconnect(grabBeginId); grabBeginId = 0; }
  if (grabEndId) { Display.disconnect(grabEndId); grabEndId = 0; }

  stopPointerPoll();

  if (grabbedWindow && dragContext)
    grabbedWindow.disconnectObject(dragContext);
  if (resizingWindow && resizeContext)
    resizingWindow.disconnectObject(resizeContext);

  grabbedWindow = null;
  dragContext = null;
  resizingWindow = null;
  resizeContext = null;
  dragStart = null;
  pendingZone = null;
  onGrabEndCallback = null;

  if (preview) { preview.destroy(); preview = null; }
}

function stopPointerPoll() {
  if (pointerPollId) {
    GLib.Source.remove(pointerPollId);
    pointerPollId = 0;
  }
}

function onGrabOpBegin(display, window, op) {
  if (!isTileable(window)) return;

  if (op === Meta.GrabOp.MOVING) {
    const [px, py] = global.get_pointer();

    grabbedWindow = window;
    pendingZone = null;
    dragStart = {
      x: px,
      y: py,
      restorePending: tiles.hasLink(window) || isMaximized(window),
    };

    if (!dragStart.restorePending)
      tiles.patch(window, { untiledRect: window.get_frame_rect().copy() });

    dragContext = new GObject.Object();
    window.connectObject('position-changed', onWindowPositionChanged, dragContext);

    // Mutter stops emitting 'position-changed' on the dragged window when the
    // grab began on a maximized window or crosses a workspace boundary.
    // Polling keeps preview, zone and threshold logic alive for the whole grab.
    if (!pointerPollId) {
      pointerPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, POINTER_POLL_MS, () => {
        if (!grabbedWindow || grabbedWindow !== window) {
          pointerPollId = 0;
          return GLib.SOURCE_REMOVE;
        }
        onWindowPositionChanged(window);
        return GLib.SOURCE_CONTINUE;
      });
    }
    return;
  }

  const tile = tiles.get(window);
  if (tile?.zone && tile?.match) {
    resizingWindow = window;
    resizeContext = new GObject.Object();
    window.connectObject('size-changed', onTiledWindowResized, resizeContext);
  }
}

function onTiledWindowResized(window) {
  const tile = tiles.get(window);
  const match = tile?.match;
  if (!match || !tiles.zoneOf(match)) return;

  const workArea = window.get_work_area_for_monitor(window.get_monitor());
  const rect = window.get_frame_rect();

  let hfraction = tile.zone === 'left'
    ? rect.width / workArea.width
    : 1 - (rect.width / workArea.width);
  hfraction = Math.min(0.9, Math.max(0.1, hfraction));

  tiles.patch(window, { fraction: hfraction });
  tiles.patch(match, { fraction: hfraction });

  const leftRect = getRectForZone('left', workArea, hfraction);
  const rightRect = getRectForZone('right', workArea, hfraction);
  const leftWin = tile.zone === 'left' ? window : match;
  const rightWin = leftWin === window ? match : window;

  if (rightWin !== window)
    ops.moveResize(rightWin, rightRect, { animate: false, reason: 'pair resize' });
  if (leftWin !== window)
    ops.moveResize(leftWin, leftRect, { animate: false, reason: 'pair resize' });
}

function onGrabOpEnd(display, window, op) {
  if (resizingWindow === window) {
    if (resizeContext) window.disconnectObject(resizeContext);
    resizeContext = null;
    resizingWindow = null;
    onGrabEndCallback?.();
    return;
  }

  if (window !== grabbedWindow) return;

  stopPointerPoll();
  if (dragContext) window.disconnectObject(dragContext);
  dragContext = null;
  grabbedWindow = null;

  const clickOnly = dragStart?.restorePending;
  dragStart = null;
  const zone = pendingZone;
  pendingZone = null;

  if (clickOnly) {
    preview?.close();
  } else if (!zone) {
    preview?.close();
    tiles.release(window);
  } else {
    snapWindow(window, zone);
    if (!ops.hasAnimations()) preview?.close();
  }

  onGrabEndCallback?.();
}

function onWindowPositionChanged(window) {
  const [px, py] = global.get_pointer();

  if (dragStart?.restorePending) {
    const dist = Math.hypot(px - dragStart.x, py - dragStart.y);
    if (dist < DRAG_THRESHOLD) return;
    dragStart.restorePending = false;

    // Restore: unmaximize + move to remembered natural size, forget pair.
    const tile = tiles.get(window);
    const maximized = isMaximized(window);
    if (tile?.zone || maximized) {
      if (maximized) ops.unmaximize(window, { reason: 'drag restore' });
      const untiled = tile?.untiledRect ?? window.get_frame_rect().copy();
      const cur = window.get_frame_rect();
      const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;
      ops.moveResize(window, {
        x: Math.round(px - fracX * untiled.width),
        y: Math.round(py - Math.min(20, untiled.height * 0.05)),
        width: untiled.width,
        height: untiled.height,
      }, { animate: false, reason: 'drag restore' });
    }
    tiles.release(window);
    tiles.patch(window, { untiledRect: window.get_frame_rect().copy() });
  }

  const monitorIndex = Display.get_monitor_index_for_rect(
    new Mtk.Rectangle({ x: px, y: py, width: 1, height: 1 }));
  if (monitorIndex < 0) return;
  const workArea = window.get_work_area_for_monitor(monitorIndex);

  // Zone classification.
  const nearCornerTop = py <= workArea.y + CORNER_ZONE;
  const nearCornerBottom = py >= workArea.y + workArea.height - CORNER_ZONE;
  const nearCornerLeft = px <= workArea.x + CORNER_ZONE;
  const nearCornerRight = px >= workArea.x + workArea.width - CORNER_ZONE;
  let zone = null;
  if (nearCornerTop && nearCornerLeft) zone = 'top-left';
  else if (nearCornerTop && nearCornerRight) zone = 'top-right';
  else if (nearCornerBottom && nearCornerLeft) zone = 'bottom-left';
  else if (nearCornerBottom && nearCornerRight) zone = 'bottom-right';
  else if (py <= workArea.y + EDGE_ZONE) zone = 'maximize';
  else if (px <= workArea.x + EDGE_ZONE) zone = 'left';
  else if (px >= workArea.x + workArea.width - EDGE_ZONE) zone = 'right';

  pendingZone = zone;
  if (zone) {
    if (!preview) preview = new TilePreview();
    preview.open(window, getRectForZone(zone, workArea), monitorIndex);
  } else {
    preview?.close();
  }
}

// ===========================================================================
// EVENTS
// ===========================================================================

// Set when a NORMAL window is closing; consumed by the next handleClosed so
// only real window closes may restore a lone minimized window.
let closeRestorePending = false;

// --- synchronous handlers ---

function handleClosing(win) {
  try {
    if (win.get_window_type() === Meta.WindowType.NORMAL)
      closeRestorePending = true;
  } catch (e) { /* window already gone */ }

  const partner = tiles.activePartner(win);
  tiles.release(win);
  if (partner) ops.restore(partner, { maximize: true, reason: 'pair partner closed' });
}

function handleMinimized(win) {
  if (!win) return;
  if (tiles.activePartner(win)) tiles.suspendPair(win);
}

// --- layout ---

let lastSoloWindow = null;

function reconcileLayout({ restoreMinimized = false } = {}) {
  const all = Display.list_all_windows().filter(win => {
    if (!win) return false;
    const type = win.get_window_type();
    if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG) return false;
    if (win.is_skip_taskbar()) return false;
    const winWorkspace = win.get_workspace();
    if (!winWorkspace) return false;
    if (!win.is_on_all_workspaces() && winWorkspace !== WorkspaceManager.get_active_workspace()) return false;
    return true;
  });

  if (all.length === 0) { lastSoloWindow = null; return; }

  if (all.length === 1) {
    const win = all[0];
    const isNewSoloState = lastSoloWindow !== win;
    lastSoloWindow = win;

    // Only a close action may bring back a lone minimized window.
    if (win.minimized && !restoreMinimized) return;

    ops.restore(win, {
      maximize: !isMaximized(win) && (isNewSoloState || restoreMinimized),
      focus: true,
      reason: 'solo window',
    });
    return;
  }

  lastSoloWindow = null;
}

// --- deferred handlers ---

function handleCreated(win) {
  // Auto-tile beside the lone single-tiled window on this monitor, if any.
  if (AUTO_TILE_NEW_WINDOWS &&
    win && win.get_compositor_private() && win.get_workspace() &&
    !win.minimized && isTileable(win) &&
    !win.get_transient_for() && !tiles.hasLink(win)) {
    const monitor = win.get_monitor();
    const anchors = Display.list_all_windows().filter(w =>
      w !== win &&
      !w.minimized &&
      w.get_monitor() === monitor &&
      sameWorkspace(w, win) &&
      (tiles.zoneOf(w) === 'left' || tiles.zoneOf(w) === 'right') &&
      !tiles.activePartner(w));

    if (anchors.length === 1) {
      journal('tiling new window beside single tiled window');
      const anchor = anchors[0];
      const workArea = workAreaOf(anchor);
      const fraction = leftFractionOf(anchor, workArea);
      const [left, right] = tiles.zoneOf(anchor) === 'left' ? [anchor, win] : [win, anchor];
      layoutPair(left, right, fraction, 'new window beside tiled window');
      return;
    }
  }

  reconcileLayout();
}

function handleUnminimized(win) {
  if (win) {
    const link = tiles.suspendedLink(win);
    if (link) {
      const { partner, zone, fraction } = link;
      const ready =
        partner.get_compositor_private() &&
        !partner.minimized && !win.minimized &&
        partner.get_workspace() === win.get_workspace() &&
        partner.get_monitor() === win.get_monitor();

      if (ready) {
        journal('rejoining old pair');
        const [left, right] = zone === 'left' ? [win, partner] : [partner, win];
        layoutPair(left, right, fraction, 'rejoin old pair');
        ops.activate(win, { reason: 'rejoin old pair' });
        return;
      }
    }
  }
  reconcileLayout();
}

function handleClosed() {
  const restoreMinimized = closeRestorePending;
  closeRestorePending = false;
  reconcileLayout({ restoreMinimized });
}

function handleWorkspaceChanged() {
  reconcileLayout({ restoreMinimized: true });
}

// --- queue ---

let queue = [];
let idleId = 0;

function defer(handler, window = null) {
  if (!window && queue.some(e => e.handler === handler && !e.window)) return;
  queue.push({ handler, window });
  requestFlush();
}

function requestFlush() {
  if (idleId || queue.length === 0) return;
  idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    idleId = 0;
    if (isDragging()) return GLib.SOURCE_REMOVE;
    const batch = queue;
    queue = [];
    for (const { handler, window } of batch) handler(window);
    return GLib.SOURCE_REMOVE;
  });
}

function clearEvents() {
  if (idleId) GLib.Source.remove(idleId);
  idleId = 0;
  queue = [];
}

// ===========================================================================
// EXTENSION
// ===========================================================================
export default class JsTilingExtension extends Extension {
  enable() {
    initLogging(this.uuid, { output: 'both', level: 'debug', enabled: false });
    journal('Enable');

    this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    this._mutterSettings.set_boolean('edge-tiling', false);

    tiles.init();
    initGrabs({ onGrabEnd: requestFlush });

    const existing = Display.list_all_windows();
    const seen = new WeakSet(existing);

    // Hook 'unmanaging' on every window so handleClosing sees all closes,
    // not just those of tiled windows.
    for (const win of existing) tiles.track(win);

    this._onWorkspaceChanged = WorkspaceManager.connect('active-workspace-changed',
      () => defer(handleWorkspaceChanged));

    this._onMap = WindowManager.connect('map', (wm, actor) => {
      const win = actor.get_meta_window();
      if (!win || seen.has(win)) return;
      seen.add(win);
      tiles.track(win);
      defer(handleCreated, win);
    });

    this._onDestroy = WindowManager.connect('destroy',
      () => defer(handleClosed));

    this._onMinimize = WindowManager.connect('minimize', (wm, actor) =>
      handleMinimized(actor.get_meta_window()));

    this._onUnminimize = WindowManager.connect('unminimize', (wm, actor) =>
      defer(handleUnminimized, actor.get_meta_window()));
  }

  disable() {
    if (this._onWorkspaceChanged) { WorkspaceManager.disconnect(this._onWorkspaceChanged); this._onWorkspaceChanged = 0; }
    if (this._onMap) { WindowManager.disconnect(this._onMap); this._onMap = 0; }
    if (this._onDestroy) { WindowManager.disconnect(this._onDestroy); this._onDestroy = 0; }
    if (this._onMinimize) { WindowManager.disconnect(this._onMinimize); this._onMinimize = 0; }
    if (this._onUnminimize) { WindowManager.disconnect(this._onUnminimize); this._onUnminimize = 0; }

    clearEvents();
    ops.abort();
    destroyGrabs();
    lastSoloWindow = null;
    closeRestorePending = false;
    tiles.destroy();

    if (this._mutterSettings) {
      this._mutterSettings.set_boolean('edge-tiling', true);
      this._mutterSettings = null;
    }

    flushBuffer();
    stopLogging();
  }
}