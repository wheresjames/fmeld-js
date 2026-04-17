#!/usr/bin/env nodejs
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const SUPPORTED_VERSIONS = [1];

// ─── YAML I/O ─────────────────────────────────────────────────────────────────

function requireYaml() {
    try { return require('js-yaml'); }
    catch (_) { throw new Error("js-yaml is required for session files. Run: npm install js-yaml"); }
}

function loadSession(file) {
    if (!fs.existsSync(file))
        throw new Error(`Session file not found: ${file}`);
    const yaml = requireYaml();
    const data = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data.version !== 'number')
        throw new Error(`Invalid session file (missing version): ${file}`);
    if (!SUPPORTED_VERSIONS.includes(data.version))
        throw new Error(`Unsupported session version ${data.version}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`);
    return data;
}

function saveSession(sessionData, file) {
    const yaml = requireYaml();
    sessionData.session.last_saved_at        = new Date().toISOString();
    sessionData.session.path                 = file;
    sessionData.summary.reclaimable_bytes    = computeReclaimable(sessionData);
    fs.writeFileSync(file, yaml.dump(sessionData, { lineWidth: -1, noRefs: true }), 'utf8');
}

function computeReclaimable(sessionData) {
    let bytes = 0;
    for (const entry of sessionData.entries || [])
        for (const f of entry.files || [])
            if (f.action === 'delete' && !f.applied)
                bytes += f.size || 0;
    return bytes;
}

function makeTempPath() {
    return path.join(os.tmpdir(),
        `fmeld-dupes-${Date.now()}-${Math.random().toString(36).slice(2)}.yml`);
}

// ─── Selection presets ────────────────────────────────────────────────────────

/**
 * Apply --keep / --remaining preset to session data in place.
 * opts:
 *   keep         - 'first'|'newest'|'oldest'|'shortest-path'|'longest-path'|'regex'
 *   keepPattern  - regex string, required when keep === 'regex'
 *   remaining    - 'delete'|'link'|'review'  (default 'review')
 *   forcePreset  - bool; if true, overwrite groups that already have explicit decisions
 */
function applyPreset(sessionData, opts) {
    const { keep, keepPattern, remaining = 'review', forcePreset = false } = opts;
    if (!keep) return sessionData;

    for (const entry of sessionData.entries || []) {
        if (entry.result) continue;        // already applied, skip
        if ((entry.files || []).length < 2) continue;

        const hasExplicit = entry.files.some(
            f => f.action !== 'none' && f.action !== 'review'
        );
        if (hasExplicit && !forcePreset) continue;

        const idx = selectKeep(entry.files, keep, keepPattern);

        if (idx === null) {
            // regex mode: no file matched → leave all as review and warn
            process.stderr.write(
                `[Warning] --keep regex: no match in group ${entry.group_id}, left as review\n`
            );
            for (const f of entry.files) f.action = 'review';
            continue;
        }

        for (let i = 0; i < entry.files.length; i++)
            entry.files[i].action = (i === idx) ? 'keep' : remaining;
    }

    return sessionData;
}

/** Returns the index of the file to keep according to `rule`. */
function selectKeep(files, rule, pattern) {
    switch (rule) {
        case 'first':
            return 0;
        case 'newest':
            return indexOfBest(files, (a, b) => a.mtime > b.mtime);
        case 'oldest':
            return indexOfBest(files, (a, b) => a.mtime < b.mtime);
        case 'shortest-path':
            return indexOfBest(files, (a, b) => a.path.length < b.path.length);
        case 'longest-path':
            return indexOfBest(files, (a, b) => a.path.length > b.path.length);
        case 'regex': {
            if (!pattern) throw new Error('--keep regex requires --keep-pattern');
            const rx = new RegExp(pattern);
            for (let i = 0; i < files.length; i++)
                if (rx.test(files[i].path)) return i;
            return null;  // no match
        }
        default:
            throw new Error(`Unknown --keep rule: ${rule}`);
    }
}

/**
 * Returns the index of the best file per the `better(a, b)` comparator.
 * Ties break by group file order (lower index wins).
 */
function indexOfBest(files, better) {
    let best = 0;
    for (let i = 1; i < files.length; i++)
        if (better(files[i], files[best])) best = i;
    return best;
}

// ─── Group validation ─────────────────────────────────────────────────────────

/**
 * Validate a group entry before applying.
 * Returns { valid: bool, reason: string }.
 */
