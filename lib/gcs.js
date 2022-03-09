#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
var Log = console.log;

/** gcsClient()

    Provides google cloud storage functionality

    https://cloud.google.com/nodejs/docs/reference/storage/latest
    https://developers.google.com/workspace/guides/create-credentials
*/
module.exports = function gcsClient(args, opts)
{
    let {Storage} = require('@google-cloud/storage');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.host)
        throw `Bucket name not provided for GCS connection`;

    args.prefix = `gs://${args.host}`

    // Default path
    if (!args.path)
        args.path = "/";

    // Must have credential file
    let credentials = null;
    if (!args.cred || !fs.existsSync(args.cred) || !fs.lstatSync(args.cred).isFile())
        throw `Credentials not provided for : ${args.prefix}`;

    // Read in the credentials
    try { credentials = require(args.cred); }
    catch(e) {throw `Invalid credentials file : ${args.cred}\r\n${e}`}

    let storage = null;
    let bucket = null;
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
            close()
                .then(r =>
                {
                    if (opts.verbose)
                        Log(`Connecting to : ${args.prefix}`);

                    try
                    {   storage = new Storage({projectId: credentials.project_id, credentials: credentials});
                        bucket = storage.bucket(`gs://${args.host}`);
                        bConnected = true;
                        resolve(true);
                    } catch(e) { bConnected = false; reject(e); }
                });
        });
    }

    /// Cleanup resources
    function close()
    {
        return new Promise((resolve, reject) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${args.prefix}`);

            if (bucket)
                bucket = null;

            if (storage)
                storage = null;

            return resolve(true);
        });
    }

    /** Trim characters from start and end of string
        @param s    - String to trim
        @param ch   - Characters to trim
    */
    function trimStr(s, ch)
    {
        while (s.length && 0 <= ch.indexOf(s[0]))
            s = s.substring(1);
        while (s.length && 0 <= ch.indexOf(s[s.length-1]))
            s = s.substring(0, s.length-1);
        return s;
    }

    /** Convert file item data and add to list
        @param [in] fl      - File list
        @param [in] resp    - Result structure
    */
    function convertItems(fl, resp)
    {
        if (resp.prefixes)
            resp.prefixes.forEach((v, k) =>
            {
                if (0 >= v.length)
                    return;

                let isDir = '/' == v[v.length-1];
                let full = trimStr(v, '/');
                fl.push({
                    name: path.basename(full),
                    path: '/' + path.dirname(full),
                    full: '/' + full,
                    isDir: isDir,
                    isFile: !isDir,
                    mode: 0,
                    size: 0,
                    atime: 0,
                    mtime: 0,
                    ctime: 0
                });
            });

        if (resp.items)
            resp.items.forEach((v, k) =>
            {   fl.push({
                    name: path.basename(v.name),
                    path: '/' + path.dirname(v.name),
                    full: '/' + v.name,
                    isDir: false,
                    isFile: true,
                    mode: 0,
                    size: parseInt(v.size),
                    atime: 0,
                    mtime: new Date(v.updated).getTime() / 1000,
                    ctime: new Date(v.timeCreated).getTime() / 1000,
                    md5: v.md5Hash
                });
            });
    }

    /** Gets the next block of files and adds them to the list
        @param [in] nextSearch  - Next search token
        @param [in] fl          - File list to append items to
        @param [in] cb          - Function to be called once all files are processed
        @param [in] max         - Max iteration depth
    */
    function nextList(nextSearch, fl, cb, max = 100)
    {
        if (0 >= max || !nextSearch)
            return cb({list: fl});
        bucket.getFiles(nextSearch)
            .then(([files, next, resp]) =>
            {   convertItems(fl, resp);
                nextList(next, fl, cb, max-1);
            })
            .catch(err => { if (cb) cb({error: err}); cb = null; });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            if (!storage || !bucket)
                return reject('No connection');

            dir = trimStr(dir, '/');

            bucket.getFiles(
            {
                autoPaginate: false,
                delimiter: '/',
                prefix: dir + '/',
                maxResults: 1000
            })
            .then(([files, next, resp]) =>
            {
                let fl = [];
                convertItems(fl, resp);
                nextList(next, fl, (r) =>
                {   if (r.error)
                        return reject(r.error);
                    return resolve(fl);
                });
            })
            .catch(err => { reject(err); });
        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive   : Create subdirectories as well

        @note Directories are not supported in google cloud storage
    */
    function mkDir(dir, o={})
    {   return Promise.resolve(true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {   return new Promise((resolve, reject) =>
        {   if (!bucket)
                return reject('No connection');
            try { return resolve(bucket.file(trimStr(file, '/')).delete());
            } catch(e) {return reject(e);}
        });
    }

    /** Deletes the specified directory
        @param [in] dir    - Directory to delete
        @param [in] o       - Options

        @note Directories are not supported in google cloud storage
    */
    function rmDir(dir, o={})
    {   return Promise.resolve(true);
    }

    /** Creates a read stream for the specified file
        @param [in] file     - File to target
    */
    function createReadStream(file, o={})
    {   return new Promise((resolve, reject) =>
        {   if (!bucket)
                return reject('No connection');
            try { return resolve(bucket.file(trimStr(file, '/')).createReadStream());
            } catch(e) {return reject(e);}
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file     - File to target
    */
    function createWriteStream(file, o={})
    {   return new Promise((resolve, reject) =>
        {   if (!bucket)
                return reject('No connection');
            try { return resolve(bucket.file(trimStr(file, '/')).createWriteStream());
            } catch(e) {return reject(e);}
        });
    }

    // Export functions
    this.connect = connect;
    this.close = close;
    this.ls = ls;
    this.rmFile = rmFile;
    this.rmDir = rmDir;
    this.getPrefix = getPrefix;
    this.mkDir = mkDir;
    this.makePath = makePath;
    this.isConnected = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream = createWriteStream;
}
