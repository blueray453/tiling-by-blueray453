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
// Pointer must move this many pixels before a grab counts as a drag.
const DRAG_THRESHOLD = 8;
// Flip to false to turn "new window tiles beside a tiled window" off.
const AUTO_TILE_NEW_WINDOWS = true;

// ===========================================================================
// GEOMETRY: pure helpers, predicates, queries
// ===========================================================================
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

function monitorForPoint(x, y) {
  return Display.get_monitor_index_for_rect(new Mtk.Rectangle({ x, y, width: 1, height: 1 }));
}

function workAreaOf(win) {
  return win.get_work_area_for_monitor(win.get_monitor());
}

function sameWorkspace(a, b) {
  return a.get_workspace() === b.get_workspace() ||
    a.is_on_all_workspaces() || b.is_on_all_workspaces();
}

function windowExistsOnCurrentWorkspace(win) {
  if (!win) return false;
  const type = win.get_window_type();
  if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG) return false;
  if (win.is_skip_taskbar()) return false;
  const winWorkspace = win.get_workspace();
  if (!winWorkspace) return false;
  if (!win.is_on_all_workspaces() && winWorkspace !== WorkspaceManager.get_active_workspace())
    return false;
  return true;
}

function windowsOnCurrentWorkspace() {
  return Display.list_all_windows().filter(windowExistsOnCurrentWorkspace);
}

