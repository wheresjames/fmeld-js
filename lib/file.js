#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
var Log = console.log;

module.exports = function fileClient(args, opts)
{
    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = "/";

    args.prefix = 'file://';

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    function isConnected()
    {
        return true;
    }

    function getPrefix(p=null)
    {
        return p ? path.join(args.prefix, p) : args.prefix;
    }

    function makePath(a=null)
    {
        return a ? path.join(args.path, a) : args.path;
    }

    function connect()
    {
        return Promise.resolve(true);
    }

    function close()
    {
        return Promise.resolve(true);
    }

    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            fs.readdir(dir, (err, files) =>
            {
                if (err)
                    return reject(err);

                let fl = [];
                for (let k in files)
                {
                    let v = files[k];
                    let full = path.join(dir, v);
                    const stats = fs.lstatSync(full);
                    fl.push({
                            name: v,
                            path: dir,
                            full: full,
                            isFile: stats.isFile(),
                            isDir: stats.isDirectory(),
                            mode: (stats.mode) ? stats.mode : 0,
                            size: (stats.size) ? stats.size : 0,
                            atime: (stats.atimeMs) ? stats.atimeMs / 1000 : 0,
                            mtime: (stats.mtimeMs) ? stats.mtimeMs / 1000 : 0,
                            ctime: (stats.ctimeMs) ? stats.ctimeMs / 1000 : 0
                        });
                }
                return resolve(fl);
            });

        });
    }

    function mkdir(dir)
    {   return new Promise((resolve, reject) =>
        {   fs.mkdir(dir, {recursive: true}, (e, p) =>
            {
                if (e)
                    return reject(e);
                return resolve(p);
            });
        });
    }

    function createReadStream(file)
    {   return Promise.resolve(fs.createReadStream(file));
    }

    function createWriteStream(file)
    {   return Promise.resolve(fs.createWriteStream(file));
    }

    // Export functions
    this.connect = connect;
    this.close = close;
    this.ls = ls;
    this.getPrefix = getPrefix;
    this.mkdir = mkdir;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;

}