function validateGroup(entry) {
    const files = entry.files || [];
    if (files.some(f => f.action === 'review'))
        return { valid: false, reason: 'has unresolved files (review)' };
    const hasLink = files.some(f => f.action === 'link');
    const hasKeep = files.some(f => f.action === 'keep');
    if (hasLink && !hasKeep)
        return { valid: false, reason: 'link without keep' };
    if (files.every(f => f.action === 'none'))
        return { valid: false, reason: 'all files are none' };
    return { valid: true };
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/**
 * Apply all group decisions to the filesystem.
 * Returns a Promise<{ applied, skipped, failed }>.
 * opts:
 *   force      - bool; skip blocking groups instead of failing
 *   isFileBk   - bool; true when backend is file://
 */
function applySession(src, sessionData, opts) {
    const force    = opts.force    || false;
    const isFileBk = opts.isFileBk || false;

    let applied = 0, skipped = 0, failed = 0;
    const entries = sessionData.entries || [];
    let chain = Promise.resolve();

    for (const entry of entries) {
        chain = chain.then(() => {
            // Already fully applied → count as skipped (idempotent)
            if (entry.result === 'applied') { skipped++; return; }

            const v = validateGroup(entry);
            if (!v.valid) {
                const msg = `Group ${entry.group_id}: ${v.reason}`;
                if (!force) return Promise.reject(new Error(`Blocking: ${msg}`));
                process.stderr.write(`[Skipping] ${msg}\n`);
                entry.result        = 'skipped';
                entry.result_reason = v.reason;
                entry.result_at     = new Date().toISOString();
                skipped++;
                return;
            }

            return applyGroup(src, entry, isFileBk)
                .then(() => {
                    entry.result    = 'applied';
                    entry.result_at = new Date().toISOString();
                    applied++;
                })
                .catch(e => {
                    const msg = `Group ${entry.group_id}: ${e.message || e}`;
                    if (!force) return Promise.reject(new Error(msg));
                    process.stderr.write(`[Failed]   ${msg}\n`);
                    entry.result        = 'failed';
                    entry.result_reason = String(e);
                    entry.result_at     = new Date().toISOString();
                    failed++;
                });
        });
    }

    return chain.then(() => {
        sessionData.session.state =
            (failed > 0 || skipped > 0) ? 'partial' : 'applied';
        sessionData.session.last_applied_at = new Date().toISOString();
        return { applied, skipped, failed };
    });
}

function applyGroup(src, entry, isFileBk) {
    const keepFile = (entry.files || []).find(f => f.action === 'keep');
    let chain = Promise.resolve();

    for (const f of (entry.files || [])) {
        if (f.applied) continue;
        const action = f.action;
        if (action === 'keep' || action === 'none') continue;

        const file = f; // capture for closure
        chain = chain.then(() =>
            validateFileAtApply(src, entry, file).then(() => {
                if (action === 'delete') {
                    process.stdout.write(`[Deleting] ${file.path}\n`);
                    return src.rmFile(file.path)
                        .then(() => { file.applied = true; });
                }

                if (action === 'link') {
                    if (!isFileBk)
                        return Promise.reject(new Error('link is only supported on file:// backends'));
                    if (!keepFile)
                        return Promise.reject(new Error('no keep target found for link'));
                    process.stdout.write(`[Linking]  ${file.path} -> ${keepFile.path}\n`);
                    return new Promise((res, rej) => {
                        fs.unlink(file.path, err => {
                            if (err) return rej(err);
                            fs.link(keepFile.path, file.path, err2 => {
                                if (err2) return rej(err2);
                                file.applied = true;
                                res();
                            });
                        });
                    });
                }
            })
        );
    }

    return chain;
}

/**
 * Validate a single file entry before acting on it.
 * For file:// backends uses fs.statSync for efficiency.
 * For all other backends calls ls() on the parent directory.
 */
function validateFileAtApply(src, entry, f) {
    const method = entry.detection ? entry.detection.method : null;

    if (src.args && src.args.url && src.args.url.startsWith('file:')) {
        return new Promise((resolve, reject) => {
            try {
                const stat = fs.statSync(f.path);
                if (method !== 'name' && stat.size !== f.size)
                    return reject(new Error(`File size changed: ${f.path}`));
                resolve();
            } catch (_) {
                reject(new Error(`File not found at apply time: ${f.path}`));
            }
        });
    }

    return src.ls(path.dirname(f.path)).then(list => {
        const found = list.find(v => v.full === f.path);
        if (!found)
            throw new Error(`File not found at apply time: ${f.path}`);
        if (method !== 'name' && found.size !== f.size)
            throw new Error(`File size changed: ${f.path}`);
    });
}

// ─── Rescan carry-forward ─────────────────────────────────────────────────────

/**
 * Carry prior user selections from `oldSession` into `newData`.
 * A selection is carried forward only when both the file path and the
 * detection fingerprint (hash) still match.
 * If the detection mode changed, no carry-forward is performed.
 */
function carryForward(oldSession, newData) {
    if (!oldSession || !oldSession.entries) return newData;
    if (oldSession.mode !== newData.mode)   return newData;  // mode changed

    const oldMap = new Map();
    for (const entry of oldSession.entries) {
        const fp = entry.detection ? entry.detection.hash : '';
        for (const f of entry.files || [])
            if (f.action && f.action !== 'none')
                oldMap.set(`${f.path}\0${fp}`, f.action);
    }

    for (const entry of newData.entries) {
        const fp = entry.detection ? entry.detection.hash : '';
        for (const f of entry.files) {
            const prior = oldMap.get(`${f.path}\0${fp}`);
            if (prior) f.action = prior;
        }
    }

    return newData;
}

module.exports = {
    loadSession,
    saveSession,
    computeReclaimable,
    makeTempPath,
    applyPreset,
    validateGroup,
    applySession,
    carryForward
};
