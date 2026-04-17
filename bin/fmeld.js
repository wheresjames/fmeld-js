#!/usr/bin/env node
'use strict'

const fs = require('fs');
const path = require('path');
const fmeld = require('..');
const chrono = require('chrono-node');

/// Masks password in a URL string for safe logging
function maskUrl(url)
{   try
    {   let u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    }
    catch(e) { return url; }
}

/// Default logging function
var Log = console.log;
var tsLog = (...args) =>
{   let now = new Date();
    let hour = String(now.getHours()).padStart(2,'0');
    let mins = String(now.getMinutes()).padStart(2,'0');
    let secs = String(now.getSeconds()).padStart(2,'0');
    console.log(`[${hour}:${mins}:${secs}]`, ...args);
}

/** Returns true if resources are available to execute the specified command

    @params [in] _p         - Propertybag
    @params [in] cmd        - Command that is to be executed
    @params [in] needSrc    - true if the command requires a source object
    @params [in] needDst    - true if the command requires a destination object
*/
function isReady(_p, cmd, needSrc, needDst)
{
    return new Promise((resolve, reject) =>
    {
        if (needSrc)
        {   if(!_p.src)
                return reject(`Command requires source : ${cmd}`);
            if (!_p.src.isConnected())
                return reject(`Waiting for source connection : ${_p.src.args.name}`);
        }
        if (needDst)
        {   if(!_p.dst)
                return reject(`Command requires destination : ${cmd}`);
            if (!_p.dst.isConnected())
                return reject(`Waiting for destination connection : ${_p.dst.args.name}`);
        }
        resolve(true);
    });
}

/**
    @param [in] _p      - Property bag
    @param [in] fp      - Root file path
    @param [in] opts    - Options
                            batch = Batch size for fetching sub directories
    @param [in] stats   - Stat totals
*/
function lsl(_p, fp, opts, stats={totalsize: 0, totalfiles: 0, totaldirs: 0})
{
    if (!opts.batch)
        opts.batch = 1;

    Log(`[${_p.src.getPrefix(fp)}]`);
    return _p.src.ls(fp)
        .then((r)=>
        {
            for (let v of r)
                if (v.isFile)
                {   stats.totalfiles++;
                    if (v.size) stats.totalsize += v.size;
                    if (_p['raw-size'])
                        Log(`${String(v.size).padStart(12, ' ')}: ${v.full}`);
                    else
                        Log(`${fmeld.toHuman(v.size).padStart(10, ' ')}: ${v.full}`);
                }
                else if (v.isDir)
                    stats.totaldirs++;

            let subs = [];
            for (let v of r)
                if (v.isDir)
                {   if (_p.recursive)
                        subs.push(v.full);
                    else
                        Log(`[${v.full}]`);
                }

            if (!subs.length)
                return stats;

            // List sub directories
            return fmeld.promiseWhileBatch(opts.batch, () => 0 < subs.length, () =>
            {   let next = subs.shift();
                return next ? lsl(_p, next, opts, stats) : stat;
            }).then(r=>stats);
        })
        .catch((e)=>{ Log(_p.verbose ? e : String(e)); });
}

