#!/usr/bin/env node
'use strict'

const fs = require('fs');
const path = require('path');
const fmeld = require('fmeld');

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
    if (needSrc)
    {   if(!_p.src)
            throw `Command requires source : ${cmd}`;
        if (!_p.src.isConnected())
        {   _p.cmds.unshift(cmd);
            Log(`Waiting for source connection : ${_p.src.args.name}`);
            return false;
        }
    }
    if (needDst)
    {   if(!_p.dst)
            throw `Command requires destination : ${cmd}`;
        if (!_p.dst.isConnected())
        {   _p.cmds.unshift(cmd);
            Log(`Waiting for destination connection : ${_p.dst.args.name}`);
            return false;
        }
    }
    return true;
}

/**
    @param [in] _p      - Property bag
    @param [in] fp      - Root file path
    @param [in] stats   - Stat totals
*/
function lsl(_p, fp, stats={totalsize: 0, totalfiles: 0, totaldirs: 0})
{
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
                return Promise.resolve(stats);

            // List sub directories
            return fmeld.promiseWhile(() => 0 < subs.length, () =>
            {   let next = subs.shift();
                return next ? lsl(_p, next, stats) : Promise.resolve(stats);
            });
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

    return new Promise((resolve, reject) =>
    {
        let resources = [];

        if (!_p.src && _p.source)
        {   _p.src = fmeld.getConnection(_p.source, _p['source-cred'], {..._p, readonly: true});
            resources.push(_p.src.connect());
        }

        if (!_p.dst && _p.dest)
        {   _p.dst = fmeld.getConnection(_p.dest, _p['dest-cred'], _p);
            resources.push(_p.dst.connect());
        }

        Promise.all(resources)
            .then((r) =>
            {
                let cmd = _p.cmds[0];
                switch(cmd)
                {
                    case 'ls':
                    case 'lsl':
                        if (!isReady(_p, cmd, true, false))
                            return;
                        lsl(_p, _p.src.makePath())
                            .then((r) =>
                            {
                                if (r && 'totalfiles' in r)
                                {
                                    let tf = r.totalfiles, td = r.totaldirs, tsz = r.totalsize;
                                    if (!_p['raw-size'])
                                        tsz = fmeld.toHuman(tsz);
                                    console.log('');
                                    Log(`Directories: ${td}, Files: ${tf}, Size: ${tsz}\n`);
                                }
                                resolve(true);
                            })
                            .catch((e) => { reject(e); });
                        break;

                    case 'cp':
                        if (!isReady(_p, cmd, true, true))
                            return;

                        // Copy the directory
                        fmeld.copyDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
                                        {   recursive       : _p.recursive ? true : false,
                                            flatten         : _p.flatten ? true : false,
                                            skip            : _p.skip ? true : false,
                                            timestamp       : _p.timestamp ? true : false,
                                            detailed        : _p.detailed ? true : false,
                                            filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                            filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : '',
                                            progress        : fmeld.stdoutProgress
                                        })
                            .then((r) => { resolve(true); })
                            .catch((e)=>{ reject(e); });

                        break;

                    case 'sync':
                        if (!isReady(_p, cmd, true, true))
                            return;

                        // Copy the directory
                        fmeld.syncDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
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
                                            progress        : fmeld.stdoutProgress
                                        })
                            .then((r) => { resolve(true); })
                            .catch((e)=>{ reject(e); });

                        break;

                    default:
                        reject(`Unknown command ${cmd}`);
                }
            })
            .catch((e)=>{ reject(e); });
        });
}

/** Releases application resources

    @param [in] _p  - Property bag
*/
function closeAll(_p)
{
    if (_p.src)
    {   _p.src.close();
        delete _p.src;
    }

    if (_p.dst)
    {   _p.dst.close();
        delete _p.dst;
    }
}

/// Main application function
function main()
{
    // Parse command line
    let _p = fmeld.__config__.parseParams('fmeld [options] [commands ...]', process.argv,
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
            ['v', 'version',        'Show version'],
            ['V', 'verbose',        'Verbose logging']
        ]);

    // Verbose mode?
    if (_p.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
        Log('Program Info: ', JSON.stringify(fmeld.__info__, null, 2));
        Log('Program Arguments: ', JSON.stringify(_p, null, 2));
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

    // Build commands
    _p.cmds = [];
    for (let v of _p['*'].slice(2))
        _p.cmds.push(v);

    if (!_p.source)
        throw(`Source location not specified`);

    let retry = _p.retry;
    fmeld.promiseWhile(() => 0 != retry && 0 < _p.cmds.length, () =>
    {
        return new Promise((resolve, reject) =>
        {
            // Execute command
            nextCommand(_p)
                .then((r) =>
                {
                    // Reset retry count
                    retry = _p.retry;

                    // Next command
                    _p.cmds.shift();

                    resolve(true);
                })
                .catch((e)=>
                {
                    Log(_p.verbose ? e : String(e));
                    closeAll(_p);
                    if (0 < retry)
                        retry--;
                    if (!retry)
                        resolve(true);
                    else
                    {   Log(`Retrying, retry count : ${(0 <= retry) ? retry : 'Infinite'}`);
                        setTimeout(()=>{ resolve(true); }, 3000);
                    }
                });
        });
    })
    .then((r) =>
    {
        if (!retry)
            Log('Out of retries');
        else if (_p.verbose)
            Log('Done');
        closeAll(_p);
    })
    .catch((e)=> { Log(_p.verbose ? e : String(e)); });

}

// Exit handling
process.on('exit', function() {});
process.on('SIGINT', function() { Log('~ keyboard ~'); process.exit(-1); });
process.on('uncaughtException', function(e) { Log('~ uncaught ~', e); process.exit(-1); });

// Run the program
main();


