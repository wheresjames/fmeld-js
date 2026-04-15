#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
var Log = console.log;

/** webdavClient()

    Provides WebDAV functionality (HTTP and HTTPS).

    Compatible with Nextcloud, ownCloud, most NAS devices (Synology, QNAP),
    and any other WebDAV-capable server.

    https://www.npmjs.com/package/webdav

    Credential file: plain-text password file, or pass user:pass in the URL.

    URL formats:
        webdav://user:pass@host/remote/path
        webdavs://user:pass@host/remote/path   (HTTPS)
        webdavs://user:pass@host:8443/remote/path
*/
module.exports = function webdavClient(args, opts)
{
    const { createClient } = require('../setup.js').requireBackend('webdav', 'webdav://');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.host)
        throw `Host not provided for WebDAV connection`;

    if (!args.path)
        args.path = '/';

    const protocol = args.secure ? 'https' : 'http';
    const portStr  = args.port ? `:${args.port}` : '';
    const baseUrl  = `${protocol}://${args.host}${portStr}`;
    const scheme   = args.secure ? 'webdavs' : 'webdav';
    args.prefix    = `${scheme}://${args.host}${portStr}`;

    // Read password from credential file if provided
    if (args.cred && fs.existsSync(args.cred))
        args.pass = fs.readFileSync(args.cred, 'utf8').trim();

    let client = null;
    let bConnected = false;

    /// Returns true if connected
    function isConnected()
    {
        return bConnected;
    }

    /** Returns the path prefix
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
        return a ? path.posix.join(args.path, a) : args.path;
    }

    /// Connects to the WebDAV server
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close().then(() =>
            {
                if (opts.verbose)
                    Log(`Connecting to : ${args.prefix}`);

                try
                {
                    let clientOpts = {};
                    if (args.user) clientOpts.username = args.user;
                    if (args.pass) clientOpts.password = args.pass;
                    client = createClient(baseUrl, clientOpts);
                    bConnected = true;
                    resolve(true);
                }
                catch(e) { bConnected = false; reject(e); }
            }).catch(reject);
        });
    }

    /// Closes the WebDAV connection
    function close()
    {
        return new Promise((resolve) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${args.prefix}`);

            client = null;
            resolve(true);
        });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            client.getDirectoryContents(dir)
                .then(items =>
                {
                    // Some servers return the queried directory itself as the first entry — filter it
                    const normalDir = dir.replace(/\/$/, '') || '/';
                    let fl = items
                        .filter(v =>
                        {   const f = (v.filename || '').replace(/\/$/, '') || '/';
                            return f !== normalDir;
                        })
                        .map(v =>
                        {
                            let isDir = v.type === 'directory';
                            let mtime = v.lastmod ? new Date(v.lastmod).getTime() / 1000 : 0;
                            let name  = v.basename || path.posix.basename(v.filename);
                            return {
                                name,
                                path  : dir,
                                full  : path.posix.join(dir, name),
                                isDir,
                                isFile: !isDir,
                                mode  : 0,
                                size  : v.size || 0,
                                atime : mtime,
                                mtime,
                                ctime : mtime
                            };
                        });
                    resolve(fl);
                })
                .catch(e => reject(e));
        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive : Create parent directories as needed
    */
    function mkDir(dir, o={})
    {
        if (!o.recursive)
        {
            return new Promise((resolve, reject) =>
            {
                if (!client) return reject('No connection');
                client.createDirectory(dir)
                    .then(() => resolve(true))
                    .catch(e =>
                    {   // 405 Method Not Allowed or 409 Conflict usually means directory exists
                        if (e.status === 405 || e.status === 409)
                            return resolve(true);
                        reject(e);
                    });
            });
        }

        // Recursive: create each path component in sequence
        const parts = dir.split('/').filter(p => p.length);
        let built = '';
        return parts.reduce((promise, part) =>
        {
            return promise.then(() =>
            {
                if (!client) throw 'No connection';
                built += '/' + part;
                return client.createDirectory(built).catch(() => { /* ignore if exists */ });
            });
        }, Promise.resolve()).then(() => true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            client.deleteFile(file)
                .then(() => resolve(true))
                .catch(e =>
                {   if (e.status === 404) return resolve(true);
                    reject(e);
                });
        });
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
    */
    function rmDir(dir, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            // WebDAV DELETE removes collections recursively by default
            client.deleteFile(dir)
                .then(() => resolve(true))
                .catch(e =>
                {   if (e.status === 404) return resolve(true);
                    reject(e);
                });
        });
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read
    */
    function createReadStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            try { resolve(client.createReadStream(file)); }
            catch(e) { reject(e); }
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to write
    */
    function createWriteStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            try { resolve(client.createWriteStream(file)); }
            catch(e) { reject(e); }
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
