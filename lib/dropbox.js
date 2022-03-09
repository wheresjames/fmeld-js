#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const auth = require('./auth.js');

var Log = console.log;


/** dropboxClient()

    Provides Dropbox functionality

    https://www.dropbox.com/developers
    https://www.npmjs.com/package/dropbox
    https://developers.dropbox.com/oauth-guide
    https://github.com/dropbox/dropbox-sdk-js/tree/main/examples
    https://dropbox.github.io/dropbox-sdk-js/Dropbox.html
    https://www.npmjs.com/package/dropbox-v2-api
*/
module.exports = function dropboxClient(args, opts)
{
    const dropboxV2Api = require('dropbox-v2-api');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    // Default path
    if (!args.path)
        args.path = "/";

    args.prefix = `dropbox://`

    // Must have credential file
    let credentials = null;
    if (!args.cred || !fs.existsSync(args.cred) || !fs.lstatSync(args.cred).isFile())
        throw `Credentials not provided for : ${args.prefix}`;

    // Read in the credentials
    try { credentials = JSON.parse(fs.readFileSync(args.cred)); }
    catch(e) { throw `Invalid credentials file : ${args.cred}\r\n${e}` }

    // Ensure client id and redirect url
    if (!credentials.client_id || !credentials.redirect_uris)
        throw `Invalid credentials file : ${args.cred}\r\n${e}`;

    let tokenFile = args.cred + '.token.json';
    let dropBox = null;
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

    /** Formats crazy errors returned by lib
        @param [in] err     - Error object
    */
    function formatErr(err)
    {   return opts.verbose ? err : JSON.stringify(err);
    }

    /// Connects to the sftp server
    function connect()
    {
        if (opts.verbose)
            Log(`connect()`);

        return new Promise((resolve, reject) =>
        {
            close()
                .then(r =>
                {
                    if (opts.verbose)
                        Log(`Connecting to : ${args.prefix}`);

                    // Do we have a cached token?
                    if (!opts.uncached && tokenFile && fs.existsSync(tokenFile))
                    {   try
                        {   let tokenData = JSON.parse(fs.readFileSync(tokenFile));
                            if (tokenData)
                            {
                                // Use cached token
                                dropBox = dropboxV2Api.authenticate({token: tokenData});

                                if (dropBox)
                                {   bConnected = true;
                                    return resolve(true);
                                }
                            }
                        }
                        catch(e) { if (opts.verbose) Log(e); }
                    }

                    const db = dropboxV2Api.authenticate({
                                                            client_id: credentials.client_id,
                                                            client_secret: credentials.client_secret,
                                                            // redirect_uri: credentials.redirect_uris[0]
                                                            redirect_uri: `http://localhost:${opts.authport}`
                                                        });
                    const authUrl = db.generateAuthUrl();

                    Log(`\r\n--- AUTHORIZE DROPBOX BY VISITING THIS URL ---\r\n\r\n${authUrl}\r\n`);
                    return auth.getAuthCode(opts.authport)
                        .then(r =>
                        {
                            Log(`${JSON.stringify(r)}\r\n`);
                            if (!r.code)
                                return reject(`Bad code in : ${r}`);

                            db.getToken(r.code, (err, result, response) =>
                            {
                                if (err)
                                    return reject(formatErr(err));

                                let tokenData = result.access_token;
                                dropBox = dropboxV2Api.authenticate({token: tokenData});
                                if (dropBox)
                                {   bConnected = true;
                                    fs.writeFile(tokenFile, JSON.stringify(tokenData), (err) =>
                                    {   if (err)
                                            Log(err);
                                    });
                                    return resolve(true);
                                }
                            });
                        });
                });
        });
    }

    /// Cleanup resources
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

            if (dropBox)
                dropBox = null;

            return resolve(true);
        });
    }

    /** Convert file item data and add to list
        @param [in] dir     - Direcory root
        @param [in] fl      - File list
        @param [in] item    - File item
    */
    function convertItems(dir, fl, item)
    {
        let isDir = (item['.tag'] && item['.tag'] == 'folder') ? true : false;
        fl.push({
            id: item.id,
            name: item.name,
            path: dir,
            full: item.path_display ? item.path_display : path.join(dir, item.name),
            isDir: isDir,
            isFile: !isDir,
            mode: 0,
            size: item.size ? parseInt(item.size) : 0,
            atime: 0,
            mtime: item.server_modified ? (new Date(item.server_modified).getTime()/1000) : 0,
            ctime: item.client_modified ? (new Date(item.client_modified).getTime()/1000) : 0
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
            if (!dropBox)
                return reject('No connection');

            if (dir == '/')
                dir = '';

            dropBox({
                resource: 'files/list_folder',
                parameters: {
                    path                                : dir,
                    recursive                           : false,
                    include_media_info                  : false,
                    include_deleted                     : false,
                    include_has_explicit_shared_members : false,
                    include_mounted_folders             : true,
                    include_non_downloadable_files      : true
                }
            }, (err, res, response) =>
            {
                if (err)
                    return reject(formatErr(err));

                let fl = [];
                if (res && res.entries)
                    res.entries.map(v => { convertItems(dir, fl, v); });
                return resolve(fl);
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
        {   if (!dropBox)
                return reject('No connection');
            dropBox({ resource: 'files/create_folder', parameters: {path: dir, autorename: false} },
                    (err, result, response) =>
                    {   if (err && (!err.error || !err.error.path || 'conflict' != err.error.path['.tag'] ))
                            return reject(formatErr(err));
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
            Log(`rmFile(${file})`);

        return new Promise((resolve, reject) =>
        {   if (!dropBox)
                return reject('No connection');
            dropBox({ resource: 'files/delete', parameters: {path: file} },
                    (err, result, response) =>
                    {   if (err)
                            return reject(formatErr(err));
                        return resolve(true);
                    });
        });
    }

    /** Deletes the specified directory
        @param [in] dir    - Directory to delete
        @param [in] opts   - Options
                                recursive   : Remove all subdirectories and files as well
    */
    function rmDir(dir, opts={})
    {
        if (opts.verbose)
            Log(`rmDir(${dir})`);

        return new Promise((resolve, reject) =>
        {   if (!dropBox)
                return reject('No connection');
            dropBox({ resource: 'files/delete', parameters: {path: dir} },
                    (err, result, response) =>
                    {   if (err)
                            return reject(formatErr(err));
                        return resolve(true);
                    });
        });
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to target
        @param [in] o       - Options
    */
    function createReadStream(file, o={})
    {
        if (opts.verbose)
            Log(`createReadStream(${file})`);

        return new Promise((resolve, reject) =>
        {   if (!dropBox)
                return reject('No connection');
            let rs = dropBox({ resource: 'files/download', parameters: { path: file } },
                                (err, result, response) =>
                                {   if (err)
                                        return reject(formatErr(err));
                                });
            return resolve(rs);
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to target
        @param [in] o       - Options
                                expectedSize: Expected file size
    */
    function createWriteStream(file, o={})
    {
        if (opts.verbose)
            Log(`createWriteStream(${file})`);

        return new Promise((resolve, reject) =>
        {
            if (!dropBox)
                return reject('No connection');

            // Use single stream for sizes below 100MB
            const maxStreamSize = 100000000;
            if (!o.expectedSize || maxStreamSize >= o.expectedSize)
            {
                let ws = dropBox({ resource: 'files/upload', parameters: { path: file } },
                                    (err, result, response) =>
                                    {  if (err)
                                            return reject(formatErr(err));
                                        Log(`Upload finished ${file}`);
                                    });

                // Obviously, this shouldn't be needed, but I'm getting an error without it
                //    Error: You cannot pipe to this stream after the outbound request has started.
                const tx = new stream.Transform(
                    {   transform(chunk, enc, cb)
                        {   this.push(chunk);
                            cb();
                        }
                    });
                tx.pipe(ws);

                return resolve(tx);
            }

            // Use session based upload if over 100MB
            // +++ It's late, clean this up
            // https://stackoverflow.com/questions/35437744/nodejs-streaming-readable-writable-misunderstood

            const maxBuf = 16;
            const buf = [];
            let dbs = null;
            let sessionId = 0;
            let totalCopied = 0, currentBlock = 0;
            let rs = new stream.Readable({ read(){} });
            let writeNext = null;
            let writeEnd = false;
            let finalizePromise = null;

            // Finalize the file on dropbox
            function sendEnd()
            {
                dropBox({
                    resource: 'files/upload_session/finish',
                    parameters:
                    {   cursor: { session_id: sessionId, offset: totalCopied },
                        commit: { path: file, mode: "add", autorename: true, mute: false }
                    }
                }, (err, result, response) => {
                    if (finalizePromise)
                        err ? finalizePromise.reject(err) : finalizePromise.resolve(true);
                });
            }

            // Process data from the buffer
            function processBuf()
            {
                while (rs && 0 < buf.length)
                {
                    let chunk = buf.pop();

                    if (chunk && chunk.length)
                    {   rs.push(chunk);
                        totalCopied += chunk.length;
                        currentBlock += chunk.length;
                    }
                    else
                        writeEnd = true;

                    if (!chunk || !chunk.length || maxStreamSize < currentBlock)
                    {   currentBlock = 0;
                        rs.push(null);
                        rs = null;
                    }
                }
            }

            // Create a write stream
            const ws = new stream.Writable(
            {
                write(chunk, enc, next)
                {
                    buf.unshift(chunk);

                    processBuf();

                    // Are we full?
                    if (!rs && maxBuf <= buf.length)
                    {   writeNext = next;
                        return false;
                    }

                    next();
                    return true;
                },
                abort(e)
                {
                    Log('abort()', e);
                    throw e;
                }
            });

            // Called when all data has been written to the write stream
            ws.finalize = () =>
            {   return new Promise((resolve, reject) =>
                {   finalizePromise = {resolve, reject};
                    writeEnd = true;
                    if (rs && 0 >= buf.length)
                        rs.push(null);
                    else
                        buf.unshift(null);
                });
            };

            // Upload next block
            function nextBlock()
            {
                rs = new stream.Readable({ read(){} });

                dbs = dropBox(
                    {   resource: 'files/upload_session/append',
                        parameters: { cursor: { session_id: sessionId, offset: totalCopied }, close: false },
                        readStream: rs
                    },
                    (err, result, response) =>
                    {
                        if (err)
                            throw err;

                        if (writeEnd)
                            sendEnd();
                        else
                            nextBlock();
                    });

                processBuf();

                if (writeNext)
                {   let next = writeNext;
                    writeNext = null;
                    next();
                }
            }

            // Initialize upload
            dbs = dropBox(
                {   resource: 'files/upload_session/start',
                    parameters: {close: false},
                    readStream: rs
                },
                (err, result, response) =>
                {   if (err)
                        return reject(formatErr(err));
                    sessionId = result.session_id;
                    if (writeEnd)
                        sendEnd();
                    else
                        nextBlock();
                });

            return resolve(ws);
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
