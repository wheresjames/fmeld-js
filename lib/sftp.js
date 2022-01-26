#!/usr/bin/env nodejs
'use strict';

const path = require('path');
var Log = console.log;

// https://www.npmjs.com/package/ssh2
// https://ourcodeworld.com/articles/read/133/how-to-create-a-sftp-client-with-node-js-ssh2-in-electron-framework
module.exports = function sftpClient(args, opts)
{
    const ssh2 = require('ssh2');

    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = "/";

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    let client = null;
    let sftp = null;
    let bConnected = false;

    function isConnected()
    {
        return bConnected;
    }

    function makePath(a=null)
    {
        return a ? path.join(args.path, a) : args.path;
    }

    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            if (opts.verbose)
                Log(`Connecting to : ${args.name}`);

            // Connect
            client = new ssh2.Client();
            client.on('ready', function()
            {
                if (opts.verbose)
                    Log(`Connected to : ${args.name}`);

                client.sftp(function(err, _sftp)
                {
                    if (err)
                        return reject(err);

                    if (opts.verbose)
                        Log(`sftp connected : ${args.name}`);

                    sftp = _sftp;
                    bConnected = true;
                    return resolve(sftp);
                });
            }).connect({
                host:       args.host,
                port:       args.port,
                username:   args.user,
                password:   args.pass
            });
        });
    }

    function close()
    {
        return new Promise((resolve, reject) =>
        {
            if (sftp)
                sftp.end(), sftp = null;

            if (!client)
                return reject('No connection');

            if (opts.verbose)
                Log(`Closing : ${args.name}`);

            client.end();
            client = null;
            bConnected = true;
            return resolve(true);
        });
    }

    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            if (!sftp)
                return reject('No connection');

            // if (opts.verbose)
            //     Log(`Listing : ${args.name} -> ${dir}`);

            sftp.readdir(String(dir), function(err, list)
            {
                if (err)
                    return reject(err);

                let fl = [];
                for (let k in list)
                {
                    let v = list[k];
                    let isDir = (v.attrs.mode & 0x4000) ? true : false;
                    // let isFile = (v.attrs.mode & 0x8000) ? true : false;
                    fl.push({
                            name: v.filename,
                            path: dir,
                            full: path.join(dir, v.filename),
                            isDir: isDir,
                            isFile: !isDir,
                            mode: (v.attrs && v.attrs.mode) ? v.attrs.mode : 0,
                            size: (v.attrs && v.attrs.size) ? v.attrs.size : 0,
                            atime: (v.attrs && v.attrs.atime) ? v.attrs.atime : 0,
                            mtime: (v.attrs && v.attrs.mtime) ? v.attrs.mtime : 0,
                            ctime: (v.attrs && v.attrs.ctime) ? v.attrs.ctime : 0
                        });
                }
                return resolve(fl);
            });
        });
    }

    function createReadStream(file)
    {
        return new Promise((resolve, reject) =>
        {   if (!sftp)
                return reject('No connection');
            try { return resolve(sftp.createReadStream(file));
            } catch(e) {return reject(e);}
        });
    }

    function createWriteStream(file)
    {
        return new Promise((resolve, reject) =>
        {   if (!sftp)
                return reject('No connection');
            try { return resolve(sftp.createWriteStream(file));
            } catch(e) {return reject(e);}

        });
    }

    // Export functions
    this.connect = connect;
    this.close = close;
    this.ls = ls;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
}
