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
const PAIR_TOLERANCE = 4;

// ===========================================================================
// GEOMETRY / WINDOW QUERIES
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

function isManaged(win) {
  return !!win &&
    win.get_window_type() === Meta.WindowType.NORMAL &&
    !win.is_override_redirect() &&
    !win.is_skip_taskbar();
}

function isTileable(win) {
  if (!isManaged(win)) return false;
  if (win.get_maximized() & Meta.MaximizeFlags.BOTH) return true;
  return win.allows_resize() && win.allows_move();
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

function activeWindows() {
  const active = WorkspaceManager.get_active_workspace();
  return Display.list_all_windows().filter(w =>
    isManaged(w) && w.get_workspace() &&
    (w.is_on_all_workspaces() || w.get_workspace() === active));
}

function neighbors(win) {
  const actors = global.get_window_actors();
  const out = [];
  for (let i = actors.length - 1; i >= 0; i--) {
    const w = actors[i].get_meta_window();
    if (w !== win && isManaged(w) && !w.minimized &&
      w.get_monitor() === win.get_monitor() && sameWorkspace(w, win))
      out.push(w);
  }
  return out;
}

// ===========================================================================
// OPS
// ===========================================================================
const ops = (() => {
  const BOTH = Meta.MaximizeFlags.BOTH;

  const teardowns = new Set();

  function abort() {
    for (const t of [...teardowns]) t(false);
    teardowns.clear();
  }

  function hasAnimations() {
    return teardowns.size > 0;
  }

  function label(win) {
    return `"${win.get_title()}"`;
  }

  function animateChange(win, targetRect, apply, { suppressReshow = false, onComplete = null } = {}) {
    const actor = win.get_compositor_private();

    const finish = () => {
      actor.show();
      animationHooks.onEnd();
      onComplete?.();
    };

    const frameRect = win.get_frame_rect();
    const content = actor.paint_to_content(frameRect);
    if (!content) { apply(); finish(); return; }

    const clone = new St.Widget({ content });
    clone.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
    clone.set_position(frameRect.x, frameRect.y);
    clone.set_size(frameRect.width, frameRect.height);
    global.window_group.add_child(clone);

    actor.hide();
    const showId = suppressReshow ? actor.connect('show', () => actor.hide()) : null;

    let done = false;
    const end = (runFinish) => {
      if (done) return;
      done = true;
      teardowns.delete(end);
      if (showId) actor.disconnect(showId);
      clone.destroy();
      if (runFinish) finish();
      else actor.show();
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

  function moveResize(win, rect, { animate = true, onComplete = null } = {}) {
    journal(`moveResize ${label(win)} -> ${rect.x},${rect.y} ${rect.width}x${rect.height}`);

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

  function maximize(win, { animate = true, onComplete = null } = {}) {
    if (win.minimized || isMaximized(win) || !win.can_maximize())
      return false;
    journal(`maximize ${label(win)} animate=${animate}`);

    if (!animate) {
      win.maximize(BOTH);
      onComplete?.();
      return true;
    }
    const workArea = win.get_work_area_for_monitor(win.get_monitor());
    animateChange(win, workArea, () => win.maximize(BOTH), { suppressReshow: true, onComplete });
    return true;
  }

  function unmaximize(win) {
    if (!win.get_maximized()) return false;
    journal(`unmaximize ${label(win)}`);
    win.unmaximize(BOTH);
    return true;
  }

  function unminimize(win) {
    if (!win.minimized) return false;
    journal(`unminimize ${label(win)}`);
    win.unminimize();
    return true;
  }

  function activate(win) {
    journal(`activate ${label(win)}`);
    win.get_workspace().activate_with_focus(win, global.get_current_time());
    return true;
  }

  function restore(win, { maximize: wantMax = false, focus = true } = {}) {
    unminimize(win);
    if (wantMax && !isMaximized(win) && win.can_maximize()) {
      journal(`maximize ${label(win)}`);
      win.maximize(BOTH);
    }
    if (focus) activate(win);
    return true;
  }

  return {
    abort, hasAnimations,
    moveResize, maximize, unmaximize, unminimize, activate, restore,
  };
})();

// ===========================================================================
// TILES
// ===========================================================================
const tiles = (() => {
  const UNLINKED = { zone: undefined, match: null, fraction: undefined };

  let states = new WeakMap();

  function init() {
    states = new WeakMap();
  }

  function destroy() {
    states = new WeakMap();
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
    return !!(s && (s.zone || s.match));
  }

  function release(win) {
    const s = states.get(win);
    if (!s) return null;
    const partner = s.match ?? null;
    if (partner) {
      const ps = states.get(partner);
      if (ps && ps.match === win)
        states.set(partner, { ...ps, ...UNLINKED });
    }
    states.set(win, { ...s, ...UNLINKED });
    return partner;
  }

  function tileSingle(win, zone, fraction) {
    release(win);
    patch(win, { zone, fraction, match: null });
  }

  function pairUp(left, right, fraction) {
    release(left);
    release(right);
    patch(left, { zone: 'left', fraction, match: right });
    patch(right, { zone: 'right', fraction, match: left });
  }

  return {
    init, destroy, get, patch, zoneOf, activePartner, hasLink,
    tileSingle, pairUp, release,
  };
})();

// ===========================================================================
// TILING ACTIONS
// ===========================================================================
function leftFractionOf(partner, workArea) {
  const r = partner.get_frame_rect();
  const f = tiles.zoneOf(partner) === 'left'
    ? r.width / workArea.width
    : (r.x - workArea.x) / workArea.width;
  return Math.min(0.9, Math.max(0.1, f));
}

function place(win, rect) {
  if (!tiles.get(win)?.untiledRect && !isMaximized(win))
    tiles.patch(win, { untiledRect: win.get_frame_rect().copy() });

  if (!isMaximized(win) && win.get_frame_rect().equal(rect)) return;
  ops.moveResize(win, rect, { animate: true });
}

function layoutPair(left, right, fraction) {
  const workArea = workAreaOf(left);
  tiles.pairUp(left, right, fraction);
  place(left, getRectForZone('left', workArea, fraction));
  place(right, getRectForZone('right', workArea, fraction));
}

function detectPairs() {
  const near = (a, b) => Math.abs(a - b) <= PAIR_TOLERANCE;
  const wins = activeWindows().filter(w =>
    !w.minimized && isTileable(w) && !isMaximized(w));

  for (let i = 0; i < wins.length; i++) {
    for (let j = i + 1; j < wins.length; j++) {
      const a = wins[i], b = wins[j];
      if (a.get_monitor() !== b.get_monitor()) continue;

      const ra = a.get_frame_rect(), rb = b.get_frame_rect();
      const [l, r, lr, rr] = ra.x <= rb.x ? [a, b, ra, rb] : [b, a, rb, ra];

      if (tiles.activePartner(l) === r) continue;
      if (tiles.activePartner(l) || tiles.activePartner(r)) continue;

      const wa = workAreaOf(l);
      const fills =
        near(lr.x, wa.x) && near(lr.y, wa.y) && near(lr.height, wa.height) &&
        near(rr.y, wa.y) && near(rr.height, wa.height) &&
        near(lr.x + lr.width, rr.x) &&
        near(rr.x + rr.width, wa.x + wa.width);

      if (fills) {
        journal('auto-pairing windows that fill the screen');
        const fraction = Math.min(0.9, Math.max(0.1, lr.width / wa.width));

        for (const w of [l, r]) {
          if (!tiles.get(w)?.untiledRect)
            tiles.patch(w, { untiledRect: w.get_frame_rect().copy() });
        }

        tiles.pairUp(l, r, fraction);
      }
    }
  }
}

function snapWindow(window, zone) {
  const workArea = workAreaOf(window);

  if (zone === 'maximize') {
    tiles.release(window);
    ops.maximize(window);
    return;
  }

  if (zone !== 'left' && zone !== 'right') {
    tiles.release(window);
    ops.moveResize(window, getRectForZone(zone, workArea));
    return;
  }

  const others = neighbors(window);

  let partner = others.find(o =>
    tiles.zoneOf(o) === oppositeZone(zone) && !tiles.activePartner(o)) ?? null;

  let fraction = 0.5;
  if (partner) {
    fraction = leftFractionOf(partner, workArea);
  } else {
    const candidates = others.filter(o => !tiles.zoneOf(o) && isTileable(o));
    if (candidates.length === 1) partner = candidates[0];
  }

  journal(`snap ${zone}, partner=${partner ? 'yes' : 'no'}`);

  if (partner) {
    const [left, right] = zone === 'left' ? [window, partner] : [partner, window];
    layoutPair(left, right, fraction);
    return;
  }

  tiles.tileSingle(window, zone, fraction);
  ops.moveResize(window, getRectForZone(zone, workArea, fraction));
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
  Display.disconnect(grabBeginId);
  Display.disconnect(grabEndId);

  stopPointerPoll();

  if (grabbedWindow) grabbedWindow.disconnectObject(dragContext);
  if (resizingWindow) resizingWindow.disconnectObject(resizeContext);

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
    ops.moveResize(rightWin, rightRect, { animate: false });
  if (leftWin !== window)
    ops.moveResize(leftWin, leftRect, { animate: false });
}

function onGrabOpEnd(display, window, op) {
  if (resizingWindow === window) {
    window.disconnectObject(resizeContext);
    resizeContext = null;
    resizingWindow = null;
    onGrabEndCallback?.();
    return;
  }

  if (window !== grabbedWindow) return;

  stopPointerPoll();
  window.disconnectObject(dragContext);
  dragContext = null;
  grabbedWindow = null;

  const clickOnly = dragStart.restorePending;
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

  if (dragStart.restorePending) {
    const dist = Math.hypot(px - dragStart.x, py - dragStart.y);
    if (dist < DRAG_THRESHOLD) return;
    dragStart.restorePending = false;

    const tile = tiles.get(window);
    const maximized = isMaximized(window);
    if (tile?.zone || maximized) {
      if (maximized) ops.unmaximize(window);
      const untiled = tile?.untiledRect ?? window.get_frame_rect().copy();
      const cur = window.get_frame_rect();
      const fracX = cur.width > 0 ? (px - cur.x) / cur.width : 0.5;
      ops.moveResize(window, {
        x: Math.round(px - fracX * untiled.width),
        y: Math.round(py - Math.min(20, untiled.height * 0.05)),
        width: untiled.width,
        height: untiled.height,
      }, { animate: false });
    }
    tiles.release(window);
    tiles.patch(window, { untiledRect: window.get_frame_rect().copy() });
  }

  const monitorIndex = Display.get_monitor_index_for_rect(
    new Mtk.Rectangle({ x: px, y: py, width: 1, height: 1 }));
  if (monitorIndex < 0) return;
  const workArea = window.get_work_area_for_monitor(monitorIndex);

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
function handleClosing(win) {
  const partner = tiles.activePartner(win);
  tiles.release(win);
  if (partner) ops.restore(partner, { maximize: true });
}

function handleMinimized(win) {
  if (tiles.activePartner(win)) tiles.release(win);
}

function maximizeLoneWindow() {
  const all = activeWindows();
  if (all.length !== 1) return;
  ops.restore(all[0], { maximize: true, focus: true });
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
    detectPairs();
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

    this._onWorkspaceChanged = WorkspaceManager.connect('active-workspace-changed',
      () => defer(maximizeLoneWindow));

    this._onWindowCreated = Display.connect('window-created', (display, win) => {
      if (!isManaged(win)) return;

      const actor = win.get_compositor_private();
      const id = actor.connect('first-frame', () => {
        actor.disconnect(id);
        defer(maximizeLoneWindow);
      });
    });

    this._onDestroy = WindowManager.connect('destroy', (wm, actor) => {
      const win = actor.get_meta_window();
      if (!isManaged(win)) return;
      handleClosing(win);
      defer(maximizeLoneWindow);
    });

    this._onMinimize = WindowManager.connect('minimize', (wm, actor) => {
      const win = actor.get_meta_window();
      if (isManaged(win)) handleMinimized(win);
    });

    this._onUnminimize = WindowManager.connect('unminimize', (wm, actor) => {
      const win = actor.get_meta_window();
      if (isManaged(win)) defer(maximizeLoneWindow);
    });
  }

  disable() {
    WorkspaceManager.disconnect(this._onWorkspaceChanged);
    Display.disconnect(this._onWindowCreated);
    WindowManager.disconnect(this._onDestroy);
    WindowManager.disconnect(this._onMinimize);
    WindowManager.disconnect(this._onUnminimize);

    clearEvents();
    ops.abort();
    destroyGrabs();
    tiles.destroy();

    this._mutterSettings.set_boolean('edge-tiling', true);
    this._mutterSettings = null;

    flushBuffer();
    stopLogging();
  }
}