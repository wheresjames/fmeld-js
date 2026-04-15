#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
var Log = console.log;

/** smbClient()

    Provides SMB/CIFS (Windows network share) functionality using SMB2.

    https://www.npmjs.com/package/@marsaud/smb2

    URL formats:
        smb://user:pass@server/share
        smb://user:pass@server/share/path/to/dir
        smb://domain;user:pass@server/share/path/to/dir

    The first path component after the host is the share name.
    Remaining path components are the path within the share.

    Example:
        smb://WORKGROUP;alice:s3cr3t@192.168.1.10/myshare/documents
*/
module.exports = function smbClient(args, opts)
{
    const SMB2 = require('../setup.js').requireBackend('@marsaud/smb2', 'smb://');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.host)
        throw `Host not provided for SMB connection`;

    // Split pathname into share name and sub-path
    // pathname is like /sharename/sub/path  or  /sharename
    const parts = (args.path || '/').split('/').filter(p => p.length);
    const shareName = parts.shift() || '';
    if (!shareName)
        throw `Share name not provided in SMB URL (e.g. smb://host/sharename/path)`;

    // UNC share path expected by @marsaud/smb2
    const uncShare = `\\\\${args.host}\\${shareName}`;

    // Sub-path within the share (may be empty → root of share)
    args.basePath = parts.length ? parts.join('\\') : '';
    args.path = parts.length ? `/${parts.join('/')}` : '/';

    args.prefix = `smb://${args.host}/${shareName}`;

    // Read password from credential file if provided
    if (args.cred && fs.existsSync(args.cred))
        args.pass = fs.readFileSync(args.cred, 'utf8').trim();

    // Parse optional domain from username (domain;user or DOMAIN\user)
    let domain = args.domain || 'WORKGROUP';
    let username = args.user || '';
    if (username.includes(';'))
    {   [domain, username] = username.split(';', 2); }
    else if (username.includes('\\'))
    {   [domain, username] = username.split('\\', 2); }

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

    /** Converts a POSIX-style path to the backslash style used internally by smb2
        @param [in] p   - Path string
    */
    function toSmbPath(p)
    {
        // Strip leading slash, convert forward slashes to backslashes
        return p.replace(/^\/+/, '').replace(/\//g, '\\');
    }

    function delay(ms)
    {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isDeletePendingError(err)
    {
        return !!(err && err.code === 'STATUS_DELETE_PENDING');
    }

    function refreshConnection()
    {
        return close().then(() => connect());
    }

    /// Connects to the SMB share
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close().then(() =>
            {
                if (opts.verbose)
                    Log(`Connecting to : ${uncShare}`);

                try
                {
                    client = new SMB2({
                        share    : uncShare,
                        domain   : domain,
                        username : username,
                        password : args.pass || '',
                        port     : args.port ? parseInt(args.port) : 445,
                        autoCloseTimeout: 0   // keep connection alive until close() is called
                    });
                    bConnected = true;
                    if (opts.verbose)
                        Log(`Connected to : ${uncShare}`);
                    resolve(true);
                }
                catch(e) { bConnected = false; reject(e); }
            }).catch(reject);
        });
    }

    /// Closes the SMB connection
    function close()
    {
        return new Promise((resolve, reject) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${uncShare}`);

            if (!client)
                return resolve(true);

            const current = client;
            client = null;

            try
            {
                current.disconnect((err) =>
                {
                    if (err)
                        return reject(err);
                    return resolve(true);
                });
            }
            catch(e) { return reject(e); }
        });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list (POSIX-style path)
    */
    function ls(dir)
    {
        return new Promise((resolve, reject) =>
        {
            if (!client)
                return reject('No connection');

            const smbDir = toSmbPath(dir);

            client.readdir(smbDir, {stats: true}, (err, entries) =>
            {
                if (err) return reject(err);

                entries = (entries || []).filter(v => v.name !== '.' && v.name !== '..');
                if (!entries.length)
                    return resolve([]);

                let fl = entries.reduce((out, entry) =>
                {
                    let isDir  = entry.isDirectory();
                    let mtime  = entry.mtime ? Math.floor(entry.mtime.getTime() / 1000) : 0;
                    let atime  = entry.atime ? Math.floor(entry.atime.getTime() / 1000) : 0;
                    let ctime  = entry.ctime ? Math.floor(entry.ctime.getTime() / 1000) : 0;

                    out.push({
                        name  : entry.name,
                        path  : dir,
                        full  : path.posix.join(dir, entry.name),
                        isDir,
                        isFile: !isDir,
                        mode  : 0,
                        size  : entry.size || 0,
                        atime,
                        mtime,
                        ctime
                    });
                    return out;
                }, []);

                resolve(fl);
            });
        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create (POSIX-style)
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
                client.mkdir(toSmbPath(dir), err =>
                {   // STATUS_OBJECT_NAME_COLLISION means it already exists — treat as success
                    if (err && err.code !== 'STATUS_OBJECT_NAME_COLLISION')
                        return reject(err);
                    resolve(true);
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
                built = built ? `${built}\\${part}` : part;
                return new Promise((resolve, reject) =>
                {   client.mkdir(built, err =>
                    {   if (err && err.code !== 'STATUS_OBJECT_NAME_COLLISION')
                            return reject(err);
                        resolve(true);
                    });
                });
            });
        }, Promise.resolve()).then(() => true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete (POSIX-style)
    */
    function rmFile(file)
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            if (opts.verbose)
                Log(`rmFile(${file})`);
            client.unlink(toSmbPath(file), err =>
            {   if (err && err.code !== 'STATUS_OBJECT_NAME_NOT_FOUND' && !isDeletePendingError(err))
                    return reject(err);
                resolve(true);
            });
        });
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete (POSIX-style)
        @param [in] o       - Options
                                recursive : Remove contents first
    */
    function rmDir(dir, o={})
    {
        if (opts.verbose)
            Log(`rmDir(${dir}, recursive=${o.recursive ? 'true' : 'false'})`);

        if (!o.recursive)
        {
            return new Promise((resolve, reject) =>
            {
                if (!client) return reject('No connection');
                client.rmdir(toSmbPath(dir), err =>
                {   if (err && err.code !== 'STATUS_OBJECT_NAME_NOT_FOUND' && !isDeletePendingError(err))
                        return reject(err);
                    resolve(true);
                });
            });
        }

        const retries = Number.isInteger(o.rmDirRetries) ? o.rmDirRetries : 20;
        const retryDelayMs = Number.isInteger(o.rmDirRetryDelayMs) ? o.rmDirRetryDelayMs : 250;

        function removeContents()
        {
            return ls(dir)
            .catch(err =>
            {
                if (err && (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || isDeletePendingError(err)))
                    return null;
                throw err;
            })
            .then(entries =>
            {
                if (!entries)
                    return true;

                if (opts.verbose)
                    Log(`rmDir contents(${dir}): ${entries.map(v => v.full).join(', ') || '<empty>'}`);

                return entries.reduce((promise, v) =>
                {
                    return promise.then(() =>
                        v.isDir ? rmDir(v.full, o) : rmFile(v.full)
                    );
                }, Promise.resolve());
            });
        }

        function removeWithRetry(remaining)
        {
            return removeContents()
                .then(() => refreshConnection())
                .then(() => rmDir(dir, {recursive: false}))
                .catch(err =>
                {
                    if (err && err.code === 'STATUS_OBJECT_NAME_NOT_FOUND')
                        return true;

                    if (isDeletePendingError(err))
                        return true;

                    if (err && err.code === 'STATUS_DIRECTORY_NOT_EMPTY' && 0 < remaining)
                        return delay(retryDelayMs).then(() => removeWithRetry(remaining - 1));

                    throw err;
                });
        }

        return removeWithRetry(retries);
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read (POSIX-style)
    */
    function createReadStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            try
            {
                client.readFile(toSmbPath(file), (err, data) =>
                {
                    if (err)
                        return reject(err);

                    let sent = false;
                    return resolve(new stream.Readable(
                    {
                        read()
                        {
                            if (!sent)
                            {
                                sent = true;
                                this.push(data);
                            }
                            this.push(null);
                        }
                    }));
                });
            }
            catch(e) { reject(e); }
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to write (POSIX-style)
    */
    function createWriteStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!client) return reject('No connection');
            try
            {
                let chunks = [];
                let ws = new stream.Writable(
                {
                    write(chunk, enc, callback)
                    {
                        chunks.push(Buffer.from(chunk));
                        callback();
                    }
                });

                ws.finalize = () =>
                {
                    return new Promise((resolveWrite, rejectWrite) =>
                    {
                        const target = toSmbPath(file);
                        client.unlink(target, (unlinkErr) =>
                        {
                            if (unlinkErr && unlinkErr.code !== 'STATUS_OBJECT_NAME_NOT_FOUND')
                                return rejectWrite(unlinkErr);

                            client.writeFile(target, Buffer.concat(chunks), (writeErr) =>
                            {
                                if (writeErr)
                                    return rejectWrite(writeErr);
                                return resolveWrite(true);
                            });
                        });
                    });
                };

                resolve(ws);
            }
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
