#!/usr/bin/env nodejs
'use strict';

const path    = require('path');
const crypto  = require('crypto');
const moment  = require('moment');
const { promiseWhileBatch } = require('./config.js');

/**
 * Normalize a base filename for weak-mode grouping.
 * Uses base-name extraction, NFC Unicode normalization, then lowercase.
 * This ensures consistent grouping across case-insensitive/case-sensitive
 * filesystems and across Unicode normalization forms.
 */
function normalizeFileName(name) {
    return path.basename(name).normalize('NFC').toLowerCase();
}

/**
 * Return a usable hex MD5 from a file entry's metadata, or null.
 * GDrive returns hex directly; GCS returns base64. Both are normalized to hex.
 * Only useful when mode === 'md5'.
 */
function getMetadataHash(entry, mode) {
    if (mode !== 'md5' || !entry.md5) return null;
    const raw = entry.md5;
    if (/^[0-9a-f]{32}$/.test(raw)) return raw;          // already hex
    try {
        const hex = Buffer.from(raw, 'base64').toString('hex');
        if (hex.length === 32) return hex;
    } catch (_) {}
    return null;
}

/**
 * Hash a file via streaming.
 * If prefixBytes > 0, reads only that many bytes from the start.
 */
function hashStream(src, filePath, algorithm, prefixBytes) {
    return src.createReadStream(filePath).then(stream => new Promise((resolve, reject) => {
        const h = crypto.createHash(algorithm);
        let read = 0, settled = false;

        function finish() {
            if (settled) return;
            settled = true;
            resolve(h.digest('hex'));
        }

        stream.on('data', chunk => {
            if (settled) return;
            if (prefixBytes > 0) {
                const remaining = prefixBytes - read;
                if (remaining <= 0) { stream.destroy(); return; }
                if (chunk.length > remaining) chunk = chunk.slice(0, remaining);
            }
            read += chunk.length;
            h.update(chunk);
            if (prefixBytes > 0 && read >= prefixBytes) stream.destroy();
        });
        stream.on('end',   finish);
        stream.on('close', finish);
        stream.on('error', e => { if (!settled) { settled = true; reject(e); } });
    }));
}

/**
 * Recursively inventory all files under `from`, applying filters from opts.
 * Results are appended to the `out` array.
 */
function inventoryFiles(src, from, opts, out) {
    if (!out) out = [];
    const filterFiles = opts.filterFiles ? new RegExp(opts.filterFiles) : null;
    const filterDirs  = opts.filterDirs  ? new RegExp(opts.filterDirs)  : null;

    return src.ls(from).then(list => {
        return promiseWhileBatch(opts.batch || 1, () => list.length > 0, () => {
            if (!list.length) return Promise.resolve(false);
            const v = list.shift();

            if (v.isFile) {
                if (filterFiles && !filterFiles.test(v.name)) return Promise.resolve(false);
                if (!opts.includeEmpty && (v.size || 0) === 0) return Promise.resolve(false);

                // Determine file time, honouring fnametime if set
                let ctime = v.mtime || v.ctime || 0;
                if (opts.fnametime) {
                    try {
                        const rx  = new RegExp(opts.fnametime, 'g');
                        const arr = rx.exec(v.full);
                        if (arr && arr.length > 1)
                            ctime = moment(arr.slice(1).join(' ')).unix();
                    } catch (_) {}
                }

                if (opts.before  && ctime > opts.before)  return Promise.resolve(false);
                if (opts.after   && ctime < opts.after)   return Promise.resolve(false);
                if (opts.minsize != null && v.size < opts.minsize) return Promise.resolve(false);
                if (opts.maxsize != null && v.size > opts.maxsize) return Promise.resolve(false);

                out.push({
                    path:  v.full,
                    name:  v.name,
                    size:  v.size  || 0,
                    mtime: v.mtime || v.ctime || 0,
                    md5:   v.md5   || null,
                });
                return Promise.resolve(false);
            }

            if (v.isDir && opts.recursive) {
                if (filterDirs && !filterDirs.test(v.name)) return Promise.resolve(false);
                return inventoryFiles(src, v.full, opts, out);
            }

            return Promise.resolve(false);
        });
    }).then(() => out);
}

/**
 * Group files by weak mode: 'name' or 'name,size'.
 * Returns only groups with 2+ members.
 */
function groupWeak(files, mode) {
    const map = new Map();
    for (const f of files) {
        const key = mode === 'name'
            ? normalizeFileName(f.name)
            : normalizeFileName(f.name) + '\0' + f.size;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(f);
    }
    const groups = [];
    for (const [key, members] of map)
        if (members.length > 1)
            groups.push({ fingerprint: key, method: mode, hashSource: null, members });
    return groups;
}

/**
 * Group files by strong mode (md5 / sha1 / sha256).
 * Pipeline: group by size → discard singletons → optional prefix hash →
 *           full hash only on collisions → group by final digest.
 */