/** Executes the next command
    @param [in] _p  - Property bag
*/
function nextCommand(_p)
{
    if (1 > _p.cmds.length)
        return Promise.resolve(true);

    let resources = [];

    if (!_p.src && _p.source)
    {   _p.src = fmeld.getConnection(_p.source, _p['source-cred'], {..._p, readonly: true});
        resources.push(_p.src.connect());
    }

    if (!_p.dst && _p.dest)
    {   _p.dst = fmeld.getConnection(_p.dest, _p['dest-cred'], _p);
        resources.push(_p.dst.connect());
    }

    return Promise.all(resources)
        .then(r =>
        {
            let cmd = _p.cmds[0];
            switch(cmd)
            {
                case 'md':
                    return isReady(_p, cmd, true, false)
                        .then(r => { return _p.src.mkDir(_p.src.makePath(), _p); });

                case 'rm':
                    return isReady(_p, cmd, true, false)
                        .then(r => { return _p.src.rmDir(_p.src.makePath(), _p); });

                case 'unlink':
                    return isReady(_p, cmd, true, false)
                        .then(r => { return _p.src.rmFile(_p.src.makePath()); });

                case 'ls':
                    return isReady(_p, cmd, true, false)
                        .then(r =>
                        {
                            return lsl(_p, _p.src.makePath(), {batch: _p.batch})
                                .then((r) =>
                                {
                                    if (r && 'totalfiles' in r)
                                    {   let tf = r.totalfiles, td = r.totaldirs, tsz = r.totalsize;
                                        if (!_p['raw-size'])
                                            tsz = fmeld.toHuman(tsz);
                                        console.log('');
                                        Log(`Directories: ${td}, Files: ${tf}, Size: ${tsz}\n`);
                                    }
                                });
                        });

                case 'cp':
                    return isReady(_p, cmd, true, true)
                        .then(r =>
                        {
                            // Copy the directory
                            return fmeld.copyDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
                                            {   recursive       : _p.recursive ? true : false,
                                                flatten         : _p.flatten ? true : false,
                                                skip            : _p.skip ? true : false,
                                                timestamp       : _p.timestamp ? true : false,
                                                detailed        : _p.detailed ? true : false,
                                                filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                                filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : '',
                                                after           : _p.after ? _p.after : 0,
                                                before          : _p.before ? _p.before : 0,
                                                batch           : _p.batch,
                                                progress        : fmeld.stdoutProgress,
                                                verbose         : _p.verbose ? true : false
                                            });
                        });

                case 'sync':
                    return isReady(_p, cmd, true, true)
                        .then(r =>
                        {
                            // Copy the directory
                            return fmeld.syncDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
                                            {   recursive       : _p.recursive ? true : false,
                                                less            : _p.less ? true : false,
                                                compare         : 'size,date',
                                                upload          : _p.upload ? true : false,
                                                download        : _p.download ? true : false,
                                                flatten         : _p.flatten ? true : false,
                                                skip            : _p.skip ? true : false,
                                                timestamp       : _p.timestamp ? true : false,
                                                detailed        : _p.detailed ? true : false,
                                                filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                                filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : '',
                                                after           : _p.after ? _p.after : 0,
                                                before          : _p.before ? _p.before : 0,
                                                batch           : _p.batch,
                                                progress        : fmeld.stdoutProgress,
                                                verbose         : _p.verbose ? true : false
                                            });
                        });

                case 'clean':
                    return isReady(_p, cmd, true, false)
                        .then(r =>
                        {
                            // Clean the directory
                            return fmeld.cleanDir(_p.src, _p.src.makePath(),
                                            {   recursive       : _p.recursive ? true : false,
                                                filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                                filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : '',
                                                after           : _p.after ? _p.after : 0,
                                                before          : _p.before ? _p.before : 0,
                                                fnametime       : _p.fnametime,
                                                'clean-files'   : _p['clean-files'],
                                                'clean-dirs'    : _p['clean-dirs'],
                                                minsize         : fmeld.parseSize(_p.minsize),
                                                maxsize         : fmeld.parseSize(_p.maxsize),
                                                batch           : _p.batch,
                                                less            : _p.less ? true : false,
                                                verbose         : _p.verbose ? true : false
                                            });
                        });

                case 'dupes':
                    return isReady(_p, cmd, true, false)
                        .then(() =>
                        {
                            // ── Validate option constraints ──────────────────
                            if (_p.apply && !_p.session)
                                throw '--apply requires --session';
                            if (_p.remaining && !_p.keep)
                                throw '--remaining requires --keep';
                            if (_p.keep === 'regex' && !_p['keep-pattern'])
                                throw '--keep regex requires --keep-pattern';

                            const isFileBk = _p.source && _p.source.startsWith('file:');
                            if (_p.remaining === 'link' && !isFileBk)
                                throw '--remaining link is only supported for file:// backends';

                            const Session       = fmeld.dupeSession;
                            const UI            = fmeld.dupeUI;
                            const findDuplicates = fmeld.findDuplicates;

                            const minsize = fmeld.parseSize(_p.minsize);
                            const maxsize = fmeld.parseSize(_p.maxsize);

                            const scanOpts = {
                                by:           _p.by           || 'sha256',
                                recursive:    _p.recursive    ? true : false,
                                includeEmpty: _p['include-empty'] ? true : false,
                                before:       _p.before       || null,
                                after:        _p.after        || null,
                                minsize:      minsize,
                                maxsize:      maxsize,
                                fnametime:    _p.fnametime    || null,
                                filterFiles:  _p['filter-files'] || '',
                                filterDirs:   _p['filter-dirs']  || '',
                                batch:        _p.batch        || 1,
                                sessionFile:  _p.session      || null,
                                temporary:    !_p.session,
                            };

                            const presetOpts = {
                                keep:        _p.keep          || null,
                                keepPattern: _p['keep-pattern'] || null,
                                remaining:   _p.remaining     || null,
                                forcePreset: _p['force-preset'] ? true : false,
                            };

                            // ── Helper: print non-interactive apply summary ──
                            function printApplySummary(sessionData) {
                                const { validateGroup } = Session;
                                let toDelete = 0, toLink = 0, noEffect = 0;
                                let reclaimable = sessionData.summary.reclaimable_bytes || 0;
                                for (const e of sessionData.entries || []) {
                                    if (e.result === 'applied') continue;
                                    if (!validateGroup(e).valid) { noEffect++; continue; }
                                    for (const f of e.files) {
                                        if (f.action === 'delete') toDelete++;
                                        if (f.action === 'link')   toLink++;
                                    }
                                }
                                Log(`\n  Files to delete:    ${toDelete}`);
                                Log(`  Files to link:      ${toLink}`);
                                Log(`  Reclaimable:        ${fmeld.toHuman(reclaimable)}`);
                                Log(`  Groups to skip:     ${noEffect}`);
                                Log(`  Session file:       ${sessionData.session.path}\n`);
                            }

                            // ── Helper: non-interactive apply ────────────────
                            function runApply(sessionData) {
                                printApplySummary(sessionData);
                                return Session.applySession(_p.src, sessionData,
                                    { force: _p.force ? true : false, isFileBk })
                                    .then(result => {
                                        Log(`Applied: ${result.applied}  Skipped: ${result.skipped}  Failed: ${result.failed}`);
                                        if (_p.session)
                                            Session.saveSession(sessionData, _p.session);
                                        if (result.failed > 0 && !_p.force)
                                            throw `Apply completed with ${result.failed} failure(s).`;
                                    });
                            }

                            // ── Helper: interactive flow ─────────────────────
                            function runUI(sessionData, sessionFile, isTemp) {
                                return UI.runInteractive({
                                    sessionData,
                                    sessionFile,
                                    isTemp,
                                    src:      _p.src,
                                    scanOpts,
                                    isFileBk,
                                });
                            }

                            // ── Main flow ────────────────────────────────────

                            // Case 1: session file exists → load it
                            if (_p.session && fs.existsSync(_p.session)) {
                                let sessionData = Session.loadSession(_p.session);

                                // Merge CLI scan options (CLI takes precedence)
                                if (_p.by)            sessionData.mode               = _p.by;
                                if (_p.recursive)     sessionData.scan.recursive     = true;
                                if (_p['include-empty']) sessionData.scan.include_empty = true;
                                if (_p.before)        sessionData.scan.before        = _p.before;
                                if (_p.after)         sessionData.scan.after         = _p.after;
                                if (minsize != null)  sessionData.scan.minsize       = minsize;
                                if (maxsize != null)  sessionData.scan.maxsize       = maxsize;
                                if (_p.fnametime)     sessionData.scan.fnametime     = _p.fnametime;
                                if (_p['filter-files']) sessionData.scan.filter_files = _p['filter-files'];
                                if (_p['filter-dirs'])  sessionData.scan.filter_dirs  = _p['filter-dirs'];

                                if (presetOpts.keep)
                                    sessionData = Session.applyPreset(sessionData, presetOpts);

                                if (_p.apply)
                                    return runApply(sessionData);
                                return runUI(sessionData, _p.session, false);
                            }

                            // Case 2: no existing session → scan
                            return findDuplicates(_p.src, _p.src.makePath(), scanOpts)
                                .then(sessionData => {
                                    if (presetOpts.keep)
                                        sessionData = Session.applyPreset(sessionData, presetOpts);

                                    const sessionFile = _p.session || Session.makeTempPath();
                                    sessionData.session.path      = sessionFile;
                                    sessionData.session.temporary = !_p.session;
                                    Session.saveSession(sessionData, sessionFile);

                                    if (_p.apply)
                                        return runApply(sessionData);

                                    // Interactive: if a session file was specified but didn't
                                    // exist before, prompt whether to enter review or exit.
                                    if (_p.session) {
                                        Log(`\nSession saved to: ${sessionFile}`);
                                        Log(`Found ${sessionData.summary.groups} group(s) across ${sessionData.summary.files} file(s).`);
                                        return runUI(sessionData, sessionFile, false);
                                    }

                                    return runUI(sessionData, sessionFile, true);
                                });
                        });

                        default:
                    _p.cmds.shift();
                    throw `Unknown command ${cmd}`;
            }
        });
}

