import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// ============================================================================
// Simple logger for GNOME extensions.
//
// PUBLIC API (the only 4 things to import):
//   initLogging(uuid, options) - call ONCE, at the top of enable()
//   stopLogging()              - call ONCE, at the top of disable()
//   createLogger(source)       - call once per file, at module top level
//   flushBuffer()              - OPTIONAL: force buffered lines to disk NOW
//
// ----- the options -----
//
//   output  : where to write
//               'journal' -> GNOME journal only
//                            (view: journalctl /usr/bin/gnome-shell)
//               'file'    -> ~/<uuid>.log only
//               'both'    -> journal + file            (default: 'journal')
//
//   level   : minimum level that gets written
//               'error' -> error only
//               'warn'  -> error + warn
//               'info'  -> error + warn + info
//               'debug' -> everything                    (default: 'debug')
//
//   enabled : master on/off switch
//               true  -> logging active                 (default: true)
//               false -> EVERYTHING off: every journal.xxx() call becomes
//                        a silent no-op. Note this wins over 'level' -
//                        with enabled: false, nothing is logged, not even
//                        errors, no matter what level says. level and
//                        output are ignored.
//
//   All combinations, and what each does:
//
//     initLogging(this.uuid);
//         // journal only, everything logged (defaults)
//
//     initLogging(this.uuid, { output: 'both', level: 'debug' });
//         // journal + file, everything logged  <- use while developing
//
//     initLogging(this.uuid, { output: 'both', level: 'info' });
//         // journal + file, the story only, no debug flood  <- daily use
//
//     initLogging(this.uuid, { output: 'journal', level: 'warn' });
//         // journal only, warnings + errors    <- nearly silent
//
//     initLogging(this.uuid, { output: 'journal', level: 'error' });
//         // journal only, errors only
//
//     initLogging(this.uuid, { output: 'journal', level: 'warn', enabled: false });
//         // NOTHING logged. enabled: false wins over level and output -
//         // they are stored but never consulted. For "off", the simpler
//         // form is: initLogging(this.uuid, { enabled: false });
//
//     initLogging(this.uuid, { enabled: false });
//         // off; code elsewhere untouched, flip enabled back to true
//         // to reactivate
//
// ----- enable() / disable() in extension.js -----
//
//   enable() {
//       initLogging(this.uuid, { output: 'file', level: 'warn', enabled: true });
//       ...
//   }
//
//   disable() {
//       flushBuffer();   // force-write pending lines NOW (see below)
//       stopLogging();   // clear logger state
//       ...rest of teardown
//   }
//
// ----- other files (NOT extension.js) -----
//
//   Do NOT call initLogging or stopLogging there. Only:
//
//       import { createLogger } from './logger.js';
//       const journal = createLogger(import.meta.url);
//       journal.debug('...');
//
//   Lifecycle (init/stop) belongs to extension.js alone, because enable()
//   and disable() are the only places that know when logging starts/stops.
//
// ----- the returned logger: how levels work -----
//
//   When you use journal('msg') you are actually saying
//   journal.info('msg'). You can say it explicitly or not - both are
//   identical. The direct call is just a shorthand for info.
//
//   journal.debug('msg') is NOT the same - it is one level noisier.
//   debug is the first thing filtered out when you tighten the level
//   option in initLogging.
//
//   Direct call:   journal('Enabled')          == journal.info('Enabled')
//   Named levels:  journal.error(...)  journal.warn(...)
//                  journal.info(...)   journal.debug(...)
//
//   Levels, quietest to noisiest:
//       error -> warn -> info -> debug
//
//   What to use each for:
//       journal('...')       narrative events (enable, workspace changed,
//                            decisions) - the story, always worth seeing
//       journal.debug(...)   flood-prone details (every handler call,
//                            geometry) - marked "safe to silence"
//       journal.warn(...)    suspicious but survived
//       journal.error(...)   failures - survive even the tightest filter
//
//   Calling the logger is ALWAYS safe, at any time:
//     - before initLogging / after stopLogging: silent no-op, no crash
//     - a line whose level is filtered out: silently dropped
//     - enabled: false: everything silently dropped
//     The only question is whether it writes, never whether it throws.
//
// ----- WHY flushBuffer exists -----
//
//   File writes are buffered: log lines are collected in memory and one
//   idle callback writes them all in a single I/O operation (so a flood
//   of signals during a window drag never stutters the shell).
//
//   The catch: idle callbacks are NOT guaranteed to run during disable()
//   teardown, and a hard shell crash kills the buffer entirely. So the
//   last few lines before disable() (or a crash) would be lost.
//
//   flushBuffer() is the escape hatch: call it to force-write everything
//   still in memory. Call it in disable() before stopLogging(). Call it
//   before any code you suspect might crash the shell, if you need the
//   log complete up to that point.
// ============================================================================

