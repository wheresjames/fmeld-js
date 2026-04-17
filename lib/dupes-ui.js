#!/usr/bin/env nodejs
'use strict';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const A = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    dim:     '\x1b[2m',
    red:     '\x1b[31m',
    green:   '\x1b[32m',
    yellow:  '\x1b[33m',
    cyan:    '\x1b[36m',
    white:   '\x1b[37m',
    clear:   '\x1b[2J\x1b[H',
};

function W() { return process.stdout.columns || 80; }
function sep(w)         { return A.dim + '─'.repeat(w || W()) + A.reset; }
function pad(s, n)      { return String(s).padEnd(n); }
function rpad(s, n)     { return String(s).padStart(n); }
function clip(s, n)     { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function humanSize(n) {
    n = n || 0;
    const u = [' B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}

function fmtDate(unix) {
    if (!unix) return '          ';
    const d = new Date(unix * 1000);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${mo[d.getMonth()]} ${String(d.getDate()).padStart(2,' ')} ${d.getFullYear()}`;
}

function actionColor(a) {
    switch (a) {
        case 'keep':   return A.green;
        case 'delete': return A.red;
        case 'link':   return A.cyan;
        case 'review': return A.yellow;
        default:       return A.dim;
    }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function countActions(files) {
    const c = { keep:0, delete:0, link:0, review:0, none:0 };
    for (const f of files) c[f.action] = (c[f.action] || 0) + 1;
    return c;
}

function countAll(entries) {
    const c = { keep:0, delete:0, link:0, review:0, none:0 };
    for (const e of entries)
        for (const f of e.files) c[f.action] = (c[f.action] || 0) + 1;
    return c;
}

function renderReview(state) {
    const w      = W();
    const sd     = state.sessionData;
    const groups = sd.entries || [];
    const total  = groups.length;
    const lines  = [];

    // ── Header ─────────────────────────────────────────────────────────────
    const sessionLabel = state.sessionFile
        ? (state.isTemp ? '(temp)' : state.sessionFile)
        : '(unsaved)';
    const dirty = state.dirty ? A.yellow + ' *' + A.reset : '';
    lines.push(sep(w));
    lines.push(
        A.bold + clip(` fmeld dupes  ·  ${sessionLabel}${state.dirty ? ' *' : ''}`, w) + A.reset
    );
    lines.push(sep(w));

    if (total === 0) {
        lines.push('');
        lines.push('  No duplicate groups found.');
        lines.push('');
        lines.push(sep(w));
        lines.push('  [q] quit');
        lines.push(sep(w));
        if (state.message) lines.push(A.dim + `  ${state.message}` + A.reset);
        process.stdout.write(A.clear + lines.join('\n') + '\n');
        return;
    }

    const gi    = Math.min(state.groupIdx, total - 1);
    const entry = groups[gi];
    const fp    = entry.detection ? entry.detection.hash.slice(0, 16) : '';
    const method = entry.detection ? entry.detection.method : '';
    const grpSz = entry.files.reduce((n, f) => n + f.size, 0);
    const applied = entry.result ? ` [${entry.result}]` : '';

    lines.push(clip(
        `  Group ${gi + 1}/${total}  ·  ${method}:${fp}  ·  ` +
        `${entry.files.length} files  ·  ${humanSize(grpSz)}${applied}`,
        w
    ));
    lines.push(sep(w));

    // ── Files ───────────────────────────────────────────────────────────────
    const nameW  = Math.max(10, w - 34);
    const header = `  ${pad('action', 8)} ${pad('size', 8)}  ${pad('modified', 12)}  path`;
    lines.push(A.dim + clip(header, w) + A.reset);

    for (let i = 0; i < entry.files.length; i++) {
        const f      = entry.files[i];
        const cursor = i === state.fileIdx ? A.bold + A.cyan + '→' + A.reset : ' ';
        const ac     = actionColor(f.action);
        const act    = ac + pad(f.action, 7) + A.reset;
        const sz     = rpad(humanSize(f.size), 8);
        const dt     = fmtDate(f.mtime);
        const nm     = clip(f.path, nameW);
        lines.push(`${cursor} ${act} ${sz}  ${pad(dt, 12)}  ${nm}`);
    }

    // ── Group summary ───────────────────────────────────────────────────────
    lines.push(sep(w));
    const gc = countActions(entry.files);
    const rec = sd.summary.reclaimable_bytes || 0;
    lines.push(
        `  ${A.green}${gc.keep} keep${A.reset}  ` +
        `${A.red}${gc.delete} delete${A.reset}  ` +
        `${A.cyan}${gc.link} link${A.reset}  ` +
        `${A.yellow}${gc.review} review${A.reset}  ` +
        `${A.dim}${gc.none} none${A.reset}` +
        `   ${A.dim}reclaimable: ${humanSize(rec)}${A.reset}`
    );

    // ── Controls ────────────────────────────────────────────────────────────
    lines.push(sep(w));
    lines.push(
        `  ${A.green}[k]${A.reset}eep  ` +
        `${A.red}[d]${A.reset}elete  ` +
        `${A.cyan}[l]${A.reset}ink  ` +
        `${A.yellow}[r]${A.reset}eview  ` +
        `${A.dim}[n]${A.reset}one`
    );
    lines.push(
        `  ${A.dim}↑↓${A.reset} files  ${A.dim}←→${A.reset} groups` +
        `   [s]ave  [S]ave-as  [a]pply  [R]escan  [q]uit`
    );
    lines.push(sep(w));

    // ── Status message ──────────────────────────────────────────────────────
    if (state.message)
        lines.push(A.dim + `  ${state.message}` + A.reset);

    process.stdout.write(A.clear + lines.join('\n') + '\n');
}

function renderConfirmApply(state) {
    const w     = W();
    const sd    = state.sessionData;
    const total = (sd.entries || []).length;
    const c     = countAll(sd.entries || []);
    const rec   = sd.summary.reclaimable_bytes || 0;

    // Count groups with no effect
    let noEffect = 0;
    const { validateGroup } = require('./dupes-session.js');
    for (const e of sd.entries || [])
        if (!e.result && !validateGroup(e).valid) noEffect++;

    const lines = [
        sep(w),
        A.bold + '  APPLY — Review your decisions' + A.reset,
        sep(w),
        `  ${A.red}Files to delete:${A.reset}   ${c.delete}`,
        `  ${A.cyan}Files to link:${A.reset}     ${c.link}`,
        `  ${A.dim}Reclaimable space:${A.reset} ${humanSize(rec)}`,
        `  ${A.yellow}Groups to skip:${A.reset}    ${noEffect}  (review, link-without-keep, all-none)`,
        `  Session file:      ${state.sessionFile || '(temp)'}`,
        sep(w),
        '  Apply these changes?',
        `  ${A.green}[y]${A.reset} Apply    ${A.red}[n]${A.reset} Cancel`,
        sep(w),
    ];
    if (state.message)
        lines.push(A.dim + `  ${state.message}` + A.reset);
    process.stdout.write(A.clear + lines.join('\n') + '\n');
}

function renderResults(result) {
    const w = W();
    const lines = [
        sep(w),
        A.bold + '  Apply complete' + A.reset,
        sep(w),
        `  ${A.green}Applied:${A.reset}  ${result.applied}`,
        `  ${A.yellow}Skipped:${A.reset}  ${result.skipped}`,
        `  ${A.red}Failed:${A.reset}   ${result.failed}`,
        sep(w),
        '  Press any key to return to review.',
        sep(w),
    ];
    process.stdout.write(A.clear + lines.join('\n') + '\n');
}

function renderWorking(msg) {
    process.stdout.write(A.clear + sep() + '\n  ' + msg + '\n' + sep() + '\n');
}

// ─── Raw line input ───────────────────────────────────────────────────────────

/**
 * Read a line of text in raw mode (no readline needed).
 * Returns a Promise<string|null> (null = cancelled with Ctrl-C / Escape).
 */
function rawReadLine(prompt) {
    return new Promise(resolve => {
        process.stdout.write(prompt);
        let buf = '';

        function handler(key) {
            if (key === '\r' || key === '\n') {
                process.stdin.removeListener('data', handler);
                process.stdout.write('\n');
                resolve(buf.trim() || null);
            } else if (key === '\x7f' || key === '\x08') {
                if (buf.length) {
                    buf = buf.slice(0, -1);
                    process.stdout.write('\x08 \x08');
                }
            } else if (key === '\x03' || key === '\x1b') {
                process.stdin.removeListener('data', handler);
                process.stdout.write('\n');
                resolve(null);
            } else if (!key.startsWith('\x1b')) {
                buf += key;
                process.stdout.write(key);
            }
        }
        process.stdin.on('data', handler);
    });
}

// ─── Main interactive loop ───────────────────────────────────────────────────

/**
 * Run the interactive review UI.
 *
 * state:
 *   sessionData    - current session data (mutated in place)
 *   sessionFile    - path to the session file (may be null for temp)
 *   isTemp         - bool, true when using a temp file
 *   src            - backend object, for rescan
 *   scanOpts       - opts passed to findDuplicates on rescan
 *   isFileBk       - bool, true when backend is file://
 *
 * Returns a Promise that resolves when the user exits.
 */
function runInteractive(state) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            return reject(new Error(
                'Interactive review requires a TTY. Use --apply for non-interactive mode.'
            ));
        }

        const Session         = require('./dupes-session.js');
        const { findDuplicates } = require('./dupes.js');

        // Local mutable UI state
        const ui = {
            sessionData: state.sessionData,
            sessionFile: state.sessionFile,
            isTemp:      state.isTemp,
            groupIdx:    0,
            fileIdx:     0,
            dirty:       false,
            message:     '',
        };

        function entries()  { return ui.sessionData.entries || []; }
        function curEntry() { return entries()[ui.groupIdx]; }

        function clampIdxs() {
            const n = entries().length;
            if (n === 0) { ui.groupIdx = 0; ui.fileIdx = 0; return; }
            ui.groupIdx = Math.max(0, Math.min(ui.groupIdx, n - 1));
            const e = curEntry();
            ui.fileIdx  = Math.max(0, Math.min(ui.fileIdx, (e.files || []).length - 1));
        }

        function setMessage(msg) { ui.message = msg; }
        function render()        { clampIdxs(); renderReview(ui); }

        // ── Save helpers ──────────────────────────────────────────────────────
        function doSave() {
            if (!ui.sessionFile) return doSaveAs();
            try {
                Session.saveSession(ui.sessionData, ui.sessionFile);
                ui.dirty = false;
                setMessage(`Saved to ${ui.sessionFile}`);
            } catch (e) {
                setMessage(`Save failed: ${e.message || e}`);
            }
            render();
        }

        function doSaveAs() {
            const prompt = `  Save as: `;
            process.stdout.write(A.clear + sep() + '\n' + prompt);
            rawReadLine('').then(file => {
                if (!file) { setMessage('Save cancelled.'); render(); return; }
                try {
                    Session.saveSession(ui.sessionData, file);
                    ui.sessionFile = file;
                    ui.isTemp      = false;
                    ui.dirty       = false;
                    setMessage(`Saved to ${file}`);
                } catch (e) {
                    setMessage(`Save failed: ${e.message || e}`);
                }
                render();
            });
        }

        // ── Apply ─────────────────────────────────────────────────────────────
        function doApply() {
            renderConfirmApply(ui);

            function handler(key) {
                process.stdin.removeListener('data', handler);
                if (key !== 'y' && key !== 'Y') {
                    setMessage('Apply cancelled.');
                    render();
                    return;
                }

                renderWorking('Applying…');
                Session.applySession(state.src, ui.sessionData, { isFileBk: state.isFileBk })
                    .then(result => {
                        renderResults(result);
                        // Save session with apply results
                        if (ui.sessionFile) {
                            try { Session.saveSession(ui.sessionData, ui.sessionFile); }
                            catch (_) {}
                        }
                        ui.dirty = false;
                        // Wait for a keypress then return to review
                        function waitKey(k) {
                            process.stdin.removeListener('data', waitKey);
                            setMessage(`Applied: ${result.applied} groups. Skipped: ${result.skipped}. Failed: ${result.failed}.`);
                            render();
                        }
                        process.stdin.once('data', waitKey);
                    })
                    .catch(e => {
                        setMessage(`Apply failed: ${e.message || e}`);
                        render();
                    });
            }
            process.stdin.once('data', handler);
        }

        // ── Rescan ────────────────────────────────────────────────────────────
        function doRescan() {
            renderWorking('Rescanning…');
            const oldSession = ui.sessionData;

            // Merge saved scan opts with any CLI overrides
            const scanOpts = Object.assign({}, {
                by:            oldSession.mode,
                recursive:     oldSession.scan.recursive,
                includeEmpty:  oldSession.scan.include_empty,
                before:        oldSession.scan.before,
                after:         oldSession.scan.after,
                minsize:       oldSession.scan.minsize,
                maxsize:       oldSession.scan.maxsize,
                fnametime:     oldSession.scan.fnametime,
                filterFiles:   oldSession.scan.filter_files,
                filterDirs:    oldSession.scan.filter_dirs,
            }, state.scanOpts || {});

            // If --by changed, warn and do not carry forward
            const byChanged = state.scanOpts && state.scanOpts.by &&
                              state.scanOpts.by !== oldSession.mode;

            findDuplicates(state.src, state.src.makePath(), scanOpts)
                .then(newData => {
                    if (!byChanged) {
                        Session.carryForward(oldSession, newData);
                    } else {
                        setMessage(
                            `Note: --by mode changed from ${oldSession.mode} to ${newData.mode}; ` +
                            `all review decisions reset.`
                        );
                    }
                    ui.sessionData = newData;
                    ui.groupIdx    = 0;
                    ui.fileIdx     = 0;
                    ui.dirty       = true;
                    if (ui.sessionFile) {
                        try { Session.saveSession(ui.sessionData, ui.sessionFile); ui.dirty = false; }
                        catch (_) {}
                    }
                    if (!byChanged) setMessage('Rescan complete. Prior selections carried forward where possible.');
                    render();
                })
                .catch(e => {
                    setMessage(`Rescan failed: ${e.message || e}`);
                    render();
                });
        }

        // ── Quit ──────────────────────────────────────────────────────────────
        function doQuit() {
            if (!ui.dirty) { cleanup(); return; }
            process.stdout.write(A.clear + sep() + '\n');
            process.stdout.write('  Unsaved changes. Exit without saving? [y/N]: ');
            rawReadLine('').then(ans => {
                if (ans && (ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes'))
                    cleanup();
                else {
                    setMessage('Exit cancelled.');
                    render();
                }
            });
        }

        function cleanup() {
            try { process.stdin.setRawMode(false); } catch (_) {}
            process.stdin.pause();
            process.stdin.removeAllListeners('data');
            // Delete temp file on clean exit
            if (ui.isTemp && ui.sessionFile) {
                try { require('fs').unlinkSync(ui.sessionFile); } catch (_) {}
            }
            resolve();
        }

        // ── Key handler ───────────────────────────────────────────────────────
        function onKey(key) {
            const n = entries().length;
            const e = n > 0 ? curEntry() : null;

            // Navigation (arrow keys only — k/d/l/r/n are reserved for actions)
            if      (key === '\x1b[A') {   // ↑ — prev file
                if (ui.fileIdx > 0) { ui.fileIdx--; render(); }
                return;
            }
            else if (key === '\x1b[B') {   // ↓ — next file
                if (e && ui.fileIdx < e.files.length - 1) { ui.fileIdx++; render(); }
                return;
            }
            else if (key === '\x1b[D') {   // ← — prev group
                if (ui.groupIdx > 0) { ui.groupIdx--; ui.fileIdx = 0; render(); }
                return;
            }
            else if (key === '\x1b[C') {   // → — next group
                if (ui.groupIdx < n - 1) { ui.groupIdx++; ui.fileIdx = 0; render(); }
                return;
            }

            // Non-action commands
            if      (key === 'q' || key === '\x03') { doQuit();   return; }
            else if (key === 's')                   { doSave();   return; }
            else if (key === 'S')                   { doSaveAs(); return; }
            else if (key === 'a')                   { doApply();  return; }
            else if (key === 'R')                   { doRescan(); return; }
            else if (key === '?') {
                setMessage('k=keep d=delete l=link r=review n=none | ↑↓ files  ←→ groups | s=save S=save-as a=apply R=rescan q=quit');
                render();
                return;
            }

            // File action assignment: k d l r n
            if (!e) return;
            const fi = e.files[ui.fileIdx];
            if (!fi) return;
            let newAction = null;
            if      (key === 'k') newAction = 'keep';
            else if (key === 'd') newAction = 'delete';
            else if (key === 'l') newAction = 'link';
            else if (key === 'r') newAction = 'review';
            else if (key === 'n') newAction = 'none';
            if (!newAction) return;

            fi.action = newAction;
            ui.dirty  = true;
            // Update entry status and reclaimable summary
            const { validateGroup, computeReclaimable } = require('./dupes-session.js');
            const v = validateGroup(e);
            e.status = v.valid ? 'ready' : 'review';
            ui.sessionData.summary.reclaimable_bytes = computeReclaimable(ui.sessionData);
            // Auto-advance to next file
            if (ui.fileIdx < e.files.length - 1) ui.fileIdx++;
            render();
        }

        // ── Start ─────────────────────────────────────────────────────────────
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onKey);
        render();
    });
}

module.exports = { runInteractive };
