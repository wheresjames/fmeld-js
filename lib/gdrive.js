#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
var Log = console.log;

/** gdriveClient()

    Provides google cloud storage functionality

    https://www.npmjs.com/package/googleapis
    https://developers.google.com/oauthplayground/
    https://developers.google.com/drive/api/v3/quickstart/nodejs
    https://developers.google.com/workspace/guides/create-credentials
    https://github.com/googleapis/google-api-nodejs-client#google-apis-nodejs-client
    https://stackoverflow.com/questions/19335503/keep-getting-a-daily-limit-for-unauthenticated-use-exceeded-continued-use-requ
    https://developers.google.com/drive/api/v3/about-auth
    https://developers.google.com/drive/api/v3/reference/query-ref
*/
module.exports = function gdriveClient(args, opts)
{
    const {google} = require('googleapis');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    // Default path
    if (!args.path)
        args.path = "/";

    args.prefix = `gdrive://`

    // Must have credential file
    let credentials = null;
    if (!args.cred || !fs.existsSync(args.cred) || !fs.lstatSync(args.cred).isFile())
        throw `Credentials not provided for : ${args.prefix}`;

    // Read in the credentials
    try { credentials = JSON.parse(fs.readFileSync(args.cred)); }
    catch(e) {throw `Invalid credentials file : ${args.cred}\r\n${e}`}

    let tokenFile = args.cred + '.token.json';
    let gDrive = null;
    let bConnected = false;

    // https://developers.google.com/identity/protocols/oauth2/scopes
    let scopes = opts.readonly ? ['https://www.googleapis.com/auth/drive.readonly']
                               : ['https://www.googleapis.com/auth/drive'];

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

    /** Get access token
        @param [in] oAuth2Client    -   OAuth 2 Client object
    */
    function getAccessToken()
    {
        return new Promise((resolve, reject) =>
        {
            const {client_secret, client_id, redirect_uris} = credentials.installed;
            let oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

            // Do we have a cached token?
            if (!opts.uncached && tokenFile && fs.existsSync(tokenFile))
            {   try
                {   let tokenData = JSON.parse(fs.readFileSync(tokenFile));
                    if (tokenData)
                        oAuth2Client.setCredentials(tokenData);
                    return resolve(oAuth2Client);
                }
                catch(e) { if (opts.verbose) Log(e); }
            }

            // // Let's try and get another token
            const authUrl = oAuth2Client.generateAuthUrl({access_type: 'offline', scope: scopes});
            Log(`\r\n--- AUTHORIZE GOOGLE DRIVE BY VISITING THIS URL ---\r\n\r\n${authUrl}\r\n`);

            const readline = require('readline');
            const rl = readline.createInterface({input: process.stdin, output: process.stdout});
            rl.question('Enter the code from that page here: ', (code) =>
            {
                rl.close();
                oAuth2Client.getToken(code, (err, token) =>
                {
                    if (err)
                        return reject(`Token failed: ${err}`);

                    fs.writeFile(tokenFile, JSON.stringify(token), (err) =>
                    {   if (err)
                            Log(err);
                    });
                    oAuth2Client.setCredentials(token);
                    return resolve(oAuth2Client);
                });
            });
        });
    }

    /// Connects to the sftp server
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close();

            if (opts.verbose)
                Log(`Connecting to : ${args.prefix}`);

            // Get an access token
            return getAccessToken()
                        .then(auth =>
                        {   try
                            {   gDrive = google.drive({version: 'v3', auth});
                                if (!gDrive)
                                    return reject(`Failed to get google drive oject`);
                                bConnected = true;
                                return resolve(true);
                            } catch(e) { reject(e); }
                        })
                        .catch(e => { reject(e); });
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

            if (gDrive)
                gDrive = null;

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
        let isDir = item.mimeType && item.mimeType == "application/vnd.google-apps.folder";
        fl.push({
            id: item.id,
            name: item.name,
            path: dir,
            full: path.join(dir, item.name),
            isDir: isDir,
            isFile: !isDir,
            mode: 0,
            size: item.size ? parseInt(item.size) : 0,
            atime: 0,
            mtime: item.modifiedTime ? (new Date(item.modifiedTime).getTime()/1000) : 0,
            ctime: item.createdTime ? (new Date(item.createdTime).getTime()/1000) : 0,
            md5: item.md5Checksum ? item.md5Checksum : '',
            mime: item.mimeType ? item.mimeType : ''
        });
    }

    /**
        @param [in] id  - File id
        @param [in] acc - Accumulated file list
        @param [in] nt  - Next page token

        File types: https://developers.google.com/drive/api/v3/reference/files
    */
    function accFiles(id, acc=[], nt=null)
    {
        return new Promise((resolve, reject) =>
        {
            // https://developers.google.com/drive/api/v3/reference/files/list
            let q = {
                        pageSize: 1000,
                        orderBy: "name",
                        spaces: 'drive',
                        includeRemoved: false,
                        // fields: 'nextPageToken, files(*)',
                        fields: 'nextPageToken, files(id, name, size, parents, createdTime, modifiedTime, mimeType, md5Checksum)',
                    };

            if (nt)
                q.pageToken = nt;

            else
            {   id = id.replace(/([^'\\]*(?:\\.[^'\\]*)*)'/g, "$1\\'");
                q.q = `'${id}' in parents and trashed=false`;
            }

            gDrive.files.list(q, (err, res) =>
                {
                    if (err)
                        return reject(err);

                    if (!res || !res.data || !res.data.files)
                    {   if (this.opts.verbose)
                            Log(res);
                        return reject(`Invalid response finding : ${dir}`);
                    }

                    for (let k in res.data.files)
                        if (!res.data.files[k].trashed)
                            acc.push(res.data.files[k]);

                    if (res.data.nextPageToken)
                        return resolve(accFiles(null, acc, res.data.nextPageToken));

                    return resolve(acc);
                });
        });
    }

    /** Get a list of files in the specified directory
        @param [in] dir     - Directory path
    */
    function getFileList(dir, find=null, id=null)
    {
        if (null === find)
            find = String(dir).split('/');

        if (null === id)
            id = 'root';

        return accFiles(id)
            .then(r =>
            {
                let next = null;
                while (!next && 0 < find.length)
                    next = find.shift();

                if (!next)
                    return r;

                for (let k in r)
                    if (r[k].name === next)
                        return getFileList(dir, find, r[k].id);

                throw `Not found: ${dir}`;
            });
    }

    /** Get information about an item
        @param [in] item        - Path to item
        @param [in] opts        - Options
                                    recursive   : True to recurse search to sub folders
                                    create      : True if path should be created
    */
    function getItemInfo(item, opts={recursive:true}, parentId=null, find=null)
    {
        if (null === find)
            find = String(item).split('/');

        if (null === parentId)
            parentId = 'root';

        let next = null;
        while (!next && 0 < find.length)
            next = find.shift();

        if (!next)
            return Promise.reject(`Not found: ${item}`);

        return new Promise((resolve, reject) =>
        {
            let q = `name='${next.replace(/([^'\\]*(?:\\.[^'\\]*)*)'/g, "$1\\'")}' and trashed=false`;
            if (parentId)
                q += ` and '${parentId}' in parents`;

            let req = {   q: q,
                    pageSize: 1,
                    orderBy: "name",
                    spaces: 'drive',
                    includeRemoved: false,
                    fields: 'nextPageToken, files(id, name, size, parents, createdTime, modifiedTime, mimeType, md5Checksum)',
                };

            gDrive.files.list(req, (err, res) =>
            {
                if (err)
                    return reject(err);

                // Return the item info if we found it
                if (res && res.data && res.data.files && 0 < res.data.files.length)
                {   let r = res.data.files[0];
                    if (!find.length)
                        return resolve(r);
                    return resolve(getItemInfo(item, opts, r.id, find));
                }

                // Punt if not creating
                if (!opts.create)
                    return reject(`Not found: ${item}`);

                // Create mutiple sub folders?
                if (!opts.recursive && 0 < find.length)
                    return reject(`"recursive" flag not set, not creating deep path: ${item}`);

                // Create the path at this point
                gDrive.files.create(
                    {   resource:
                        {   name: next,
                            parents: parentId && 'root' != parentId ? [parentId] : [],
                            mimeType: 'application/vnd.google-apps.folder',
                        },
                        fields: 'id, name, size, parents, createdTime, modifiedTime, mimeType, md5Checksum'
                    })
                    .then(r =>
                    {   if (!find.length)
                            return resolve(r.data);
                        return resolve(getItemInfo(item, opts, r.data.id, find));
                    });
            });

        });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        if (!gDrive)
            return reject('No connection');

        // Get the file list
        return getFileList(dir)
            .then(r =>
            {   let fl = [];
                if (r && r.length)
                    r.map(v => { convertItems(dir, fl, v); });
                return fl;
            });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] opts   - Options
                                recursive   : Create subdirectories as well
    */
    function mkDir(dir, opts={})
    {   return getItemInfo(dir, {...opts, create:true});
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {   return getItemInfo(file)
            .then(r =>
            {   if (!r || !r.id)
                    return Promise.resolve(true);
                return gDrive.files.delete({fileId: r.id});
            })
            .catch(e => {});
    }

    /** Deletes the specified directory
        @param [in] dir    - Directory to delete
        @param [in] opts   - Options
                                recursive   : Remove all subdirectories and files as well
    */
    function rmDir(dir, opts={})
    {   return getItemInfo(dir)
            .then(r =>
            {   if (!r || !r.id)
                    return Promise.resolve(true);
                return gDrive.files.delete({fileId: r.id});
            })
            .catch(e => {});
    }

    /** Creates a read stream for the specified file
        @param [in] file     - File to target
    */
    function createReadStream(file)
    {   return new Promise((resolve, reject) =>
        {   getItemInfo(file)
                .then(r =>
                {   gDrive.files.get(
                        {fileId: r.id, alt: 'media', includeRemoved: false},
                        {responseType: 'stream'},
                        (err, res) =>
                        {  if (err)
                                return reject(err);
                            return resolve(res.data);
                        });
                })
                .catch(e => { return reject(e); });
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file     - File to target
    */
    function createWriteStream(file)
    {
        let root = path.dirname(file);
        let name = path.basename(file);
        return rmFile(file)
            .then(r =>
            {   return getItemInfo(root)
                    .then(r =>
                        {
                            let parents = r && r.id ? [r.id] : [];
                            const tx = new stream.Transform(
                                {   transform(chunk, enc, cb)
                                    {   this.push(chunk);
                                        cb();
                                    }
                                });

                            // +++ Need to send the error from this function upstream somehow
                            gDrive.files.create({requestBody: {name, parents}, media: {body: tx}})
                                .then(r => {})
                                .catch(e => { Log(opts.verbose ? e : String(e)); });

                            return tx;
                        });
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
