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

// to enable animation
// gsettings set org.gnome.desktop.interface enable-animations true
const WINDOW_ANIMATION_TIME = 250;
const EDGE_ZONE = 25;
const CORNER_ZONE = 100;
const TILE_MATCH_THRESHOLD = 8;
const POINTER_POLL_MS = 15;
// Pointer must move this many pixels before a grab counts as a drag.
const DRAG_THRESHOLD = 8;

const Display = global.get_display();
const WindowManager = global.get_window_manager();
const WorkspaceManager = global.get_workspace_manager();

// ---------------------------------------------------------------------------
// Module state.
//
// Everything the extension tracks at runtime lives here, not on the Extension
// instance. enable() resets it; disable() tears it down.
// ---------------------------------------------------------------------------
const state = {
  mutterSettings: null,
  tilePreview: null,
  grabbedWindow: null,
  pendingZone: null,
  resizingWindow: null,
  pointerPollId: 0,
  dragContext: null,
  resizeContext: null,
  cleanupContext: null,
  grabBeginId: 0,
  grabEndId: 0,
  tileStates: new WeakMap(),
  cleanupTracked: new WeakSet(),
  // { x, y, restorePending } recorded at grab start.
  dragStart: null,
  // Teardown functions for snap animations currently in flight.
  activeAnimations: new Set(),

  // LAYOUT: layout-policy state.
  connections: [],
  lastSoloWindow: null,
  layoutPending: null,
  layoutFlushId: 0,

  // AUTOTILE: pending idle sources for newly created windows.
  autoTileIds: new Set(),
};

function resetState() {
  state.mutterSettings = null;
  state.tilePreview = null;
  state.grabbedWindow = null;
  state.pendingZone = null;
  state.resizingWindow = null;
  state.pointerPollId = 0;
  state.dragContext = null;
  state.resizeContext = null;
  state.cleanupContext = new GObject.Object();
  state.grabBeginId = 0;
  state.grabEndId = 0;
  state.tileStates = new WeakMap();
  state.cleanupTracked = new WeakSet();
  state.dragStart = null;
  state.activeAnimations = new Set();

  state.connections = [];
  state.lastSoloWindow = null;
  state.layoutPending = null;
  state.layoutFlushId = 0;

  // AUTOTILE
  state.autoTileIds = new Set();
}

// ---------------------------------------------------------------------------
// TilePreview — the one widget we need. Kept as a class because St.Widget
// subclasses must be registered with GObject and constructed with `new`.
// ---------------------------------------------------------------------------
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
}

// ---------------------------------------------------------------------------
// Tile zone / rect helpers. Pure functions of their arguments.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Per-window tile state.
// ---------------------------------------------------------------------------
function getTileState(window) {
  return state.tileStates.get(window) ?? null;
}

function setTileState(window, patch) {
  const existing = state.tileStates.get(window) ?? {};
  const next = { ...existing, ...patch };
  state.tileStates.set(window, next);
  return next;
}

function clearTileState(window) {
  if (!state.tileStates) return;
  const s = state.tileStates.get(window);
  if (s?.match) {
    const matchState = state.tileStates.get(s.match);
    if (matchState)
      state.tileStates.set(s.match, { ...matchState, match: null, zone: undefined, fraction: undefined });
  }
  state.tileStates.delete(window);
}

// Dissolve a tiled pair without deleting either window's untiledRect, so
// a later drag still restores the natural size. Returns the former partner,
// or null if the window had none.
function releasePair(window) {
  const partner = getTileState(window)?.match ?? null;
  if (!partner) return null;
  const cleared = { zone: undefined, match: null, fraction: undefined };
  setTileState(window, cleared);
  setTileState(partner, cleared);
  return partner;
}

function trackForCleanup(window) {
  if (!state.cleanupContext) return;
  if (state.cleanupTracked.has(window))
    return;
  state.cleanupTracked.add(window);
  window.connectObject('unmanaging', () => onWindowUnmanaging(window), state.cleanupContext);
}

