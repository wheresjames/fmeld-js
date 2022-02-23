#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
var Log = console.log;

/** sftpClient()

    Provides sftp functionality

    https://www.npmjs.com/package/ssh2
    https://ourcodeworld.com/articles/read/133/how-to-create-a-sftp-client-with-node-js-ssh2-in-electron-framework
*/
module.exports = function sftpClient(args, opts)
{
    const ssh2 = require('ssh2');

    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = "/";

    if (!args.port)
        args.port = 22;

    args.prefix = `sftp://${args.host}:${args.port}`

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    // Read in password if file provided
    if (args.cred && fs.existsSync(args.cred))
        args.pass = fs.readFileSync(args.cred, 'utf8').trim();

    let client = null;
    let sftp = null;
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

    /// Connects to the sftp server
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close();

            if (opts.verbose)
                Log(`Connecting to : ${args.prefix}`);

            try
            {
                // Connect
                client = new ssh2.Client();
                client.on('ready', () =>
                {
                    if (opts.verbose)
                        Log(`Connected to : ${args.prefix}`);

                    client.sftp((err, _sftp) =>
                    {
                        if (err)
                            return reject(err);

                        if (opts.verbose)
                            Log(`sftp connected : ${args.prefix}`);

                        sftp = _sftp;
                        bConnected = true;
                        return resolve(sftp);
                    });
                })
                .on('error', (e) =>
                {   if (opts.verbose)
                        Log(e);
                    close();
                    return reject(e);
                })
                .connect({
                    host:       args.host,
                    port:       args.port,
                    username:   args.user,
                    password:   args.pass
                });
            } catch(e) { reject(e); }
        });
    }

    /// Disconnects the sftp server
    function close()
    {
        return new Promise((resolve, reject) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${args.prefix}`);

            if (sftp)
                sftp.end(), sftp = null;

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
        return new Promise((resolve, reject) =>
        {
            if (!sftp)
                return reject('No connection');

            // if (opts.verbose)
            //     Log(`Listing : ${args.prefix} -> ${dir}`);

            sftp.readdir(String(dir), (err, list) =>
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

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] opts    -  Options
                                recursive   : Create subdirectories as well
    */
    function mkDir(dir, opts={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            let dir_c = dir.replace(/([^"\\]*(?:\\.[^"\\]*)*)"/g, "$1\\\"");
            client.exec(opts.recursive ? `mkdir -p "${dir_c}"` : `mkdir "${dir}"`, (err, stream) =>
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
        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            let file_c = file.replace(/([^"\\]*(?:\\.[^"\\]*)*)"/g, "$1\\\"");
            client.exec(`rm "${file_c}"`, (err, stream) =>
            {   if (err)
                    return reject(err);
                return resolve(true);
            });
        });
    }


    /** Deletes the specified directory
        @param [in] dir    - Directory to delete
        @param [in] opts   - Options
                                recursive   : Remove all subdirectories and files as well
                                force       : Force operation
    */
    function rmDir(dir, opts={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            let flags = ''
            if (opts.recursive || opts.force)
                flags = '-' + (opts.recursive ? 'r' : '') + (opts.force ? 'f' : '');

            let dir_c = dir.replace(/([^"\\]*(?:\\.[^"\\]*)*)"/g, "$1\\\"");
            client.exec(`rm ${flags} "${dir_c}"`, (err, stream) =>
            {   if (err)
                    return reject(err);
                return resolve(true);
            });
        });
    }


    /** Creates a read stream for the specified file
        @param [in] dir     - File to target
    */
    function createReadStream(file)
    {
        return new Promise((resolve, reject) =>
        {   if (!sftp)
                return reject('No connection');
            try { return resolve(sftp.createReadStream(file));
            } catch(e) {return reject(e);}
        });
    }

    /** Creates a write stream for the specified file
        @param [in] dir     - File to target
    */
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
    this.getPrefix = getPrefix;
    this.mkDir = mkDir;
    this.rmFile = rmFile;
    this.rmDir = rmDir;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
}
