#!/usr/bin/env node
'use strict'

const fs = require('fs');
const path = require('path');
const fmeld = require('fmeld');
var Log = console.log;

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

/** Executes the next command
    @param [in] _p  - Property bag
*/
function nextCommand(_p, init=false)
{
    if (!init && 1 > _p.cmds.length)
        quit(_p);

    else if (0 < _p.cmds.length)
    {
        let cmd = _p.cmds.shift();
        switch(cmd)
        {
            case 'ls':
                if (!isReady(_p, cmd, true, false))
                    return;

                _p.src.ls(_p.src.makePath())
                    .then((r)=>
                    {
                        for (let v of r)
                            Log(v.full);

                        nextCommand(_p);
                    })
                    .catch((e)=>{ Log(e); nextCommand(_p); });
                break;

            case 'lsl':
                if (!isReady(_p, cmd, true, false))
                    return;

                _p.src.ls(_p.src.makePath())
                    .then((r)=>
                    {
                        for (let v of r)
                            if (v.isDir)
                                Log(`[${v.full}]`);
                        for (let v of r)
                            if (v.isFile)
                                Log(`${v.full} (${fmeld.toHuman(v.size)})`);

                        nextCommand(_p);
                    })
                    .catch((e)=>{ Log(e); nextCommand(_p); });
                break;

            case 'cp':
                if (!isReady(_p, cmd, true, true))
                    return;

                // Copy the directory
                fmeld.copyDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
                                {   recursive       : _p.recursive ? true : false,
                                    flatten         : _p.flatten ? true : false,
                                    filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                    filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : ''
                                }, fmeld.stdoutProgress)
                    .then((r) => { nextCommand(_p); })
                    .catch((e)=>{ Log(e); nextCommand(_p); });

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
                                    filterFiles     : _p['filter-files'] ? _p['filter-files'] : '',
                                    filterDirs      : _p['filter-dirs'] ? _p['filter-dirs'] : ''
                                }, fmeld.stdoutProgress)
                    .then((r) => { nextCommand(_p); })
                    .catch((e)=>{ Log(e); nextCommand(_p); });

                break;

            default:
                throw `Unknown command ${cmd}`;
        }
    }
}

/** Releases application resources

    @param [in] _p  - Property bag
*/
function quit(_p)
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
            ['f', 'filter-files=',  'Filter files based on regex expression'],
            ['F', 'filter-dirs=',   'Filter directories based on regex expression'],
            ['r', 'recursive',      'Recurse into sub directories'],
            ['D', 'download',       'Download changed or missing files from destination to source'],
            ['U', 'upload',         'Upload changed or missing files from source to destination'],
            ['G', 'flatten',        'Flatten the directory structure'],
            ['l', 'less',           'Show less console output'],
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

    if (_p.version)
        return Log(fmeld.__info__.version);

    if (_p.help)
        return Log(_p.help);

    // Build commands
    _p.cmds = [];
    for (let v of _p['*'].slice(2))
        _p.cmds.push(v);

    if (!_p.source)
        throw(`Source location not specified`);

    // Connect source
    _p.src = fmeld.getConnection(_p.source, _p['source-cred'], _p);
    _p.src.connect().then((r) => { nextCommand(_p, true); })
                    .catch((e)=> { Log(e); quit(_p); });

    // Connect the destination if any
    if (_p.dest)
    {   _p.dst = fmeld.getConnection(_p.dest, _p['dest-cred'], _p);
        _p.dst.connect().then((r) => { nextCommand(_p, true); })
                        .catch((e)=> { Log(e); quit(_p); });
    }
}

// Exit handling
process.on('exit', function() {});
process.on('SIGINT', function() { Log('~ keyboard ~'); process.exit(-1); });
process.on('uncaughtException', function(e) { Log('~ uncaught ~', e); process.exit(-1); });

// Run the program
main();


