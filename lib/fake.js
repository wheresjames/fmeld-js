#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');

const sparen = require('sparen');
var Log = sparen.log;

module.exports = function fakeClient(args, opts)
{
    this.args = args;
    this.opts = opts;

    args.tree = args.path;
    args.path = '/';
    args.prefix = 'fake://';

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (opts.verbose)
        Log(`Fake file system : ${args.tree}`);

    // Build tree description
    let tdesc = [];
    let tp = args.tree.split('/');
    while (tp.length)
    {   if (tp[0])
        {   let m = tp[0].split('.');
            tdesc[tdesc.length] = {
                    dirs    : (0 < m.length) ? parseInt(m[0]) : 5,
                    files   : (1 < m.length) ? parseInt(m[1]) : 10,
                    flags   : (2 < m.length) ? m[2] : '',
                    blocksz : (3 < m.length) ? m[3] : 1024
                };

        }
        tp.shift();
    }

    // Default tree
    if (!tdesc.length)
        tdesc = [{dirs: 5, files: 10, flags: '', blocksz: 1024}];

    // Create root tree
    let t = new Date().getTime() / 1000;
    let tree = {
            name: '/',
            path: '/',
            full: '/',
            isFile: false,
            isDir: true,
            mode: 0x4000,
            size: 0,
            atime: t,
            mtime: t,
            ctime: t,
            subs: createBranch(tdesc)
        };


    /** Create a branch in the directory tree
        @param [in] td      - Tree description array
        @param [in] ti      - Current index in the tree description
        @param [in] tp      - Path to current branch
    */
    function createBranch(td, ti=0, tp='/')
    {
        if (ti >= td.length)
            return [];

        // Add sub directories
        let sub = [];
        for (let i = 0; i < td[ti].dirs; i++)
        {
            let name = `Dir-${i+1}`;
            let full = path.join(tp, name);
            let t = new Date().getTime() / 1000;
            sub.push({
                name: name,
                path: tp,
                full: full,
                isFile: false,
                isDir: true,
                mode: 0x4000,
                size: 0,
                atime: t,
                mtime: t,
                ctime: t,
                subs: createBranch(td, ti+1, full)
            });
        }

        // Add files
        for (let i = 0; i < td[ti].files; i++)
        {
            let fname = `File-${i+1}.txt`;
            let t = new Date().getTime() / 1000;
            sub.push({
                name: fname,
                path: tp,
                full: path.join(tp, fname),
                isFile: true,
                isDir: false,
                mode: 0x8000,
                size: td[ti].blocksz * i,
                atime: t,
                mtime: t,
                ctime: t
            });
        }

        return sub;
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

    function aCopy(a)
    {
        return JSON.parse(JSON.stringify(a))
    }

    function findItem(dir, root)
    {
        if (!Array.isArray(dir))
            dir = dir.split('/');

        // Skip current directory references
        while (dir.length && (!dir[0] || '.' == dir[0]))
            dir.shift();

        // Are we there?
        if (!dir.length)
            return aCopy(root);

        // Can we go deeper?
        if (!root.isDir || !root.subs)
            return null;

        // Search each sub item
        for (let k in root.subs)
            if (root.subs[k].name == dir[0])
            {   dir.shift();
                return findItem(dir, root.subs[k]);
            }

        return null;
    }

    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            let item = findItem(dir, tree);
            resolve((!item || !item.isDir || !item.subs) ? [] : item.subs);
        });
    }

    function mkdir(dir)
    {   return Promise.resolve(false);
    }

    function createReadStream(file)
    {
        let item = findItem(file, tree);
        if (!item)
            return null;

        let throttle = opts.throttle;
        if (!throttle)
            throttle = 0;
        let rs = new stream.Readable(
        {
            read()
            {
                let reader = this;
                let sendData = () =>
                {
                    let bsize = 1024;
                    let send = reader.totalBytes < bsize ? reader.totalBytes : bsize;

                    let tmpl = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n';
                    let data = reader.extraData;
                    while (data.length < send)
                        data = data + tmpl;
                    reader.extraData = data.slice(send);
                    data = data.slice(0, send);
                    reader.totalBytes -= send;
                    reader.push(data);

                    if (0 >= reader.totalBytes)
                    {   reader.push(null);
                        return;
                    }
                };

                if (0 < throttle)
                    setTimeout(sendData, throttle);
                else
                    sendData();
            },
            destroy()
            {
                Log('destroy()');
            }
        });
        rs.extraData = '';
        rs.totalBytes = item.size;
        return rs;
    }

    function createWriteStream(file)
    {   return Promise.resolve(null);
    }

    // Export functions
    this.connect = connect;
    this.close = close;
    this.ls = ls;
    this.mkdir = mkdir;
    this.getPrefix = getPrefix;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;

}
