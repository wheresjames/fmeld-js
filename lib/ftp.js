#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
var Log = console.log;

/** ftpClient()

    Provides ftp functionality.

    https://www.npmjs.com/package/ftp
*/

module.exports = function ftpClient(args, opts)
{
    const ftp = require('ftp');

    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = "/";

    if (!args.port)
        args.port = 21;

    args.prefix = `ftp://${args.host}:${args.port}`

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    // Read in password if file provided
    if (args.cred && fs.existsSync(args.cred))
        args.pass = fs.readFileSync(args.cred, 'utf8').trim();

    let client = null;
    let bConnected = false;

    /// Returns true if connected
    function isConnected()
    {
        return bConnected;
    }

    /** returns the path prefix
        @param [in] p   - Optional path to append to prefix
    */
    function getPrefix(p=null)
    {
        return (p && p.length) ? (args.prefix + ('/' == p[0] ? '' : '/') + p) : args.prefix;
    }

    /** Returns the path portion from the url
        @param [in] a   - Optional path to append
    */
    function makePath(a=null)
    {
        return a ? path.join(args.path, a) : args.path;
    }

    /// Connects to server
    function connect()
    {
        if (opts.verbose)
            Log(`connect()`);

        return new Promise((resolve, reject) =>
        {
            close()
                .then(r=>
                {
                    if (opts.verbose)
                        Log(`Connecting to : ${args.prefix}`);

                    // Connect
                    client = new ftp();
                    client.on('ready', () =>
                    {
                        if (opts.verbose)
                            Log(`Connected to : ${args.prefix}`);

                        bConnected = true;
                        return resolve(true);
                    })
                    .on('error', (e) =>
                    {   if (opts.verbose)
                            Log(e);
                        close()
                            .then(r => { return reject(e); });
                    })
                    .connect({
                        host        : args.host,
                        port        : args.port,
                        user        : args.user,
                        password    : args.pass
                    });
                });
        });
    }

    /// Disconnects the sftp server
    function close()
    {
        if (opts.verbose)
            Log(`close()`);

        return new Promise((resolve, reject) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${args.prefix}`);

            if (client)
                client.end(), client = null;

            return resolve(true);
        });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        if (opts.verbose)
            Log(`ls(${dir})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            client.list(String(dir), (err, list) =>
            {
                if (err)
                    return reject(err);

                let fl = [];
                for (let k in list)
                {
                    let v = list[k];
                    if (!v.name)
                        continue;

                    let isDir = ("d" == v.type) ? true : false;
                    let isFile = !isDir;
                    let t = v.date ? (new Date(v.date).getTime()/1000) : 0;
                    fl.push({
                            name: v.name,
                            path: dir,
                            full: path.join(dir, v.name),
                            isDir: isDir,
                            isFile: isFile,
                            mode: 0,
                            size: (v.size) ? v.size : 0,
                            atime: t,
                            mtime: t,
                            ctime: t
                        });
                }

                resolve(fl);
            });

        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive   : Create subdirectories as well
    */
    function mkDir(dir, o={})
    {
        if (opts.verbose)
            Log(`mkDir(${dir})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            client.mkdir(dir, o.recursive ? true : false, (err) =>
            {   if (err)
                    return reject(err);
                return resolve(true);
            });
        });
    }


    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {
        if (opts.verbose)
            Log(`rmDir(${dir})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            client.delete(dir, (err) =>
            {   if (err)
                    return reject(err);
                return resolve(true);
            });
        });
    }


    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
    */
    function rmDir(dir, o={})
    {
        if (opts.verbose)
            Log(`rmDir(${dir})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            client.rmdir(dir, o.recursive ? true : false, (err) =>
            {   if (err)
                    return reject(err);
                return resolve(true);
            });
        });
    }


    /** Creates a read stream for the specified file
        @param [in] dir     - File to target
    */
    function createReadStream(file, o={})
    {
        if (opts.verbose)
            Log(`createReadStream(${file})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            try
            {   client.get(file, function (err, stream)
                {   if (err)
                        reject(err);
                    resolve(stream);
                });
            } catch(e) {return reject(e);}
        });
    }


    /** Creates a write stream for the specified file
        @param [in] dir     - File to target

        https://nodejs.org/api/stream.html
    */
    function createWriteStream(file, o={})
    {
        if (opts.verbose)
            Log(`createWriteStream(${file})`);

        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            try
            {
                const tx = new stream.Transform(
                    {   transform(chunk, enc, cb)
                        {   this.push(chunk);
                            cb();
                        }
                    });

                client.put(tx, file, function (err)
                {   if (err)
                        return reject(err);
                });
                return resolve(tx);

            } catch(e) { return reject(e); }
        });
    }


    // Export functions
    this.connect = connect;
    this.close = close;
    this.ls = ls;
    this.getPrefix = getPrefix;
    this.mkDir = mkDir;
    this.rmFile = rmFile;
    this.rmDir = rmDir;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
}