/** Releases application resources

    @param [in] _p  - Property bag
*/
function closeAll(_p)
{
    const p = [];
    if (_p.src)
    {   p.push(_p.src.close().catch(() => {}));
        delete _p.src;
    }
    if (_p.dst)
    {   p.push(_p.dst.close().catch(() => {}));
        delete _p.dst;
    }
    return Promise.all(p);
}

/**
 * Interactive checkbox UI for selecting and installing backends.
 * Requires a TTY; falls back to a plain text list in non-interactive environments.
 */
function runSetup()
{
    const setup = fmeld.setup;

    if (!process.stdin.isTTY || !process.stdout.isTTY)
    {
        console.log('\nfmeld backends\n');
        setup.BACKENDS.forEach(b =>
        {
            const ok  = b.pkgs.every(setup.pkgAvailable);
            const tag = ok ? '\x1b[32minstalled\x1b[0m' : b.pkgs.join(' ') + ` (${b.size})`;
            console.log(`  ${b.key.padEnd(10)} ${b.label.padEnd(26)} ${tag}`);
        });
        console.log('\nTo install a backend: npm install <package>');
        return Promise.resolve();
    }

    return new Promise((resolve, reject) =>
    {
        const items = setup.BACKENDS.map(b => ({
            ...b,
            installed: b.pkgs.every(setup.pkgAvailable),
            selected : b.pkgs.every(setup.pkgAvailable)
        }));

        let cursor = 0;

        const bold   = '\x1b[1m';
        const dim    = '\x1b[2m';
        const green  = '\x1b[32m';
        const yellow = '\x1b[33m';
        const cyan   = '\x1b[36m';
        const reset  = '\x1b[0m';

        function render()
        {
            process.stdout.write('\x1b[2J\x1b[H');
            process.stdout.write(`${bold}  fmeld backend setup${reset}\n\n`);
            process.stdout.write(
                `  ${dim}↑↓ navigate   SPACE toggle   a select-all   n select-none   ENTER apply   q quit${reset}\n\n`
            );

            items.forEach((item, i) =>
            {
                const hi    = i === cursor;
                const check = item.selected ? `${green}[x]${reset}` : `[ ]`;
                const label = item.label.padEnd(26);
                const pkgs  = item.pkgs.join(' ');

                let status;
                if (item.installed && item.selected)
                    status = `${dim}(installed)${reset}`;
                else if (item.installed && !item.selected)
                    status = `${yellow}(will remove)${reset}`;
                else if (!item.installed && item.selected)
                    status = `${dim}(will install — ${item.size})${reset}`;
                else
                    status = `${dim}(${item.size})${reset}`;

                const prefix = hi ? `${cyan}>${reset} ` : '  ';
                const name   = hi ? `${bold}${label}${reset}` : label;
                process.stdout.write(`${prefix}${check} ${name} ${pkgs} ${status}\n`);
            });

            process.stdout.write('\n');
        }

        render();
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        function cleanup()
        {
            try { process.stdin.setRawMode(false); } catch(e) {}
            process.stdin.pause();
        }

        process.stdin.on('data', function handler(key)
        {
            if (key === '\x03' || key === 'q')
            {
                process.stdin.removeListener('data', handler);
                cleanup();
                process.stdout.write('\n  Cancelled.\n');
                return resolve();
            }

            if      (key === '\x1b[A') { cursor = (cursor - 1 + items.length) % items.length; render(); }
            else if (key === '\x1b[B') { cursor = (cursor + 1) % items.length;                render(); }
            else if (key === ' ')      { items[cursor].selected = !items[cursor].selected;     render(); }
            else if (key === 'a')      { items.forEach(i => i.selected = true);               render(); }
            else if (key === 'n')      { items.forEach(i => i.selected = false);              render(); }
            else if (key === '\r' || key === '\n')
            {
                process.stdin.removeListener('data', handler);
                cleanup();

                const toInstall   = items.filter(i =>  i.selected && !i.installed);
                const toUninstall = items.filter(i => !i.selected &&  i.installed);

                if (!toInstall.length && !toUninstall.length)
                {
                    process.stdout.write('\n  Nothing to change.\n\n');
                    return resolve();
                }

                // Don't remove a package that is still needed by another kept backend
                const keepPkgs = new Set(items.filter(i => i.selected).flatMap(i => i.pkgs));
                const pkgsToRemove = [...new Set(
                    toUninstall.flatMap(i => i.pkgs).filter(p => !keepPkgs.has(p))
                )];

                const pkgsToInstall = [...new Set(toInstall.flatMap(i => i.pkgs))];

                try
                {
                    if (pkgsToInstall.length)
                    {
                        process.stdout.write(`\n  Installing: ${pkgsToInstall.join(' ')}\n\n`);
                        setup.installPackages(pkgsToInstall);
                    }

                    if (pkgsToRemove.length)
                    {
                        process.stdout.write(`\n  Uninstalling: ${pkgsToRemove.join(' ')}\n\n`);
                        setup.uninstallPackages(pkgsToRemove);
                    }

                    process.stdout.write('\n  Done!\n\n');
                    resolve();
                }
                catch(e)
                {
                    process.stderr.write(`\n  Failed: ${String(e)}\n`);
                    reject(e);
                }
            }
        });
    });
}

