#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
var Log = console.log;

/** boxClient()

    Provides Box.com cloud storage functionality.

    Credential file formats accepted:
      1. Box JWT app config JSON — downloaded from the Box Developer Console
         (contains a "boxAppSettings" key).  Use a service account / app user.
      2. Simple token file — { "client_id": "...", "client_secret": "...", "token": "..." }
         A developer token works here; it expires after 60 minutes.

    URL: box://folder/path  or  box:///path  (host is ignored, path is the root)

    https://www.npmjs.com/package/box-node-sdk
    https://developer.box.com/reference/
*/
module.exports = function boxClient(args, opts)
{
    const BoxSDK = require('../setup.js').requireBackend('box-node-sdk', 'box://');

    this.args = args;
    this.opts = opts;

    if (!args.path)
        args.path = '/';

    args.prefix = 'box://';

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    // Must have credential file
    if (!args.cred || !fs.existsSync(args.cred))
        throw new Error(`Credentials not provided for box://`);

    let config;
    try { config = JSON.parse(fs.readFileSync(args.cred, 'utf8')); }
    catch(e) { throw new Error(`Invalid credentials file: ${args.cred}\n${e}`); }

    let client = null;
    let bConnected = false;
    const idCache = {}; // path string -> Box item ID

    /// Returns true if connected
    function isConnected()
    {
        return bConnected;
    }

    /** Returns the path prefix
        @param [in] p   - Optional path to append to prefix
    */
    function getPrefix(p = null)
    {
        return (p && p.length)
            ? (args.prefix + (p[0] === '/' ? p.slice(1) : p))
            : args.prefix;
    }

    /** Returns the path portion from the url
        @param [in] a   - Optional path to append
    */
    function makePath(a = null)
    {
        return a ? path.join(args.path, a) : args.path;
    }

    /// Connects to Box
    function connect()
    {
        if (opts.verbose)
            Log('box.connect()');

        return close().then(() =>
        {
            // JWT / app auth (full config JSON from Box Developer Console)
            if (config.boxAppSettings)
            {
                const sdk = BoxSDK.getPreconfiguredInstance(config);
                client = sdk.getAppAuthClient('enterprise');
                bConnected = true;
                return true;
            }

            // Developer token or OAuth2 access token
            const clientID     = config.client_id     || config.clientID     || '';
            const clientSecret = config.client_secret || config.clientSecret || '';
            const token        = config.token         || config.access_token || '';

            if (!token)
                throw new Error(
                    'box: credentials must include "token" or "boxAppSettings" for JWT auth'
                );

            const sdk = new BoxSDK({ clientID, clientSecret });
            client = sdk.getBasicClient(token);
            bConnected = true;
            return true;
        });
    }

    /// Disconnects
    function close()
    {
        if (opts.verbose)
            Log('box.close()');

        return new Promise(resolve =>
        {
            bConnected = false;
            client = null;
            resolve(true);
        });
    }

    /** Resolve a POSIX path to a Box folder ID, caching intermediate results.
        The root ('/' or '') maps to Box folder '0'.
        @param {string} p   - Absolute path string
        @returns {Promise<string>} Box folder ID
    */
    async function resolveFolder(p)
    {
        const norm = p || '/';
        if (idCache[norm]) return idCache[norm];

        const parts = norm.split('/').filter(s => s.length);
        let folderId = '0';
        let built = '';

        for (const part of parts)
        {
            built += '/' + part;
            if (idCache[built])
            {
                folderId = idCache[built];
                continue;
            }

            const items = await client.folders.getItems(folderId,
                { fields: 'name,id,type', limit: 1000 });
            const entry = items.entries.find(e => e.name === part && e.type === 'folder');
            if (!entry)
                throw new Error(`Folder not found: ${built}`);

            idCache[built] = entry.id;
            folderId = entry.id;
        }

        idCache[norm] = folderId;
        return folderId;
    }

    /** Resolve a file path to its parent folder ID, file ID (or null), and name.
        @param {string} p   - Absolute file path string
        @returns {Promise<{folderId, fileId, name}>}
    */
    async function resolveFile(p)
    {
        const dir  = path.dirname(p);
        const name = path.basename(p);
        const folderId = await resolveFolder(dir === '.' ? '/' : dir);
        const items = await client.folders.getItems(folderId,
            { fields: 'name,id,type,size,modified_at', limit: 1000 });
        const entry = items.entries.find(e => e.name === name && e.type === 'file');
        return { folderId, fileId: entry ? entry.id : null, name };
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    async function ls(dir)
    {
        if (opts.verbose)
            Log(`box.ls(${dir})`);

        if (!client)
            throw new Error('Not connected');

        const folderId = await resolveFolder(dir || '/');
        const items = await client.folders.getItems(folderId,
            { fields: 'name,id,type,size,modified_at', limit: 1000 });

        return items.entries.map(e =>
        {
            const isDir = (e.type === 'folder');
            const t = e.modified_at
                ? Math.floor(new Date(e.modified_at).getTime() / 1000)
                : 0;
            return {
                name   : e.name,
                path   : dir,
                full   : path.join(dir, e.name),
                isDir,
                isFile : !isDir,
                mode   : 0,
                size   : e.size || 0,
                atime  : t,
                mtime  : t,
                ctime  : t
            };
        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive : Create parent directories as needed
    */
    async function mkDir(dir, o = {})
    {
        if (opts.verbose)
            Log(`box.mkDir(${dir})`);

        if (!client)
            throw new Error('Not connected');

        const parent = path.dirname(dir);
        const name   = path.basename(dir);
        let parentId;

        try
        {
            parentId = await resolveFolder(parent || '/');
        }
        catch(e)
        {
            if (!o.recursive)
                throw e;
            await mkDir(parent, o);
            parentId = await resolveFolder(parent);
        }

        try
        {
            const folder = await client.folders.create(parentId, name);
            if (dir && folder && folder.id)
                idCache[dir] = folder.id;
        }
        catch(e)
        {
            if (!e.statusCode || e.statusCode !== 409)
                throw e;
            // 409 = already exists — treat as success
        }

        return true;
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    async function rmFile(file)
    {
        if (opts.verbose)
            Log(`box.rmFile(${file})`);

        if (!client)
            throw new Error('Not connected');

        const { fileId } = await resolveFile(file);
        if (!fileId)
            throw new Error(`File not found: ${file}`);

        await client.files.delete(fileId);
        return true;
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
                                recursive : Remove contents first
    */
    async function rmDir(dir, o = {})
    {
        if (opts.verbose)
            Log(`box.rmDir(${dir})`);

        if (!client)
            throw new Error('Not connected');

        const folderId = await resolveFolder(dir);
        await client.folders.delete(folderId, { recursive: o.recursive ? true : false });
        delete idCache[dir];
        return true;
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read
    */
    async function createReadStream(file)
    {
        if (opts.verbose)
            Log(`box.createReadStream(${file})`);

        if (!client)
            throw new Error('Not connected');

        const { fileId } = await resolveFile(file);
        if (!fileId)
            throw new Error(`File not found: ${file}`);

        return client.files.getReadStream(fileId);
    }

    /** Creates a write stream for the specified file.
        Collects the written data and uploads it to Box when the stream ends.
        Automatically uses uploadNewFileVersion if the file already exists.
        @param [in] file    - File to write
    */
    function createWriteStream(file)
    {
        if (opts.verbose)
            Log(`box.createWriteStream(${file})`);

        if (!client)
            return Promise.reject(new Error('Not connected'));

        const chunks = [];
        const ws = new stream.Writable(
        {
            write(chunk, enc, cb) { chunks.push(chunk); cb(); },
            final(cb)
            {
                const buf = Buffer.concat(chunks);
                resolveFile(file)
                    .then(({ folderId, fileId, name }) =>
                    {
                        if (fileId)
                            return client.files.uploadNewFileVersion(fileId, buf);
                        return client.files.uploadFile(folderId, name, buf);
                    })
                    .then(() => cb())
                    .catch(e => cb(e));
            }
        });

        return Promise.resolve(ws);
    }

    // Export functions
    this.connect          = connect;
    this.close            = close;
    this.ls               = ls;
    this.mkDir            = mkDir;
    this.rmFile           = rmFile;
    this.rmDir            = rmDir;
    this.makePath         = makePath;
    this.getPrefix        = getPrefix;
    this.isConnected      = isConnected;
    this.createReadStream = createReadStream;
    this.createWriteStream= createWriteStream;
};