// ===========================================================================
// OPS: the ONLY place that changes window geometry, maximize state, minimize
// state or focus. It decides nothing: it guards, logs, optionally animates,
// and does exactly what it is told.
// ===========================================================================
const ops = (() => {
  const BOTH = Meta.MaximizeFlags.BOTH;

  let hooks = {};
  const teardowns = new Set();
  const busy = new Map();

  // hooks: { onStart(clone), onEnd() }
  function init(h = {}) {
    hooks = h;
  }

  function teardown() {
    for (const t of [...teardowns]) t(false);
    teardowns.clear();
    busy.clear();
    hooks = {};
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

  // Snapshot the window, hide the real actor, apply the change underneath,
  // ease the snapshot to the target rect, then reveal the real actor.
  function animateChange(win, targetRect, apply, { suppressReshow = false, onComplete = null } = {}) {
    const actor = win.get_compositor_private();

    const finish = () => {
      if (actor) { try { actor.show(); } catch (e) { /* destroyed */ } }
      hooks.onEnd?.();
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

    hooks.onStart?.(clone);
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
      // Moving to an explicit rect always leaves the maximized state.
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
    // suppressReshow: mutter re-shows a maximizing actor mid-frame.
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

  // Compound call: the order unminimize -> maximize -> activate matters.
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
    init, teardown, isBusy, hasAnimations,
    moveResize, maximize, unmaximize, unminimize, activate, restore,
  };
})();

// ===========================================================================
// TILE STATE: per-window tiling memory. ops never touches it.
//
// state = {
//   zone, fraction, match,   active link: tiled, `match` is the partner
//   suspended,               dormant link { partner, zone, fraction }, used
//                            when one half of a pair is minimized
//   untiledRect,             natural size to restore on drag
// }
// `fraction` is always the LEFT window's share of the work-area width.
// ===========================================================================
const TS = (() => {
  const UNLINKED = { zone: undefined, match: null, fraction: undefined, suspended: null };

  let states = new WeakMap();
  let tracked = new WeakSet();
  let cleanupContext = null;
  let onClosing = null;

  function init(closingHandler) {
    states = new WeakMap();
    tracked = new WeakSet();
    cleanupContext = new GObject.Object();
    onClosing = closingHandler;
  }

  function destroy() {
    // Disposing the context disconnects every 'unmanaging' handler.
    cleanupContext?.run_dispose();
    cleanupContext = null;
    onClosing = null;
    states = new WeakMap();
    tracked = new WeakSet();
  }

  function track(win) {
    if (!cleanupContext || tracked.has(win)) return;
    tracked.add(win);
    win.connectObject('unmanaging', () => onClosing?.(win), cleanupContext);
  }

  function get(win) {
    return states.get(win) ?? null;
  }

  function patch(win, p) {
    const next = { ...(states.get(win) ?? {}), ...p };
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

  // Forget every link of `win` (active or dormant) on both sides.
  // untiledRect is kept. Returns the former partner.
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

  // One half was minimized. Turn the active link into a dormant one on BOTH
  // windows, so the minimized window can rejoin when it comes back.
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

  // The dormant link for `win`, only if the partner still points back at it.
  function suspendedLink(win) {
    const link = states.get(win)?.suspended;
    if (!link) return null;
    return states.get(link.partner)?.suspended?.partner === win ? link : null;
  }

  return {
    init, destroy, get, patch, zoneOf, activePartner, hasLink,
    tileSingle, pairUp, suspendPair, suspendedLink, release,
  };
})();

// ===========================================================================
// TILING ACTIONS: decide *where* windows go, record it in TS; ops moves them
// ===========================================================================

// A window already tiled to `wantZone` that has no partner yet.
function findOppositeSingle(window, wantZone) {
  const monitor = window.get_monitor();
  const actors = global.get_window_actors();
  for (let i = actors.length - 1; i >= 0; i--) {
    const other = actors[i].get_meta_window();
    if (!other || other === window || other.minimized) continue;
    if (TS.zoneOf(other) !== wantZone || TS.activePartner(other)) continue;
    if (other.get_monitor() !== monitor || !sameWorkspace(other, window)) continue;
    return other;
  }
  return null;
}

// The only other untiled, tileable window on this monitor, if exactly one.
function findAutoTilePartner(window, monitorIndex) {
  const workspace = window.get_workspace();
  const candidates = [];
  for (const actor of global.get_window_actors()) {
    const other = actor.get_meta_window();
    if (!other || other === window || other.minimized) continue;
    if (TS.zoneOf(other)) continue;
    if (!isTileable(other)) continue;
    if (other.get_workspace() !== workspace) continue;
    if (other.get_monitor() !== monitorIndex) continue;
    candidates.push(other);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// Left window's share of the work area, from the partner's real geometry.
function leftFractionOf(partner, workArea) {
  const r = partner.get_frame_rect();
  const f = TS.zoneOf(partner) === 'left'
    ? r.width / workArea.width
    : (r.x - workArea.x) / workArea.width;
  return Math.min(0.9, Math.max(0.1, f));
}

function place(win, rect, reason) {
  // Remember a natural size the first time we take over a window.
  if (!TS.get(win)?.untiledRect && !isMaximized(win))
    TS.patch(win, { untiledRect: win.get_frame_rect().copy() });

  if (!isMaximized(win) && win.get_frame_rect().equal(rect)) return;
  ops.moveResize(win, rect, { animate: true, reason });
}

// Tile two windows as a linked pair.
function layoutPair(left, right, fraction, reason = 'pair') {
  const workArea = workAreaOf(left);
  TS.pairUp(left, right, fraction);
  place(left, getRectForZone('left', workArea, fraction), reason);
  place(right, getRectForZone('right', workArea, fraction), reason);
}

// Put `win` on the side opposite to `anchor`, a single tiled window.
function tileOpposite(win, anchor) {
  const workArea = workAreaOf(anchor);
  const fraction = leftFractionOf(anchor, workArea);
  const [left, right] = TS.zoneOf(anchor) === 'left' ? [anchor, win] : [win, anchor];
  layoutPair(left, right, fraction, 'new window beside tiled window');
}

// Everything that happens when a drag is dropped in `zone`.
function snapWindow(window, zone) {
  const workArea = workAreaOf(window);

  if (zone === 'maximize') {
    TS.release(window);
    ops.maximize(window, { reason: 'snap: top edge' });
    return;
  }

  if (zone !== 'left' && zone !== 'right') {
    TS.release(window);
    ops.moveResize(window, getRectForZone(zone, workArea), { reason: `snap: ${zone}` });
    return;
  }

  let partner = findOppositeSingle(window, oppositeZone(zone));
  let fraction = 0.5;
  if (partner)
    fraction = leftFractionOf(partner, workArea);
  else
    partner = findAutoTilePartner(window, window.get_monitor());

  journal(`snap ${zone}, partner=${partner ? 'yes' : 'no'}`);

  if (partner) {
    const [left, right] = zone === 'left' ? [window, partner] : [partner, window];
    layoutPair(left, right, fraction, `snap: ${zone}`);
    return;
  }

  TS.tileSingle(window, zone, fraction);
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
// DRAG: grabs, pointer poll, drag threshold, restore on drag, pair resize
// ===========================================================================
const drag = (() => {
  const state = {
    preview: null,
    grabbedWindow: null,
    pendingZone: null,
    resizingWindow: null,
    pointerPollId: 0,
    dragContext: null,
    resizeContext: null,
    grabBeginId: 0,
    grabEndId: 0,
    dragStart: null, // { x, y, restorePending }
    onEnd: null,
  };

  function isDragging() {
    return !!state.grabbedWindow;
  }

  // Wired into ops.init(): keeps the preview above the clone and closes it
  // when an animation finishes.
  const animationHooks = {
    onStart(clone) {
      if (state.preview?.visible)
        global.window_group.set_child_above_sibling(state.preview, clone);
    },
    onEnd() {
      if (!state.grabbedWindow) state.preview?.close();
    },
  };

  function enable({ onEnd } = {}) {
    state.onEnd = onEnd ?? null;
    state.grabBeginId = Display.connect('grab-op-begin', onGrabOpBegin);
    state.grabEndId = Display.connect('grab-op-end', onGrabOpEnd);
  }

  function disable() {
    if (state.grabBeginId) { Display.disconnect(state.grabBeginId); state.grabBeginId = 0; }
    if (state.grabEndId) { Display.disconnect(state.grabEndId); state.grabEndId = 0; }

    stopPointerPoll();

    if (state.grabbedWindow && state.dragContext)
      state.grabbedWindow.disconnectObject(state.dragContext);
    if (state.resizingWindow && state.resizeContext)
      state.resizingWindow.disconnectObject(state.resizeContext);

    state.grabbedWindow = null;
    state.dragContext = null;
    state.resizingWindow = null;
    state.resizeContext = null;
    state.dragStart = null;
    state.pendingZone = null;
    state.onEnd = null;

    if (state.preview) { state.preview.destroy(); state.preview = null; }
  }

  // Mutter stops emitting 'position-changed' on the dragged window when the
  // grab began on a maximized window or crosses a workspace boundary. Polling
  // keeps the preview, zone and threshold logic alive for the whole grab.
  function startPointerPoll(window) {
    if (state.pointerPollId) return;
    state.pointerPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, POINTER_POLL_MS, () => {
      if (!state.grabbedWindow || state.grabbedWindow !== window) {
        state.pointerPollId = 0;
        return GLib.SOURCE_REMOVE;
      }
      onWindowPositionChanged(window);
      return GLib.SOURCE_CONTINUE;
    });
  }

  function stopPointerPoll() {
    if (state.pointerPollId) {
      GLib.Source.remove(state.pointerPollId);
      state.pointerPollId = 0;
    }
  }

  // Runs only once the pointer passes DRAG_THRESHOLD: a plain click on a
  // title bar must not unmaximize or untile anything.
  function restoreForDrag(window) {
    const ts = TS.get(window);
    const maximized = isMaximized(window);

    if (ts?.zone || maximized) {
      // Unmaximize first so the restore size is the natural size.
      if (maximized) ops.unmaximize(window, { reason: 'drag restore' });

      const untiled = ts?.untiledRect ?? window.get_frame_rect().copy();
      const cur = window.get_frame_rect();
      const [px, py] = global.get_pointer();
      const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;

      ops.moveResize(window, {
        x: Math.round(px - fracX * untiled.width),
        y: Math.round(py - Math.min(20, untiled.height * 0.05)),
        width: untiled.width,
        height: untiled.height,
      }, { animate: false, reason: 'drag restore' });
    }

    // Dragging a window away forgets its pair, active or dormant.
    TS.release(window);
    TS.patch(window, { untiledRect: window.get_frame_rect().copy() });
  }

  function onGrabOpBegin(display, window, op) {
    if (!isTileable(window)) return;

    if (op === Meta.GrabOp.MOVING) {
      const [px, py] = global.get_pointer();

      state.grabbedWindow = window;
      state.pendingZone = null;
      state.dragStart = {
        x: px,
        y: py,
        restorePending: TS.hasLink(window) || isMaximized(window),
      };

      if (!state.dragStart.restorePending)
        TS.patch(window, { untiledRect: window.get_frame_rect().copy() });

      state.dragContext = new GObject.Object();
      window.connectObject('position-changed', onWindowPositionChanged, state.dragContext);
      startPointerPoll(window);
      return;
    }

    const ts = TS.get(window);
    if (ts?.zone && ts?.match) {
      state.resizingWindow = window;
      state.resizeContext = new GObject.Object();
      window.connectObject('size-changed', onTiledWindowResized, state.resizeContext);
    }
  }

  function onTiledWindowResized(window) {
    const ts = TS.get(window);
    const match = ts?.match;
    if (!match || !TS.zoneOf(match)) return;

    const workArea = window.get_work_area_for_monitor(window.get_monitor());
    const rect = window.get_frame_rect();

    let hfraction = ts.zone === 'left'
      ? rect.width / workArea.width
      : 1 - (rect.width / workArea.width);
    hfraction = Math.min(0.9, Math.max(0.1, hfraction));

    TS.patch(window, { fraction: hfraction });
    TS.patch(match, { fraction: hfraction });

    const leftRect = getRectForZone('left', workArea, hfraction);
    const rightRect = getRectForZone('right', workArea, hfraction);
    const leftWin = ts.zone === 'left' ? window : match;
    const rightWin = leftWin === window ? match : window;

    if (rightWin !== window)
      ops.moveResize(rightWin, rightRect, { animate: false, reason: 'pair resize' });
    if (leftWin !== window)
      ops.moveResize(leftWin, leftRect, { animate: false, reason: 'pair resize' });
  }

  function onGrabOpEnd(display, window, op) {
    if (state.resizingWindow === window) {
      if (state.resizeContext) window.disconnectObject(state.resizeContext);
      state.resizeContext = null;
      state.resizingWindow = null;
      state.onEnd?.();
      return;
    }

    if (window !== state.grabbedWindow) return;

    stopPointerPoll();
    if (state.dragContext) window.disconnectObject(state.dragContext);
    state.dragContext = null;
    state.grabbedWindow = null;

    const clickOnly = state.dragStart?.restorePending;
    state.dragStart = null;
    const zone = state.pendingZone;
    state.pendingZone = null;

    if (clickOnly) {
      // Pointer never passed the threshold: a click. Leave everything alone.
      state.preview?.close();
    } else if (!zone) {
      state.preview?.close();
      TS.release(window);
    } else {
      // The preview stays open: the animation's onEnd hook closes it.
      snapWindow(window, zone);
      if (!ops.hasAnimations()) state.preview?.close();
    }

    // Let deferred handlers (auto-tile, layout, ...) run now the drag is over.
    state.onEnd?.();
  }

  function onWindowPositionChanged(window) {
    const [px, py] = global.get_pointer();

    if (state.dragStart?.restorePending) {
      const dist = Math.hypot(px - state.dragStart.x, py - state.dragStart.y);
      if (dist < DRAG_THRESHOLD) return;
      state.dragStart.restorePending = false;
      restoreForDrag(window);
    }

    const monitorIndex = monitorForPoint(px, py);
    if (monitorIndex < 0) return;
    const workArea = window.get_work_area_for_monitor(monitorIndex);
    const zone = getTileZone(px, py, workArea);

    state.pendingZone = zone;
    if (zone) {
      if (!state.preview) state.preview = new TilePreview();
      state.preview.open(window, getRectForZone(zone, workArea), monitorIndex);
    } else {
      state.preview?.close();
    }
  }

  return { isDragging, animationHooks, enable, disable };
})();

// ===========================================================================
// EVENTS
//
// `closing` and `minimized` run synchronously — tiling state must be
// consistent before anything deferred reads it. Everything else is queued
// and flushed in an idle callback, held back during a drag.
// ===========================================================================

// --- synchronous handlers (called directly at the signal site) ---

function handleClosing(win) {
  const partner = TS.activePartner(win);
  TS.release(win);
  if (partner) ops.maximize(partner, { reason: 'pair partner closed' });
}

function handleMinimized(win) {
  if (!win) return;
  // Link goes dormant so the pair can rejoin on unminimize.
  // The survivor keeps its half; the workspace is allowed to go empty.
  if (TS.activePartner(win)) TS.suspendPair(win);
}

// --- layout helpers used by deferred handlers ---

function rejoinPair(win) {
  if (!win) return false;
  const link = TS.suspendedLink(win);
  if (!link) return false;

  const { partner, zone, fraction } = link;
  const ready =
    partner.get_compositor_private() &&
    !partner.minimized && !win.minimized &&
    partner.get_workspace() === win.get_workspace() &&
    partner.get_monitor() === win.get_monitor();

  // Partner is minimized too: keep the link, the partner may rejoin later.
  if (!ready) return false;

  journal('rejoining old pair');
  const [left, right] = zone === 'left' ? [win, partner] : [partner, win];
  layoutPair(left, right, fraction, 'rejoin old pair');
  ops.activate(win, { reason: 'rejoin old pair' });
  return true;
}

function singleTiledWindows(win) {
  const monitor = win.get_monitor();
  return Display.list_all_windows().filter(w =>
    w !== win &&
    !w.minimized &&
    w.get_monitor() === monitor &&
    sameWorkspace(w, win) &&
    (TS.zoneOf(w) === 'left' || TS.zoneOf(w) === 'right') &&
    !TS.activePartner(w));
}

function tileBesideSingle(win) {
  if (!AUTO_TILE_NEW_WINDOWS) return false;
  if (!win || !win.get_compositor_private() || !win.get_workspace()) return false;
  if (win.minimized || !isTileable(win)) return false;
  if (win.get_transient_for()) return false; // dialogs of other windows
  if (TS.hasLink(win)) return false;

  // Exactly one candidate, so it is unambiguous which side is free.
  const anchors = singleTiledWindows(win);
  if (anchors.length !== 1) return false;

  journal('tiling new window beside single tiled window');
  tileOpposite(win, anchors[0]);
  return true;
}

// ---------------------------------------------------------------------------
// LAYOUT: a lone window fills the work area. The workspace is allowed to sit
// empty: minimizing every window leaves it empty. This never picks the focus
// target for dimming; the focus extension does.
// ---------------------------------------------------------------------------
let lastSoloWindow = null;

function resetLayout() {
  lastSoloWindow = null;
}

function reconcileLayout() {
  const all = windowsOnCurrentWorkspace();
  if (all.length === 0) {
    lastSoloWindow = null;
    return;
  }

  if (all.length === 1) {
    const win = all[0];
    const isNewSoloState = lastSoloWindow !== win;
    lastSoloWindow = win;
    if (win.minimized) return;
    ops.restore(win, {
      maximize: isNewSoloState && !isMaximized(win),
      focus: true,
      reason: 'solo window',
    });
    return;
  }

  lastSoloWindow = null;
}

// --- deferred handlers ---

function handleCreated(win) {
  if (tileBesideSingle(win)) return;
  reconcileLayout();
}

function handleUnminimized(win) {
  if (rejoinPair(win)) return;
  reconcileLayout();
}

function handleClosed() {
  reconcileLayout();
}

function handleWorkspaceChanged() {
  reconcileLayout();
}

// --- queue ---

let queue = [];
let idleId = 0;

// Queue `handler` to run on the next idle. Repeated window-less calls with
// the same handler collapse to one.
function defer(handler, window = null) {
  if (!window && queue.some(e => e.handler === handler && !e.window)) return;
  queue.push({ handler, window });
  requestFlush();
}

function requestFlush() {
  if (idleId || queue.length === 0) return;
  idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    idleId = 0;
    // Held back during a drag; drag's onEnd calls requestFlush() again.
    if (drag.isDragging()) return GLib.SOURCE_REMOVE;
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
// EXTENSION: lifecycle and signal wiring only
// ===========================================================================
export default class JsTilingExtension extends Extension {
  enable() {
    initLogging(this.uuid, { output: 'both', level: 'debug', enabled: false });
    journal('Enable');

    this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    this._mutterSettings.set_boolean('edge-tiling', false);

    TS.init(handleClosing);
    ops.init(drag.animationHooks);
    drag.enable({ onEnd: requestFlush });

    // Only the first 'map' of a window counts as "created".
    const seen = new WeakSet(Display.list_all_windows());

    this._onWorkspaceChanged = WorkspaceManager.connect('active-workspace-changed',
      () => defer(handleWorkspaceChanged));

    this._onMap = WindowManager.connect('map', (wm, actor) => {
      const win = actor.get_meta_window();
      if (!win || seen.has(win)) return;
      seen.add(win);
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
    if (this._onWorkspaceChanged) {
      WorkspaceManager.disconnect(this._onWorkspaceChanged);
      this._onWorkspaceChanged = 0;
    }
    if (this._onMap) {
      WindowManager.disconnect(this._onMap);
      this._onMap = 0;
    }
    if (this._onDestroy) {
      WindowManager.disconnect(this._onDestroy);
      this._onDestroy = 0;
    }
    if (this._onMinimize) {
      WindowManager.disconnect(this._onMinimize);
      this._onMinimize = 0;
    }
    if (this._onUnminimize) {
      WindowManager.disconnect(this._onUnminimize);
      this._onUnminimize = 0;
    }

    clearEvents();
    drag.disable();
    ops.teardown();
    resetLayout();
    TS.destroy();

    if (this._mutterSettings) {
      this._mutterSettings.set_boolean('edge-tiling', true);
      this._mutterSettings = null;
    }

    flushBuffer();
    stopLogging();
  }
}