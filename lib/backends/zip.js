#!/usr/bin/env nodejs
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

var Log = console.log;

/** zipClient()

    Provides zip archive access as a virtual filesystem.

    URL format:
        zip:///path/to/archive.zip
        zip:///path/to/archive.zip?password=secret
        zip:///path/to/archive.zip?passwordfile=~/.zippass
        zip:///path/to/archive.zip?compression=6&method=deflate

    All writes go to a disk staging area.  The original archive is never
    modified in place.  On close(), staging is finalized into a new archive,
    verified, and atomically swapped into place.
*/
module.exports = function zipClient(args, opts)
{
    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = '/';
    args.prefix = 'zip://';

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    let _bConnected     = false;
    let _archivePath    = null;   // abs path to the .zip file on disk
    let _password       = null;   // resolved password or null
    let _token          = null;   // random token for this session
    let _stagingDir     = null;   // <archive>.staging.<token>/
    let _stagingFiles   = null;   // <archive>.staging.<token>/files/
    let _metaPath       = null;   // <archive>.staging.<token>/meta.json
    let _finalPath      = null;   // <archive>.final.<token>
    let _stagingSetup   = null;   // shared Promise for lazy staging setup
    let _stagingReady   = false;  // true once staging dir is set up
    let _writesOccurred = false;  // true once any write has been staged

    // -----------------------------------------------------------------------
    // Standard provider interface
    // -----------------------------------------------------------------------

    function isConnected() { return _bConnected; }

    function getPrefix(p = null)
    {
        return (p && p.length)
            ? ('zip://' + ('/' === p[0] ? '' : '/') + p)
            : 'zip://';
    }

    function makePath(a = null)
    {
        return a ? path.join(args.path, a) : args.path;
    }

    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            try { _password = _resolvePassword(); }
            catch(e) { return reject(String(e)); }

            _archivePath  = args.path;
            _token        = crypto.randomBytes(8).toString('hex');
            _stagingDir   = _archivePath + '.staging.' + _token;
            _stagingFiles = path.join(_stagingDir, 'files');
            _metaPath     = path.join(_stagingDir, 'meta.json');
            _finalPath    = _archivePath + '.final.' + _token;

            if (fs.existsSync(_archivePath))
            {
                try { fs.accessSync(_archivePath, fs.constants.R_OK); }
                catch(e) { return reject(`zip: cannot read archive: ${_archivePath}`); }
            }

            _cleanOrphans();

            // Synchronous exit handler: warn if staging files were left behind
            process.on('exit', _onProcessExit);

            _bConnected = true;
            resolve(true);
        });
    }

    function close()
    {
        return new Promise((resolve) =>
        {
            if (!_bConnected)
                return resolve(true);
            _bConnected = false;
            process.removeListener('exit', _onProcessExit);

            if (!_writesOccurred)
                return resolve(true);

            _finalize()
                .then(() =>
                {
                    try { fs.rmSync(_stagingDir, { recursive: true, force: true }); } catch(e) {}
                    try
                    {   const stat = fs.statSync(_archivePath);
                        Log(`zip: saved ${_archivePath} (${_humanBytes(stat.size)})`);
                    }
                    catch(e) { Log(`zip: saved ${_archivePath}`); }
                    resolve(true);
                })
                .catch(e =>
                {
                    console.error(`\nzip: finalize failed: ${e}`);
                    if (fs.existsSync(_stagingDir))
                        console.error(`zip: staging files preserved for recovery: ${_stagingDir}`);
                    if (fs.existsSync(_finalPath))
                        console.error(`zip: partial archive preserved: ${_finalPath}`);
                    resolve(true);
                });
        });
    }

    function ls(dir)
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(dir);
        return _stagingReady ? _lsStaging(ipath, dir) : _lsArchive(ipath, dir);
    }

    function mkDir(dir, o = {})
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(dir);

        return _setupStaging().then(() =>
        {
            _writesOccurred = true;
            const stPath = _stagingFsPath(ipath);
            return new Promise((resolve, reject) =>
            {   fs.mkdir(stPath, { recursive: true }, e =>
                {   if (e) return reject(`zip: mkDir error: ${e}`);
                    resolve(true);
                });
            });
        });
    }

    function rmFile(file)
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(file);

        return _setupStaging().then(() =>
        {
            _writesOccurred = true;
            const stPath = _stagingFsPath(ipath);
            return new Promise((resolve, reject) =>
            {   fs.unlink(stPath, e =>
                {   if (e) return reject(`zip: rmFile error: ${e}`);
                    _updateMeta(ipath, null);
                    resolve(true);
                });
            });
        });
    }

    function rmDir(dir, o = {})
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(dir);

        return _setupStaging().then(() =>
        {
            _writesOccurred = true;
            const stPath = _stagingFsPath(ipath);
            return new Promise((resolve, reject) =>
            {   fs.rm(stPath, { recursive: true, force: true }, e =>
                {   if (e) return reject(`zip: rmDir error: ${e}`);
                    resolve(true);
                });
            });
        });
    }

    function createReadStream(file, o = {})
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(file);

        // If staging is active, read from there (reflects any in-progress writes)
        if (_stagingReady)
            return Promise.resolve(fs.createReadStream(_stagingFsPath(ipath)));

        // Otherwise read directly from the archive
        const unzipper = _requireBackend('unzipper');
        if (!unzipper) return Promise.reject('unzipper package required — run: fmeld setup');

        if (!fs.existsSync(_archivePath))
            return Promise.reject(`zip: archive not found: ${_archivePath}`);

        const entryPath = ipath.replace(/^\/+/, '');
        return unzipper.Open.file(_archivePath)
            .then(directory =>
            {
                const entry = directory.files.find(f =>
                    f.path.replace(/\\/g, '/').replace(/\/$/, '') === entryPath
                );
                if (!entry)
                    return Promise.reject(`zip: file not found in archive: ${ipath}`);
                try
                {   return _password ? entry.stream(_password) : entry.stream(); }
                catch(e)
                {   return Promise.reject(`zip: cannot stream ${ipath}: ${e}`); }
            });
    }

    function createWriteStream(file, o = {})
    {
        if (!_bConnected) return Promise.reject('zip: not connected');
        const ipath = _internalPath(file);

        return _setupStaging().then(() =>
        {
            _writesOccurred = true;
            const stPath = _stagingFsPath(ipath);
            fs.mkdirSync(path.dirname(stPath), { recursive: true });

            const ws = fs.createWriteStream(stPath);
            ws.on('finish', () =>
            {
                try
                {   const stat = fs.statSync(stPath);
                    _updateMeta(ipath, {
                        isFile : true,
                        mtime  : stat.mtimeMs / 1000,
                        mode   : 0o644,
                        size   : stat.size
                    });
                }
                catch(e) {}
            });
            return ws;
        });
    }

    // -----------------------------------------------------------------------
    // Path helpers
    // -----------------------------------------------------------------------

    // Strip archive path prefix to get internal path, e.g.:
    //   '/tmp/a.zip/sub/f.txt' → '/sub/f.txt'
    //   '/tmp/a.zip'           → '/'
    function _internalPath(fullPath)
    {
        if (fullPath === _archivePath)
            return '/';
        let rel = fullPath.slice(_archivePath.length);
        return rel.startsWith('/') ? rel : '/' + rel;
    }

    // Translate an internal archive path to its staging filesystem path
    function _stagingFsPath(ipath)
    {
        const p = ipath.replace(/^\/+/, '');
        return p ? path.join(_stagingFiles, p) : _stagingFiles;
    }

    // -----------------------------------------------------------------------
    // Staging setup
    // -----------------------------------------------------------------------

    // Lazily set up staging; shared so concurrent callers all wait on the same init
    function _setupStaging()
    {
        if (_stagingReady) return Promise.resolve();
        if (_stagingSetup) return _stagingSetup;
        _stagingSetup = _doSetupStaging();
        return _stagingSetup;
    }

    function _doSetupStaging()
    {
        return new Promise((resolve, reject) =>
        {
            try { fs.mkdirSync(_stagingFiles, { recursive: true }); }
            catch(e) { return reject(`zip: cannot create staging dir: ${e}`); }
            fs.writeFileSync(_metaPath, JSON.stringify({}));

            // New archive — nothing to extract
            if (!fs.existsSync(_archivePath))
            {   _stagingReady = true;
                return resolve();
            }

            const unzipper = _requireBackend('unzipper');
            if (!unzipper)
                return reject('unzipper package required — run: fmeld setup');

            unzipper.Open.file(_archivePath)
                .then(directory =>
                {
                    const meta  = {};
                    const files = directory.files.filter(e => e.type === 'File');
                    const dirs  = directory.files.filter(e => e.type === 'Directory');

                    // Create explicit directory entries in staging
                    for (const d of dirs)
                    {
                        const rel   = d.path.replace(/\\/g, '/').replace(/\/$/, '');
                        const ipath = '/' + rel;
                        meta[ipath] = {
                            isDir : true,
                            mtime : d.lastModifiedDateTime
                                        ? d.lastModifiedDateTime.getTime() / 1000 : 0,
                            mode  : (d.externalFileAttributes >> 16) || 0o755
                        };
                        fs.mkdirSync(path.join(_stagingFiles, rel), { recursive: true });
                    }

                    // Extract files one at a time, preserving metadata
                    let idx = 0;
                    function nextFile()
                    {
                        if (idx >= files.length)
                        {
                            fs.writeFileSync(_metaPath, JSON.stringify(meta, null, 2));
                            _stagingReady = true;
                            return resolve();
                        }

                        const entry  = files[idx++];
                        const rel    = entry.path.replace(/\\/g, '/');
                        const ipath  = '/' + rel;
                        const stPath = path.join(_stagingFiles, rel);

                        meta[ipath] = {
                            isFile : true,
                            mtime  : entry.lastModifiedDateTime
                                         ? entry.lastModifiedDateTime.getTime() / 1000 : 0,
                            mode   : (entry.externalFileAttributes >> 16) || 0o644,
                            size   : entry.uncompressedSize || 0
                        };

                        fs.mkdirSync(path.dirname(stPath), { recursive: true });

                        let stream;
                        try
                        {   stream = _password ? entry.stream(_password) : entry.stream(); }
                        catch(e)
                        {   return reject(`zip: cannot stream ${rel}: ${e}`); }

                        const ws = fs.createWriteStream(stPath);
                        stream.on('error', e => reject(`zip: extract error ${rel}: ${e}`));
                        ws.on('error',     e => reject(`zip: write error ${stPath}: ${e}`));
                        ws.on('finish',    nextFile);
                        stream.pipe(ws);
                    }

                    nextFile();
                })
                .catch(e => reject(`zip: cannot open archive for staging: ${e}`));
        });
    }

    // -----------------------------------------------------------------------
    // ls implementations
    // -----------------------------------------------------------------------

    function _lsStaging(ipath, fullDir)
    {
        return new Promise((resolve, reject) =>
        {
            const stagePath = _stagingFsPath(ipath);
            if (!fs.existsSync(stagePath))
                return resolve([]);

            let meta = {};
            try
            {   if (fs.existsSync(_metaPath))
                    meta = JSON.parse(fs.readFileSync(_metaPath, 'utf8'));
            }
            catch(e) {}

            try
            {
                const result = [];
                for (const entry of fs.readdirSync(stagePath))
                {
                    const entryFull  = path.join(stagePath, entry);
                    const stat       = fs.statSync(entryFull);
                    const entryIpath = (ipath === '/' ? '' : ipath) + '/' + entry;
                    const entryMeta  = meta[entryIpath] || {};
                    const virtualFull = _archivePath + entryIpath;

                    result.push({
                        name   : entry,
                        path   : fullDir,
                        full   : virtualFull,
                        isFile : stat.isFile(),
                        isDir  : stat.isDirectory(),
                        mode   : entryMeta.mode || (stat.isFile() ? 0o644 : 0o755),
                        size   : stat.isFile() ? stat.size : 0,
                        atime  : stat.atimeMs  / 1000,
                        mtime  : entryMeta.mtime || stat.mtimeMs / 1000,
                        ctime  : stat.ctimeMs  / 1000
                    });
                }
                resolve(result);
            }
            catch(e) { reject(`zip: ls staging error: ${e}`); }
        });
    }

    function _lsArchive(ipath, fullDir)
    {
        const unzipper = _requireBackend('unzipper');
        if (!unzipper)
            return Promise.reject('unzipper package required — run: fmeld setup');

        if (!fs.existsSync(_archivePath))
            return Promise.resolve([]);

        const prefix = ipath === '/' ? '' : ipath.replace(/^\/+/, '');

        return unzipper.Open.file(_archivePath)
            .then(directory =>
            {
                const result = [];
                const seen   = new Set();

                for (const entry of directory.files)
                {
                    const entryPath = entry.path.replace(/\\/g, '/').replace(/\/$/, '');
                    let relative;
                    if (!prefix)
                    {   relative = entryPath; }
                    else if (entryPath.startsWith(prefix + '/'))
                    {   relative = entryPath.slice(prefix.length + 1); }
                    else
                    {   continue; }

                    if (!relative) continue;

                    const parts   = relative.split('/');
                    const topName = parts[0];
                    if (!topName || seen.has(topName)) continue;
                    seen.add(topName);

                    const isDir       = parts.length > 1 || entry.type === 'Directory';
                    const entryIpath  = (prefix ? '/' + prefix : '') + '/' + topName;
                    const virtualFull = _archivePath + entryIpath;

                    result.push({
                        name   : topName,
                        path   : fullDir,
                        full   : virtualFull,
                        isFile : !isDir,
                        isDir  : isDir,
                        mode   : isDir ? 0o755
                                       : ((entry.externalFileAttributes >> 16) || 0o644),
                        size   : isDir ? 0 : (entry.uncompressedSize || 0),
                        atime  : 0,
                        mtime  : (!isDir && entry.lastModifiedDateTime)
                                     ? entry.lastModifiedDateTime.getTime() / 1000 : 0,
                        ctime  : 0
                    });
                }
                return result;
            });
    }

    // -----------------------------------------------------------------------
    // Finalize: staging → final.zip → verify → atomic swap
    // -----------------------------------------------------------------------

    function _finalize()
    {
        const archiver = _requireBackend('archiver');
        if (!archiver)
            return Promise.reject('archiver package required — run: fmeld setup');

        const method      = (args.args && args.args.method) || 'deflate';
        const compression = (args.args && args.args.compression)
                                ? parseInt(args.args.compression) : 6;

        return new Promise((resolve, reject) =>
        {
            let archive;

            if (_password)
            {
                const archiverEnc = _requireBackend('archiver-zip-encrypted');
                if (!archiverEnc)
                    return reject('archiver-zip-encrypted package required — run: fmeld setup');
                // registerFormat throws on duplicate; guard it
                try { archiver.registerFormat('zip-encrypted', archiverEnc); } catch(e) {}

                archive = archiver.create('zip-encrypted', {
                    zlib             : { level: compression },
                    encryptionMethod : 'aes256',
                    password         : _password
                });
            }
            else
            {
                archive = archiver.create('zip', {
                    zlib  : { level: compression },
                    store : (method === 'store')
                });
            }

            let meta = {};
            try
            {   if (fs.existsSync(_metaPath))
                    meta = JSON.parse(fs.readFileSync(_metaPath, 'utf8'));
            }
            catch(e) {}

            const output = fs.createWriteStream(_finalPath);
            archive.pipe(output);

            process.stderr.write('zip: compressing...\r');
            let _progressLen = 20;

            archive.on('progress', data =>
            {
                const pct = data.entries.total > 0
                    ? Math.floor((data.entries.processed / data.entries.total) * 100)
                    : 0;
                const msg = `zip: compressing ${data.entries.processed}/${data.entries.total} files, ` +
                            `${_humanBytes(data.fs.processedBytes)} written (${pct}%)   `;
                _progressLen = msg.length;
                process.stderr.write(msg + '\r');
            });

            archive.on('warning', e =>
            {   if (opts.verbose) Log(`zip: archiver warning: ${e}`); });
            archive.on('error',   e => reject(`zip: archiver error: ${e}`));

            output.on('close', () =>
            {
                process.stderr.write(' '.repeat(_progressLen) + '\r');
                process.stderr.write('zip: verifying...\r');
                _verify()
                    .then(() =>
                    {
                        process.stderr.write(' '.repeat(20) + '\r');
                        // Atomic swap: rename final over original (single syscall on POSIX)
                        try
                        {   fs.renameSync(_finalPath, _archivePath); }
                        catch(e)
                        {
                            // Windows fallback: delete-then-rename
                            try
                            {   if (fs.existsSync(_archivePath))
                                    fs.unlinkSync(_archivePath);
                                fs.renameSync(_finalPath, _archivePath);
                            }
                            catch(e2) { return reject(`zip: atomic swap failed: ${e2}`); }
                        }
                        resolve(true);
                    })
                    .catch(e => reject(e));
            });

            // Walk staging files dir, adding each file to the archive
            function addDir(dir, archBase)
            {
                if (!fs.existsSync(dir)) return;
                for (const entry of fs.readdirSync(dir))
                {
                    const fullDisk = path.join(dir, entry);
                    const archPath = archBase ? archBase + '/' + entry : entry;
                    if (fs.statSync(fullDisk).isDirectory())
                    {   addDir(fullDisk, archPath); }
                    else
                    {
                        const fileMeta = meta['/' + archPath] || {};
                        const mtime    = fileMeta.mtime
                                             ? new Date(fileMeta.mtime * 1000) : new Date();
                        archive.file(fullDisk, { name: archPath, date: mtime });
                    }
                }
            }

            addDir(_stagingFiles, '');
            archive.finalize();
        });
    }

    function _verify()
    {
        const unzipper = _requireBackend('unzipper');
        if (!unzipper)
            return Promise.reject('unzipper package required — run: fmeld setup');

        let expectedCount = 0;
        function countFiles(dir)
        {   if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir))
            {   const full = path.join(dir, entry);
                if (fs.statSync(full).isDirectory()) countFiles(full);
                else expectedCount++;
            }
        }
        countFiles(_stagingFiles);

        return unzipper.Open.file(_finalPath)
            .then(directory =>
            {
                const actual = directory.files.filter(f => f.type === 'File').length;
                if (actual !== expectedCount)
                    return Promise.reject(
                        `zip: verify failed: expected ${expectedCount} files, got ${actual}`
                    );
            });
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _humanBytes(n)
    {
        if (!n || n < 1024)          return (n || 0) + ' B';
        if (n < 1024 * 1024)         return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024)  return (n / (1024 * 1024)).toFixed(1) + ' MB';
        return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function _resolvePassword()
    {
        if (args.args && args.args.password)
            return args.args.password;
        if (args.args && args.args.passwordfile)
        {
            const pf = args.args.passwordfile.replace(/^~/, os.homedir());
            try { return fs.readFileSync(pf, 'utf8').trim(); }
            catch(e) { throw `zip: cannot read password file ${args.args.passwordfile}: ${e}`; }
        }
        if (args.cred)
        {
            try { return fs.readFileSync(args.cred, 'utf8').trim(); }
            catch(e) {}
        }
        return null;
    }

    function _requireBackend(pkg)
    {
        const { requireBackend } = require('../setup.js');
        try { return requireBackend(pkg, 'zip://'); }
        catch(e) { return null; }
    }

    function _updateMeta(ipath, data)
    {
        try
        {
            let meta = {};
            if (fs.existsSync(_metaPath))
                meta = JSON.parse(fs.readFileSync(_metaPath, 'utf8'));
            if (data === null)
                delete meta[ipath];
            else
                meta[ipath] = data;
            fs.writeFileSync(_metaPath, JSON.stringify(meta, null, 2));
        }
        catch(e) { if (opts.verbose) Log(`zip: meta update error: ${e}`); }
    }

    function _cleanOrphans()
    {
        try
        {
            const dir  = path.dirname(_archivePath);
            const base = path.basename(_archivePath);
            if (!fs.existsSync(dir)) return;
            const now = Date.now();
            for (const entry of fs.readdirSync(dir))
            {
                if (!entry.startsWith(base + '.staging.') &&
                    !entry.startsWith(base + '.final.'))
                    continue;
                const full = path.join(dir, entry);
                try
                {   const stat = fs.statSync(full);
                    if (now - stat.mtimeMs > ORPHAN_AGE_MS)
                    {
                        if (opts.verbose) Log(`zip: removing orphan: ${full}`);
                        fs.rmSync(full, { recursive: true, force: true });
                    }
                }
                catch(e) {}
            }
        }
        catch(e) {}
    }

    // Fires synchronously just before process exits — warns if staging was left behind
    // (covers the case where close() was not awaited and process.exit() killed the loop)
    function _onProcessExit()
    {
        if (_writesOccurred && _stagingDir && fs.existsSync(_stagingDir))
        {
            process.stderr.write(
                `\nzip: staging files preserved for recovery: ${_stagingDir}\n`
            );
        }
    }

    // -----------------------------------------------------------------------
    // Exports
    // -----------------------------------------------------------------------

    this.connect           = connect;
    this.close             = close;
    this.ls                = ls;
    this.getPrefix         = getPrefix;
    this.mkDir             = mkDir;
    this.rmFile            = rmFile;
    this.rmDir             = rmDir;
    this.makePath          = makePath;
    this.isConnected       = isConnected;
    this.createReadStream  = createReadStream;
    this.createWriteStream = createWriteStream;
};