// ---------------------------------------------------------------------------
// Pointer poll.
//
// Polls the pointer while a MOVING grab is active. Needed because Mutter
// suppresses 'position-changed' on the dragged window in two cases:
//
//   1. the window was maximized when the grab began — Mutter runs its own
//      auto-unmaximize-and-follow path, which does not emit 'position-changed';
//   2. the window is dragged across a workspace boundary — Mutter's
//      cross-workspace drag path also stops emitting the signal.
//
// In both cases the signal goes quiet for the rest of the drag, so
// onWindowPositionChanged would otherwise stop running, pendingZone would
// freeze, the tile preview would stop tracking, and edge/corner tiling would
// silently do nothing when the user releases. The poll keeps the handler alive
// for the whole grab. It also drives the drag-threshold check.
//
// The timer stops itself if the grabbed window changes, and is also stopped
// explicitly on grab-op-end and in disable().
// ---------------------------------------------------------------------------
function startPointerPoll(window) {
  if (state.pointerPollId) return;
  state.pointerPollId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT_IDLE,
    POINTER_POLL_MS,
    () => {
      if (!state.grabbedWindow || state.grabbedWindow !== window) {
        state.pointerPollId = 0;
        return GLib.SOURCE_REMOVE;
      }
      onWindowPositionChanged(window);
      return GLib.SOURCE_CONTINUE;
    },
  );
}

function stopPointerPoll() {
  if (state.pointerPollId) {
    GLib.Source.remove(state.pointerPollId);
    state.pointerPollId = 0;
  }
}