/**
 * Prompt the user to install a missing backend package (TTY only).
 * Resolves true if the package was installed, false if the user declined
 * or if no TTY is available.
 *
 * @param {string}   pkg     - npm package name
 * @param {string[]} allPkgs - all packages needed by this backend
 * @param {string}   hint    - URL scheme or descriptive hint
 */
function promptInstall(pkg, allPkgs, hint)
{
    return new Promise((resolve) =>
    {
        if (!process.stdin.isTTY || !process.stdout.isTTY)
            return resolve(false);

        const pkgList = [...new Set(allPkgs || [pkg])];
        const rl = require('readline').createInterface({
            input : process.stdin,
            output: process.stdout
        });

        rl.question(
            `\n  '${pkg}' is required for ${hint || pkg}\n  Install ${pkgList.join(' ')} now? [y/N] `,
            (answer) =>
            {
                rl.close();
                if (answer.trim().toLowerCase() !== 'y' && answer.trim().toLowerCase() !== 'yes')
                    return resolve(false);

                process.stdout.write(`  Installing ${pkgList.join(' ')}...\n`);
                try
                {
                    fmeld.setup.installPackages(pkgList);
                    process.stdout.write(`  Installed. Retrying...\n\n`);
                    resolve(true);
                }
                catch(e)
                {
                    process.stderr.write(`  Install failed: ${String(e)}\n`);
                    resolve(false);
                }
            }
        );
    });
}

