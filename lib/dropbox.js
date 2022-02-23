#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
var Log = console.log;

/** dropboxClient()

    Provides google cloud storage functionality

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
    {   return JSON.stringify(err);
    }

    /// Connects to the sftp server
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close();

            if (opts.verbose)
                Log(`Connecting to : ${args.prefix}`);

            // Do we have a cached token?
            if (!opts.uncached && tokenFile && fs.existsSync(tokenFile))
            {   try
                {   let tokenData = JSON.parse(fs.readFileSync(tokenFile));
                    if (tokenData)
                    {
                        // Use cached token
                        try { dropBox = dropboxV2Api.authenticate({token: tokenData}); }
                        catch(e) { return reject(e); }

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
                                                    redirect_uri: credentials.redirect_uris[0]
                                                });
            const authUrl = db.generateAuthUrl();

            Log(`\r\n--- AUTHORIZE DROPBOX BY VISITING THIS URL ---\r\n\r\n${authUrl}\r\n`);

            const readline = require('readline');
            const rl = readline.createInterface({input: process.stdin, output: process.stdout});
            rl.question('Enter the code from that page here: ', (code) =>
            {
                rl.close();

                db.getToken(code, (err, result, response) =>
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
        @param [in] opts   - Options
                                recursive   : Create subdirectories as well
    */
    function mkDir(dir, opts={})
    {   return new Promise((resolve, reject) =>
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
    {   return new Promise((resolve, reject) =>
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
    {   return new Promise((resolve, reject) =>
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
        @param [in] file     - File to target
    */
    function createReadStream(file)
    {   return new Promise((resolve, reject) =>
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
        @param [in] file     - File to target
    */
    function createWriteStream(file)
    {   return new Promise((resolve, reject) =>
        {   if (!dropBox)
                return reject('No connection');
                let ws = dropBox({ resource: 'files/upload', parameters: { path: file } },
                                    (err, result, response) =>
                                    {   if (err)
                                            return reject(formatErr(err));
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