// ---------------------------------------------------------------------------
// Clone-based snap animation.
//
// Take a static snapshot of the window before the geometry change, hide the
// real window actor, put the snapshot on top, apply the geometry change
// (window actor is invisible so its jump doesn't matter), ease the snapshot
// from old to new rect, then destroy the snapshot and show the real window
// actor again — which is by then already at its final rect.
//
// The tile preview is placed *above* the clone so it remains fully visible
// for the whole animation and fades out only at the end.
//
// applyAction is the geometry change to run once the clone is in place (a
// resize/move, or a maximize). Pass suppressReshow for actions (like maximize)
// where mutter's compositor sync re-shows the real actor mid-frame —
// move_resize_frame doesn't need this guard.
//
// Each in-flight animation registers a teardown function in
// state.activeAnimations so disable() can destroy the clone and re-show the
// real actor. A `done` guard makes teardown idempotent, because destroying the
// clone mid-ease can still fire onComplete.
// ---------------------------------------------------------------------------
function playCloneAnimation(metaWindow, targetRect, applyAction, { suppressReshow = false, onComplete = null } = {}) {
  const actor = metaWindow.get_compositor_private();

  const finish = () => {
    if (actor) actor.show();
    if (state.tilePreview) state.tilePreview.close();
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

  const showId = suppressReshow ? actor.connect('show', () => actor.hide()) : null;

  let done = false;
  const teardown = (runFinish) => {
    if (done) return;
    done = true;
    state.activeAnimations.delete(teardown);
    try {
      if (showId) actor.disconnect(showId);
    } catch (e) { /* actor already destroyed */ }
    clone.destroy();
    if (runFinish) {
      finish();
    } else {
      try { actor.show(); } catch (e) { /* actor already destroyed */ }
    }
  };
  state.activeAnimations.add(teardown);

  if (state.tilePreview && state.tilePreview.visible)
    global.window_group.set_child_above_sibling(state.tilePreview, clone);

  applyAction();

  clone.ease({
    x: targetRect.x, y: targetRect.y,
    width: targetRect.width, height: targetRect.height,
    duration: WINDOW_ANIMATION_TIME,
    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    onComplete: () => teardown(true),
  });
}

function animateWindowTo(metaWindow, x, y, width, height, onComplete = null) {
  playCloneAnimation(
    metaWindow,
    { x, y, width, height },
    () => metaWindow.move_resize_frame(true, x, y, width, height),
    { onComplete });
}

// ---------------------------------------------------------------------------
// Window predicates and lookup helpers.
// ---------------------------------------------------------------------------
function isTileable(window) {
  if (!window) return false;
  if (window.get_window_type() !== Meta.WindowType.NORMAL) return false;
  if (window.is_override_redirect()) return false;
  const maxState = window.get_maximized();
  if (maxState & Meta.MaximizeFlags.BOTH)
    return true;
  if (!window.allows_resize() || !window.allows_move()) return false;
  return true;
}

function isMaximized(window) {
  return (window.get_maximized() & Meta.MaximizeFlags.BOTH) === Meta.MaximizeFlags.BOTH;
}

function monitorForPoint(x, y) {
  return Display.get_monitor_index_for_rect(new Mtk.Rectangle({ x, y, width: 1, height: 1 }));
}

function findTileMatch(window) {
  const zone = getTileState(window)?.zone;
  if (zone !== 'left' && zone !== 'right') return null;
  const wantZone = zone === 'left' ? 'right' : 'left';
  const rect = window.get_frame_rect();
  const monitor = window.get_monitor();
  const workspace = window.get_workspace();

  const actors = global.get_window_actors();
  for (let i = actors.length - 1; i >= 0; i--) {
    const other = actors[i].get_meta_window();
    if (other === window || !other || other.minimized) continue;
    if (getTileState(other)?.zone !== wantZone) continue;
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

function findAutoTilePartner(window, monitorIndex) {
  const workspace = window.get_workspace();
  const actors = global.get_window_actors();
  const candidates = [];

  for (let i = actors.length - 1; i >= 0; i--) {
    const other = actors[i].get_meta_window();
    if (other === window || !other) continue;
    if (other.minimized) continue;
    if (getTileState(other)?.zone) continue;
    if (!isTileable(other)) continue;
    if (other.get_workspace() !== workspace) continue;
    if (other.get_monitor() !== monitorIndex) continue;
    candidates.push(other);
  }

  return candidates.length === 1 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// AUTOTILE: when a new window is created while exactly one window is tiled
// left/right (with no partner), tile the new window onto the opposite half.
// ---------------------------------------------------------------------------

// A lone tiled half on this workspace that has no partner yet.
// Returns null unless there is exactly one.
function findLoneTiledWindow(newWin) {
  const workspace = newWin.get_workspace();
  const found = [];
  for (const actor of global.get_window_actors()) {
    const other = actor.get_meta_window();
    if (!other || other === newWin || other.minimized) continue;
    if (other.get_workspace() !== workspace) continue;
    const s = getTileState(other);
    if (s?.zone !== 'left' && s?.zone !== 'right') continue;
    if (s.match) continue;
    found.push(other);
  }
  return found.length === 1 ? found[0] : null;
}

function autoTileNewWindow(win) {
  if (state.grabbedWindow) return;
  if (!win || !win.get_compositor_private()) return;
  if (win.minimized || !isTileable(win)) return;
  if (win.get_transient_for()) return;
  if (getTileState(win)?.zone) return;

  const anchor = findLoneTiledWindow(win);
  if (!anchor) return;

  const anchorState = getTileState(anchor);
  const newZone = anchorState.zone === 'left' ? 'right' : 'left';
  const fraction = anchorState.fraction ?? 0.5;

  const workArea = anchor.get_work_area_for_monitor(anchor.get_monitor());
  const rect = getRectForZone(newZone, workArea, fraction);

  // Remember the natural size so a later drag restores it.
  const untiledRect = win.get_frame_rect().copy();

  setTileState(win, { zone: newZone, fraction, match: anchor, untiledRect });
  setTileState(anchor, { match: win });
  trackForCleanup(win);
  trackForCleanup(anchor);

  if (isMaximized(win))
    win.unmaximize(Meta.MaximizeFlags.BOTH);
  win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
}

// ---------------------------------------------------------------------------
// LAYOUT: window queries used by layout policy.
// ---------------------------------------------------------------------------
function windowExistsOnCurrentWorkspace(win) {
  if (!win) return false;
  const type = win.get_window_type();
  if (type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG) return false;
  if (win.is_skip_taskbar()) return false;
  const currentWorkspace = WorkspaceManager.get_active_workspace();
  const winWorkspace = win.get_workspace();
  if (!winWorkspace) return false;
  if (!win.is_on_all_workspaces() && winWorkspace !== currentWorkspace) return false;
  return true;
}

function windowsOnCurrentWorkspace() {
  return Display.list_all_windows().filter(windowExistsOnCurrentWorkspace);
}

function activateWindow(win) {
  win.get_workspace()?.activate_with_focus(win, global.get_current_time());
}

// ---------------------------------------------------------------------------
// Maximize a window with the same clone animation used by the
// 'maximize' edge zone. Used when a tiled pair loses one member.
// ---------------------------------------------------------------------------
function maximizeWithAnimation(win) {
  if (!win || win.minimized) return;
  if (isMaximized(win)) return;
  if (!win.can_maximize()) return;

  const workArea = win.get_work_area_for_monitor(win.get_monitor());
  playCloneAnimation(
    win,
    workArea,
    () => win.maximize(Meta.MaximizeFlags.BOTH),
    { suppressReshow: true });
}

// A window that was half of a tiled pair is going away (closed). Its
// partner gets the whole work area.
//
// This runs from the 'unmanaging' signal rather than the shell's 'destroy'
// signal because 'unmanaging' fires first and is the point where the tile
// state is cleared. By 'destroy' time the pairing is already gone.
function onWindowUnmanaging(window) {
  const partner = getTileState(window)?.match ?? null;
  clearTileState(window);
  if (partner)
    maximizeWithAnimation(partner);
}

// ---------------------------------------------------------------------------
// LAYOUT: layout policy, moved here from the focus extension.
//
//   - a lone window fills the work area
//   - a workspace never sits with all of its windows hidden
//
// It never picks the focus target for dimming; the focus extension does that.
// It does activate a window it just restored, so the window is in its final
// state before focus is evaluated.
// ---------------------------------------------------------------------------
function scheduleLayout(work = {}) {
  const p = (state.layoutPending ??= {});
  if (work.restoreMinimized) p.restoreMinimized = true;
  if (work.justMinimizedWindow) p.justMinimizedWindow = work.justMinimizedWindow;

  if (state.layoutFlushId) return;

  state.layoutFlushId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
    state.layoutFlushId = 0;
    flushLayout();
    return GLib.SOURCE_REMOVE;
  });
}

function flushLayout() {
  if (!state.layoutPending) return;
  // Don't touch window geometry mid-drag. The pending work is kept, and
  // onGrabOpEnd reschedules it.
  if (state.grabbedWindow) return;

  const { restoreMinimized, justMinimizedWindow } = state.layoutPending;
  state.layoutPending = null;
  reconcileLayout(!!restoreMinimized, justMinimizedWindow ?? null);
}

function cancelLayout() {
  if (state.layoutFlushId) {
    GLib.Source.remove(state.layoutFlushId);
    state.layoutFlushId = 0;
  }
  state.layoutPending = null;
}

function reconcileLayout(restoreMinimized = false, justMinimizedWindow = null) {
  const all = windowsOnCurrentWorkspace();
  if (all.length === 0) {
    state.lastSoloWindow = null;
    return;
  }
  const visible = all.filter(w => !w.minimized);

  // One window on the workspace: it fills the work area.
  if (all.length === 1) {
    const win = all[0];
    const isNewSoloState = state.lastSoloWindow !== win;
    state.lastSoloWindow = win;
    if (win.minimized && !restoreMinimized) return;
    if (win.minimized) win.unminimize();
    const shouldForceMaximize = isNewSoloState || restoreMinimized;
    if (!isMaximized(win) && shouldForceMaximize && win.can_maximize())
      win.maximize(Meta.MaximizeFlags.BOTH);
    activateWindow(win);
    return;
  }

  state.lastSoloWindow = null;

  // Two windows, both minimized: bring the other one back, maximized.
  if (visible.length === 0 && all.length === 2) {
    if (!justMinimizedWindow && !restoreMinimized) return;
    const other = justMinimizedWindow
      ? all.find(w => w !== justMinimizedWindow)
      : all.reduce((a, b) => a.get_user_time() > b.get_user_time() ? a : b);
    if (!other) return;
    other.unminimize();
    if (other.can_maximize())
      other.maximize(Meta.MaximizeFlags.BOTH);
    activateWindow(other);
  }
}

// ---------------------------------------------------------------------------
// Restore a maximized/tiled window to its natural size under the pointer.
//
// This runs only once the pointer has moved past DRAG_THRESHOLD (see
// onWindowPositionChanged), because a MOVING grab can begin on *press* with no
// pointer movement, and a plain click must not unmaximize or untile a window.
// ---------------------------------------------------------------------------
function restoreForDrag(window) {
  const tileState = getTileState(window);
  const maximized = isMaximized(window);

  if (tileState?.zone || maximized) {
    // Unmaximize before sampling the frame rect, so the restore size is
    // the natural unmaximized size rather than the maximized work-area
    // rect. (For windows we tiled ourselves, untiledRect already holds the
    // right size and this is a geometry no-op.)
    if (maximized)
      window.unmaximize(Meta.MaximizeFlags.BOTH);

    const untiled = tileState?.untiledRect ?? window.get_frame_rect().copy();
    const cur = window.get_frame_rect();
    const [px, py] = global.get_pointer();
    const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;
    const newX = Math.round(px - fracX * untiled.width);
    const newY = Math.round(py - Math.min(20, untiled.height * 0.05));

    // `true` is the user_op flag: tells mutter this geometry change came
    // from a user action, so it treats the result as the window's new
    // natural geometry rather than a compositor-side adjustment.
    window.move_resize_frame(true, newX, newY, untiled.width, untiled.height);
    clearTileState(window);
  }

  // Always record the natural size, even if mutter already unmaximized the
  // window itself before the threshold check fired.
  setTileState(window, { untiledRect: window.get_frame_rect().copy() });
}

// ---------------------------------------------------------------------------
// Display signal handlers.
// ---------------------------------------------------------------------------
function onGrabOpBegin(display, window, op) {
  if (!isTileable(window)) return;

  if (op === Meta.GrabOp.MOVING) {
    const tileState = getTileState(window);
    const maximized = isMaximized(window);
    const [px, py] = global.get_pointer();

    state.grabbedWindow = window;
    state.pendingZone = null;

    // Don't touch the window yet. Record where the grab started and
    // whether a restore is needed; the restore happens once the pointer
    // actually moves. If the grab ends first, it was just a click.
    state.dragStart = {
      x: px,
      y: py,
      restorePending: !!(tileState?.zone || maximized),
    };

    if (!state.dragStart.restorePending)
      setTileState(window, { untiledRect: window.get_frame_rect().copy() });

    state.dragContext = new GObject.Object();
    window.connectObject('position-changed', onWindowPositionChanged, state.dragContext);
    // The pointer poll keeps the drag responsive regardless of which grab
    // path mutter chooses, and drives the threshold check.
    startPointerPoll(window);
    return;
  }

  const tileState = getTileState(window);
  if (tileState?.zone && tileState?.match) {
    state.resizingWindow = window;
    state.resizeContext = new GObject.Object();
    window.connectObject('size-changed', onTiledWindowResized, state.resizeContext);
  }
}

function onTiledWindowResized(window) {
  const tileState = getTileState(window);
  const match = tileState?.match;
  const matchZone = match ? getTileState(match)?.zone : null;
  if (!match || !matchZone) return;

  const monitorIndex = window.get_monitor();
  const workArea = window.get_work_area_for_monitor(monitorIndex);
  const rect = window.get_frame_rect();

  let hfraction;
  if (tileState.zone === 'left')
    hfraction = rect.width / workArea.width;
  else
    hfraction = 1 - (rect.width / workArea.width);
  hfraction = Math.min(0.9, Math.max(0.1, hfraction));

  setTileState(window, { fraction: hfraction });
  setTileState(match, { fraction: hfraction });

  const leftWin = tileState.zone === 'left' ? window : match;
  const rightWin = leftWin === window ? match : window;
  const leftRect = getRectForZone('left', workArea, hfraction);
  const rightRect = getRectForZone('right', workArea, hfraction);

  if (rightWin !== window)
    rightWin.move_resize_frame(true, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
  if (leftWin !== window)
    leftWin.move_resize_frame(true, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
}

function handleGrabOpEnd(display, window, op) {
  if (state.resizingWindow === window) {
    if (state.resizeContext)
      window.disconnectObject(state.resizeContext);
    state.resizeContext = null;
    state.resizingWindow = null;
    return;
  }

  if (window !== state.grabbedWindow) return;

  stopPointerPoll();

  if (state.dragContext)
    window.disconnectObject(state.dragContext);
  state.dragContext = null;
  state.grabbedWindow = null;

  // If the restore never happened, the pointer never moved past the
  // threshold: this was a click. Leave the window and its tile state exactly
  // as they were.
  const clickOnly = state.dragStart?.restorePending;
  state.dragStart = null;
  if (clickOnly) {
    state.pendingZone = null;
    if (state.tilePreview) state.tilePreview.close();
    return;
  }

  // The preview stays open here on purpose — the clone animation closes it
  // on completion, so it remains fully visible for the whole glide.

  const zone = state.pendingZone;
  state.pendingZone = null;
  if (!zone) {
    if (state.tilePreview) state.tilePreview.close();
    clearTileState(window);
    return;
  }

  const monitorIndex = window.get_monitor();
  const workArea = window.get_work_area_for_monitor(monitorIndex);

  if (zone === 'maximize' || !(zone === 'left' || zone === 'right')) {
    if (zone === 'maximize') {
      // Maximize uses the work area as the target rect and needs
      // suppressReshow: mutter's compositor sync re-shows the real window
      // actor mid-frame when the window is maximized, so hide it again for
      // the duration of the animation.
      playCloneAnimation(
        window,
        workArea,
        () => window.maximize(Meta.MaximizeFlags.BOTH),
        { suppressReshow: true });
    } else {
      const rect = getRectForZone(zone, workArea);
      animateWindowTo(window, rect.x, rect.y, rect.width, rect.height);
    }
    clearTileState(window);
    return;
  }

  const hfraction = getTileState(window)?.fraction ?? 0.5;
  const fraction = zone === 'left' ? hfraction : 1 - hfraction;
  const leftRect = getRectForZone('left', workArea, fraction);
  const rightRect = getRectForZone('right', workArea, fraction);

  let leftWin, rightWin;
  if (zone === 'left') {
    leftWin = window;
    rightWin = findTileMatch(window);
  } else {
    rightWin = window;
    leftWin = findTileMatch(window);
  }

  if (!leftWin || !rightWin) {
    const partner = findAutoTilePartner(window, monitorIndex);
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
    setTileState(leftWin, { zone: 'left', fraction, match: rightWin });
    setTileState(rightWin, { zone: 'right', fraction, match: leftWin });
    trackForCleanup(leftWin);
    trackForCleanup(rightWin);

    if (leftWin.get_maximized?.())
      leftWin.unmaximize(Meta.MaximizeFlags.BOTH);
    if (rightWin.get_maximized?.())
      rightWin.unmaximize(Meta.MaximizeFlags.BOTH);

    animateWindowTo(leftWin, leftRect.x, leftRect.y, leftRect.width, leftRect.height);
    animateWindowTo(rightWin, rightRect.x, rightRect.y, rightRect.width, rightRect.height);
  } else {
    setTileState(window, { zone, fraction, match: null });
    trackForCleanup(window);
    const rect = zone === 'left' ? leftRect : rightRect;
    animateWindowTo(window, rect.x, rect.y, rect.width, rect.height, () => {
      const match = findTileMatch(window);
      if (match) {
        setTileState(window, { match });
        setTileState(match, { match: window, fraction, zone: zone === 'left' ? 'right' : 'left' });
        trackForCleanup(match);
        const otherRect = zone === 'left' ? rightRect : leftRect;
        animateWindowTo(match, otherRect.x, otherRect.y, otherRect.width, otherRect.height);
      }
    });
  }
}

// LAYOUT: wrapper so layout work deferred during a grab runs once it ends.
function onGrabOpEnd(display, window, op) {
  handleGrabOpEnd(display, window, op);
  if (state.layoutPending)
    scheduleLayout();
}

// ---------------------------------------------------------------------------
// Pointer/position handler. Also called from the pointer poll.
// ---------------------------------------------------------------------------
function onWindowPositionChanged(window) {
  const [px, py] = global.get_pointer();

  // Gate on the drag threshold. Until the pointer has moved far enough,
  // do nothing (no restore, no preview). Once it has, restore exactly once.
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
    const rect = getRectForZone(zone, workArea);
    if (!state.tilePreview) state.tilePreview = new TilePreview();
    state.tilePreview.open(window, rect, monitorIndex);
  } else if (state.tilePreview) {
    state.tilePreview.close();
  }
}

// ---------------------------------------------------------------------------
// LAYOUT: shell signal handlers for layout policy.
// ---------------------------------------------------------------------------
function onWorkspaceChanged() {
  scheduleLayout({ restoreMinimized: true });
}

// AUTOTILE: also queues auto-tiling of the new window.
function onWindowCreated(display, win) {
  // The window isn't mapped or sized yet at 'window-created', so wait for idle.
  if (win) {
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      state.autoTileIds.delete(id);
      autoTileNewWindow(win);
      return GLib.SOURCE_REMOVE;
    });
    state.autoTileIds.add(id);
  }
  scheduleLayout();
}

function onWindowDestroyed() {
  // The tiled-pair case is handled earlier, in onWindowUnmanaging().
  scheduleLayout();
}

function onWindowMinimized(wm, actor) {
  const win = actor.get_meta_window();

  // If one half of a tiled pair is minimized, the other half takes the
  // whole work area. The pair is dissolved first, so unminimizing later
  // doesn't resurrect a stale pairing.
  if (win) {
    const partner = releasePair(win);
    if (partner)
      maximizeWithAnimation(partner);
  }

  scheduleLayout({ justMinimizedWindow: win });
}

function onWindowUnminimized() {
  scheduleLayout();
}

// ---------------------------------------------------------------------------
// Extension entry point.
//
// This class exists only because GNOME Shell requires an Extension subclass
// and because enable/disable hooks and the uuid come from it. All the real
// work is done by the module-level functions above; enable() wires them up
// and disable() tears them down.
// ---------------------------------------------------------------------------
export default class JsTilingExtension extends Extension {
  enable() {
    initLogging(this.uuid, { output: 'both', level: 'debug', enabled: false });
    journal(`Enable`);

    resetState();

    state.mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
    state.mutterSettings.set_boolean('edge-tiling', false);

    state.grabBeginId = Display.connect('grab-op-begin', onGrabOpBegin);
    state.grabEndId = Display.connect('grab-op-end', onGrabOpEnd);

    // LAYOUT: signals for layout policy.
    state.connections = [
      [WorkspaceManager, 'active-workspace-changed', onWorkspaceChanged],
      [Display, 'window-created', onWindowCreated],
      [WindowManager, 'destroy', onWindowDestroyed],
      [WindowManager, 'minimize', onWindowMinimized],
      [WindowManager, 'unminimize', onWindowUnminimized],
    ].map(([obj, signal, handler]) => [obj, obj.connect(signal, handler)]);
  }

  disable() {
    if (state.grabBeginId) { Display.disconnect(state.grabBeginId); state.grabBeginId = 0; }
    if (state.grabEndId) { Display.disconnect(state.grabEndId); state.grabEndId = 0; }

    // LAYOUT: disconnect layout signals and cancel any queued layout pass.
    for (const [obj, id] of state.connections)
      obj.disconnect(id);
    state.connections = [];
    cancelLayout();
    state.lastSoloWindow = null;

    // AUTOTILE: cancel any queued auto-tile passes.
    for (const id of state.autoTileIds)
      GLib.Source.remove(id);
    state.autoTileIds.clear();

    stopPointerPoll();

    if (state.grabbedWindow && state.dragContext) {
      state.grabbedWindow.disconnectObject(state.dragContext);
      state.grabbedWindow = null;
      state.dragContext = null;
    }
    if (state.resizingWindow && state.resizeContext) {
      state.resizingWindow.disconnectObject(state.resizeContext);
      state.resizingWindow = null;
      state.resizeContext = null;
    }
    state.dragStart = null;

    // Tear down any snap animations still in flight, so a real window
    // actor is never left hidden and no clone is left in window_group.
    for (const teardown of [...state.activeAnimations])
      teardown(false);
    state.activeAnimations.clear();

    if (state.tilePreview) { state.tilePreview.destroy(); state.tilePreview = null; }
    state.pendingZone = null;

    // Dispose the cleanup context so the 'unmanaging' handlers connected
    // via trackForCleanup() are disconnected. Without this, every
    // enable/disable cycle leaves another set of handlers on tiled windows.
    if (state.cleanupContext) {
      state.cleanupContext.run_dispose();
      state.cleanupContext = null;
    }

    // Fresh WeakMap, not null, so any stray clearTileState() call after
    // disable() still works.
    state.tileStates = new WeakMap();
    state.cleanupTracked = new WeakSet();

    if (state.mutterSettings) {
      state.mutterSettings.set_boolean('edge-tiling', true);
      state.mutterSettings = null;
    }

    flushBuffer();
    stopLogging();
  }
}