/// Main application function
function main()
{
    // Parse command line
    let _p = fmeld.__config__.parseParams('fmeld [options] [ls|cp|sync|md|rm|unlink|clean|dupes]', process.argv,
        [   ['s', 'source=',        'Source URL'],
            ['S', 'source-cred=',   'Source Credentials.  Can be file / dir / environment variable'],
            ['d', 'dest=',          'Destination URL'],
            ['E', 'dest-cred=',     'Destination Credentials.  Can be file / dir / environment variable'],
            ['c', 'cred-root=',     'Credentials root.  Can be a directory or environment variable'],
            ['u', 'uncached=',      'Do not use any cached credentials.'],
            ['f', 'filter-files=',  'Filter files based on regex expression'],
            ['F', 'filter-dirs=',   'Filter directories based on regex expression'],
            ['r', 'recursive',      'Recurse into sub directories'],
            ['D', 'download',       'Download missing files from destination to source'],
            ['U', 'upload',         'Upload changed or missing files from source to destination'],
            ['G', 'flatten',        'Flatten the directory structure'],
            ['l', 'less',           'Show less console output'],
            ['z', 'raw-size',       'Show raw file size'],
            ['x', 'retry=',         'Number of times to retry'],
            ['k', 'skip',           'Skip files that fail'],
            ['t', 'timestamp',      'Always show timestamp'],
            ['i', 'detailed',       'Show detailed progress info'],
            ['p', 'authport',       'Port used for OAuth, for no reason, the default is 19227'],
            ['b', 'batch=',         'How many concurrent opererations to allow, default is 1'],
            ['',  'before=',        'Show files before this timestamp'],
            ['',  'after=',         'Show files after this timestamp'],
            ['',  'minsize=',       'Minimum file size: bytes or unit string (10MB, 1.5GiB, …)'],
            ['',  'maxsize=',       'Maximum file size: bytes or unit string (10MB, 1.5GiB, …)'],
            ['',  'fnametime=',     'Regex that extracts the file or directory time from the name, Ex: [^/]+$'],
            ['',  'clean-files',    'Files should be deleted while cleaning'],
            ['',  'clean-dirs',     'Directories should be deleted while cleaning'],
            ['',  'clean-all',      'Files and directories should be deleted while cleaning'],
            ['',  'by=',            'Duplicate detection mode: name|name,size|md5|sha1|sha256 (default: sha256)'],
            ['',  'session=',       'Session file path for dupes command'],
            ['',  'apply',          'Apply a session file non-interactively (requires --session)'],
            ['',  'force',          'With --apply: skip blocking groups instead of failing'],
            ['',  'keep=',          'Preset keep rule: first|newest|oldest|shortest-path|longest-path|regex'],
            ['',  'keep-pattern=',  'Regex pattern used when --keep regex is set'],
            ['',  'remaining=',     'Action for non-kept files in preset: delete|link|review (default: review)'],
            ['',  'force-preset',   'Overwrite existing decisions when applying a preset to a loaded session'],
            ['',  'include-empty',  'Include zero-byte files in duplicate detection'],
            ['v', 'version',        'Show version'],
            ['V', 'verbose',        'Verbose logging']
        ]);

    // Verbose mode?
    if (_p.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
        Log('Program Info: ', JSON.stringify(fmeld.__info__, null, 2));
        let safeP = {..._p};
        if (safeP.source) safeP.source = maskUrl(safeP.source);
        if (safeP.dest) safeP.dest = maskUrl(safeP.dest);
        Log('Program Arguments: ', JSON.stringify(safeP, null, 2));
    }
    else if (_p.timestamp)
        Log = tsLog;

    if (_p.version)
        return Log(fmeld.__info__.version);

    if (_p.help)
        return Log(_p.help);

    if (!_p.retry)
        _p.retry = 1;
    else
        _p.retry = parseInt(_p.retry);

    if (!_p.batch)
        _p.batch = 1;
    else
        _p.batch = parseInt(_p.batch);

    if (_p['clean-all'])
        _p['clean-files'] = true, _p['clean-dirs'] = true;

    if (!_p.authport)
        _p.authport = 19227;

    if (_p.before)
    {   try { _p.before = parseInt(chrono.parse(_p.before)[0].date().getTime() / 1000); }
        catch(e) { throw `Invalid before time : ${_p.before}`; }
    }

    if (_p.after)
    {   try { _p.after = parseInt(chrono.parse(_p.after)[0].date().getTime() / 1000); }
        catch(e) { throw `Invalid after time : ${_p.after}`; }
    }

    // Build commands
    _p.cmds = [];
    for (let v of _p['*'].slice(2))
        _p.cmds.push(v);

    // 'setup' runs before any source/dest is required
    if (_p.cmds.includes('setup'))
        return runSetup().then(() => process.exit(0)).catch(e => { Log(String(e)); process.exit(1); });

    if (!_p.source)
        throw(`Source location not specified`);

    let retry = _p.retry;
    let exitCode = 0;
    fmeld.promiseWhile(() => 0 != retry && 0 < _p.cmds.length, () =>
    {
        return new Promise((resolve, reject) =>
        {
            // Wrap nextCommand so synchronous throws become rejections,
            // allowing the .catch below to handle them uniformly.
            let cmd;
            try { cmd = nextCommand(_p); }
            catch(e) { cmd = Promise.reject(e); }

            cmd.then((r) =>
                {
                    // Reset retry count
                    retry = _p.retry;

                    // Next command
                    _p.cmds.shift();

                    resolve(true);
                })
                .catch((e) =>
                {
                    // First-use install prompt for missing backend packages
                    if (e && e.code === 'BACKEND_NOT_INSTALLED' && process.stdin.isTTY)
                    {
                        return promptInstall(e.pkg, e.allPkgs, e.hint)
                            .then(installed =>
                            {
                                if (installed)
                                {
                                    // Reset connections so they are re-created with the new package
                                    return closeAll(_p).then(() =>
                                    {
                                        delete _p.src;
                                        delete _p.dst;
                                        resolve(true); // retry without touching the retry counter
                                    });
                                }
                                else
                                {
                                    Log(`Required package not installed — ${e.message || String(e)}`);
                                    return closeAll(_p).then(() =>
                                    {
                                        exitCode = 1;
                                        resolve(true); // give up on this command
                                    });
                                }
                            });
                    }

                    Log(_p.verbose ? e : String(e));
                    return closeAll(_p).then(() =>
                    {
                        if (0 >= _p.cmds.length)
                        {   exitCode = 1;
                            return resolve(true);
                        }

                        if (0 < retry)
                            retry--;

                        if (!retry)
                        {   exitCode = 1;
                            return resolve(true);
                        }
                        else
                        {   Log(`Retrying, retry count : ${(0 <= retry) ? retry : 'Infinite'}`);
                            setTimeout(()=>{ resolve(true); }, 3000);
                        }
                    });
                });
        });
    })
    .then((r) =>
    {
        if (1 != _p.retry && !retry)
            Log('Out of retries');
        else if (_p.verbose)
            Log('Done');
        return closeAll(_p);
    })
    .then(() => { process.exit(exitCode); })
    .catch((e)=> { Log(_p.verbose ? e : String(e)); process.exit(1); });

}

// Exit handling
process.on('exit',() => {});
process.on('SIGINT',() => { Log('~ ctrl+c ~'); process.exit(-1); });
process.on('uncaughtException',(e) => { Log('~ uncaught ~', e); process.exit(-1); });
process.on('unhandledRejection',(r, p) => { Log('~ unhandled ~', r, p); process.exit(-1); });

// Run the program
main();