// ===== internal module state =====
let state = null;
let _buffer = [];
let _flushId = 0;

// internal constant, not an option: rotate the log file above this size
const MAX_BYTES = 512 * 1024;

function initLogging(extensionUuid, {
    output = 'journal',     // 'journal' | 'file' | 'both'
    level = 'debug',        // minimum level that gets written:
    //   'error' -> error only
    //   'warn'  -> error + warn
    //   'info'  -> error + warn + info
    //   'debug' -> everything (default)
    enabled = true,         // false -> everything off, level/output ignored
} = {}) {
    state = {
        uuid: extensionUuid,
        output,
        enabled,
        level,
        logFile: (output === 'file' || output === 'both')
            ? GLib.build_filenamev([GLib.get_home_dir(), `${extensionUuid}.log`])
            : null,
        levels: { error: 0, warn: 1, info: 2, debug: 3 },
    };
}

function stopLogging() {
    flushBuffer();          // write what's still pending
    if (_flushId) {
        GLib.Source.remove(_flushId);
        _flushId = 0;
    }
    state = null;
}

// ===== buffered file writes =====
// Every line is pushed into memory instantly (no I/O). One idle callback
// drains the whole buffer in a single write. Nothing is ever dropped -
// during a signal-storm the lines just wait a few ms in the buffer.

function writeToFile(output) {
    if (!state.logFile) return;

    _buffer.push(output);

    if (_flushId) return;   // a flush is already queued

    _flushId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        _flushId = 0;
        flushBuffer();
        return GLib.SOURCE_REMOVE;
    });
}

function flushBuffer() {
    if (_buffer.length === 0) return;

    const lines = _buffer;
    _buffer = [];

    try {
        const file = Gio.File.new_for_path(state.logFile);

        // rotate: if the log grew past MAX_BYTES, start fresh
        try {
            const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() > MAX_BYTES)
                file.replace(null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) { /* first run: file doesn't exist yet, fine */ }

        const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        stream.write_all(new TextEncoder().encode(lines.join('\n') + '\n'), null);
        stream.close(null);
    } catch (e) {
        console.error(`[${state.uuid}] Log flush failed: ${e}`);
    }
}

// ===== the logger =====
// One per file: const journal = createLogger(import.meta.url);
//
// Returns a callable. journal('msg') is a shorthand for
// journal.info('msg') - identical, said implicitly or explicitly.
// journal.debug('msg') is one level noisier and is filtered out first
// when the 'level' option is tightened.
//
// Note: stopLogging() only stops WRITING - journal.debug() etc. remain
// safe to call afterwards (they become no-ops), so leftover signal
// handlers can't crash on a log call during teardown.

function createLogger(source) {
    let sourceFile;
    try {
        sourceFile = GLib.filename_from_uri(source)[0];
    } catch (e) {
        sourceFile = source;
    }

    function logAt(level, msg) {
        if (!state?.enabled) return;                      // 1. master switch
        if (state.levels[level] > state.levels[state.level]) return;  // 2. level filter

        const output = `[${level}] [${sourceFile}] ${msg}`;

        if (state.output === 'journal' || state.output === 'both')
            writeToJournal(output, level);
        if (state.output === 'file' || state.output === 'both')
            writeToFile(output);
    }

    // callable object: direct call = info (shorthand for journal.info),
    // named levels attached to it
    const journal = (msg) => logAt('info', msg);
    journal.error = (m) => logAt('error', m);
    journal.warn = (m) => logAt('warn', m);
    journal.info = (m) => logAt('info', m);
    journal.debug = (m) => logAt('debug', m);
    return journal;
}

function writeToJournal(output, level) {
    // map our levels onto journal levels, so `journalctl -p warning`
    // can filter just the errors/warnings
    const flags = level === 'error' ? GLib.LogLevelFlags.LEVEL_ERROR
        : level === 'warn' ? GLib.LogLevelFlags.LEVEL_WARNING
            : GLib.LogLevelFlags.LEVEL_MESSAGE;

    GLib.log_structured(state.uuid, flags, {
        MESSAGE: output,
        SYSLOG_IDENTIFIER: state.uuid,
    });
}

export { initLogging, stopLogging, createLogger, flushBuffer };