function groupStrong(src, files, algorithm, opts) {
    const prefixSize      = opts.prefixHashSize      || 1024;
    const prefixThreshold = opts.prefixHashThreshold || 65536;

    // Step 1: group by size, discard singletons
    const bySize = new Map();
    for (const f of files) {
        if (!bySize.has(f.size)) bySize.set(f.size, []);
        bySize.get(f.size).push(f);
    }
    const candidates = [];
    for (const [, members] of bySize)
        if (members.length > 1) candidates.push(...members);

    if (!candidates.length) return Promise.resolve([]);

    // Step 2a: assign metadata hashes where available
    const toHash = [];
    for (const f of candidates) {
        const meta = getMetadataHash(f, algorithm);
        if (meta) {
            f._hash       = meta;
            f._hashSource = 'metadata';
        } else {
            toHash.push(f);
        }
    }

    const small = toHash.filter(f => f.size < prefixThreshold);
    const large = toHash.filter(f => f.size >= prefixThreshold);
    const batch = opts.batch || 1;

    // Step 2b: hash small files directly
    const hashSmall = () => {
        const work = small.slice();
        return promiseWhileBatch(batch, () => work.length > 0, () => {
            const f = work.shift();
            if (!f) return Promise.resolve(false);
            return hashStream(src, f.path, algorithm, 0)
                .then(h  => { f._hash = h; f._hashSource = 'streamed'; })
                .catch(e => { process.stderr.write(`[Warning] hash failed: ${f.path}: ${e}\n`); });
        });
    };

    // Step 2c: prefix-hash large files, then full-hash only prefix-collision groups
    const hashLarge = () => {
        if (!large.length) return Promise.resolve();
        const work = large.slice();
        return promiseWhileBatch(batch, () => work.length > 0, () => {
            const f = work.shift();
            if (!f) return Promise.resolve(false);
            return hashStream(src, f.path, algorithm, prefixSize)
                .then(h  => { f._prefix = h; })
                .catch(e => { process.stderr.write(`[Warning] prefix-hash failed: ${f.path}: ${e}\n`); });
        }).then(() => {
            const byPrefix = new Map();
            for (const f of large) {
                if (!f._prefix) continue;
                if (!byPrefix.has(f._prefix)) byPrefix.set(f._prefix, []);
                byPrefix.get(f._prefix).push(f);
            }
            const fullWork = [];
            for (const [, grp] of byPrefix)
                if (grp.length > 1) fullWork.push(...grp);

            return promiseWhileBatch(batch, () => fullWork.length > 0, () => {
                const f = fullWork.shift();
                if (!f) return Promise.resolve(false);
                return hashStream(src, f.path, algorithm, 0)
                    .then(h  => { f._hash = h; f._hashSource = 'streamed'; })
                    .catch(e => { process.stderr.write(`[Warning] hash failed: ${f.path}: ${e}\n`); });
            });
        });
    };

    return hashSmall()
        .then(() => hashLarge())
        .then(() => {
            const map = new Map();
            for (const f of candidates) {
                if (!f._hash) continue;
                if (!map.has(f._hash)) map.set(f._hash, []);
                map.get(f._hash).push(f);
            }
            const groups = [];
            for (const [hash, members] of map)
                if (members.length > 1)
                    groups.push({
                        fingerprint: hash,
                        method:      algorithm,
                        hashSource:  members[0]._hashSource || null,
                        members
                    });
            return groups;
        });
}

/** Build the session data object from discovered groups. */
function buildSession(src, from, groups, mode, opts) {
    const now = new Date().toISOString();
    let groupedBytes = 0;

    const entries = groups.map(g => {
        for (const m of g.members) groupedBytes += m.size;
        return {
            group_id:  `${g.method}:${g.fingerprint.slice(0, 16)}`,
            status:    'review',
            result:    null,
            detection: {
                method:      g.method,
                hash:        g.fingerprint,
                hash_source: g.hashSource || null
            },
            files: g.members.map(f => ({
                path:    f.path,
                name:    f.name,
                size:    f.size,
                mtime:   f.mtime,
                action:  'none',
                applied: false
            }))
        };
    });

    const sourceUrl = (src.args && (src.args.url || src.args.name)) || '';

    return {
        version:      1,
        source:       sourceUrl,
        root:         from,
        mode,
        generated_at: now,
        scan: {
            recursive:     opts.recursive    ? true  : false,
            include_empty: opts.includeEmpty ? true  : false,
            before:        opts.before       || null,
            after:         opts.after        || null,
            minsize:       opts.minsize  != null ? opts.minsize  : null,
            maxsize:       opts.maxsize  != null ? opts.maxsize  : null,
            fnametime:     opts.fnametime    || null,
            filter_files:  opts.filterFiles  || null,
            filter_dirs:   opts.filterDirs   || null
        },
        session: {
            path:             opts.sessionFile || null,
            state:            'review',
            temporary:        opts.temporary   ? true : false,
            last_saved_at:    null,
            last_applied_at:  null,
            last_scanned_at:  now
        },
        summary: {
            groups:            entries.length,
            files:             entries.reduce((n, e) => n + e.files.length, 0),
            grouped_bytes:     groupedBytes,
            reclaimable_bytes: 0
        },
        entries
    };
}

/**
 * Main entry point: inventory src starting at `from` and return session data.
 * opts:
 *   by                  - 'name'|'name,size'|'md5'|'sha1'|'sha256'
 *   recursive           - bool
 *   includeEmpty        - bool
 *   before/after        - unix timestamps
 *   minsize/maxsize     - bytes
 *   fnametime           - regex string
 *   filterFiles         - regex string
 *   filterDirs          - regex string
 *   batch               - concurrency
 *   prefixHashSize      - bytes (default 1024)
 *   prefixHashThreshold - bytes (default 65536)
 *   sessionFile         - path for the session file (for metadata only)
 *   temporary           - bool
 */
function findDuplicates(src, from, opts) {
    const mode = opts.by || 'sha256';
    process.stdout.write(`[Scanning] ${from} (mode: ${mode})\n`);

    return inventoryFiles(src, from, opts)
        .then(files => {
            process.stdout.write(`[Scanned]  ${files.length} files\n`);
            if (mode === 'name' || mode === 'name,size')
                return groupWeak(files, mode);
            return groupStrong(src, files, mode, opts);
        })
        .then(groups => {
            process.stdout.write(`[Found]    ${groups.length} duplicate group(s)\n`);
            return buildSession(src, from, groups, mode, opts);
        });
}

module.exports = { findDuplicates, normalizeFileName };
