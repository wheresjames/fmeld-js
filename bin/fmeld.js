#!/usr/bin/env node
'use strict'

const fs = require('fs');
const path = require('path');
const fmeld = require('fmeld');
var Log = console.log;

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
    {   if(!_p.src)
            throw `Command requires destination : ${cmd}`;
        if (!_p.dst.isConnected())
        {   _p.cmds.unshift(cmd);
            Log(`Waiting for destination connection : ${_p.dst.args.name}`);
            return false;
        }
    }
    return true;
}

function nextCommand(_p)
{
    if ( 1 > _p.cmds.length)
        quit(_p);

    else
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
                                Log(`${v.full} (${v.size})`);

                        nextCommand(_p);
                    })
                    .catch((e)=>{ Log(e); nextCommand(_p); });
                break;

            case 'cp':
                if (!isReady(_p, cmd, true, true))
                    return;

                // Copy the directory
                fmeld.copyDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(), {recursive: true}, fmeld.stdoutProgress)
                    .then((r) => { nextCommand(_p); })
                    .catch((e)=>{ Log(e); nextCommand(_p); });

                break;

            case 'sync':
                if (!isReady(_p, cmd, true, true))
                    return;

                // Copy the directory
                fmeld.syncDir(_p.src, _p.dst, _p.src.makePath(), _p.dst.makePath(),
                              {recursive: true, compare: 'size'}, fmeld.stdoutProgress)
                    .then((r) => { nextCommand(_p); })
                    .catch((e)=>{ Log(e); nextCommand(_p); });

                break;

            default:
                throw `Unknown command ${cmd}`;
        }
    }
}

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

function main()
{
    // Parse command line
    let _p = fmeld.__config__.parseParams('fmeld [options] [commands ...]', process.argv,
        [   ['s', 'source=',    'Source URL'],
            ['d', 'dest=',      'Destination URL'],
            ['v', 'version',    'Show version'],
            ['V', 'verbose',    'Verbose logging']
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
    _p.src = fmeld.getConnection(_p.source, _p);
    _p.src.connect().then((r) => { nextCommand(_p); })
                    .catch((e)=> { Log(e); quit(_p); });

    // Connect the destination if any
    if (_p.dest)
    {   _p.dst = fmeld.getConnection(_p.dest, _p);
        _p.dst.connect().then((r) => { nextCommand(_p); })
                        .catch((e)=> { Log(e); quit(_p); });
    }

}

// Exit handling
process.on('exit', function() {});
process.on('SIGINT', function() { Log('~ keyboard ~'); process.exit(-1); });
process.on('uncaughtException', function(e) { Log('~ uncaught ~', e); process.exit(-1); });

// Run the program
main();


