#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
var Log = console.log;

let __config__ = require('../config.js');

/** azblobClient()

    Provides Azure Blob Storage functionality.

    https://www.npmjs.com/package/@azure/storage-blob
    https://docs.microsoft.com/en-us/azure/storage/blobs/

    Credential file format (JSON) — one of:

    Option 1 — Connection string:
    {
        "connection_string": "DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
    }

    Option 2 — Account key:
    {
        "account_name": "mystorageaccount",
        "account_key":  "base64encodedkey=="
    }

    Option 3 — SAS token:
    {
        "account_name": "mystorageaccount",
        "sas_token":    "sv=2021-06-08&ss=b&..."
    }

    Without a credential file, fmeld falls back to the
    AZURE_STORAGE_CONNECTION_STRING environment variable.

    URL format: azure://container-name/optional/path
                azblob://container-name/optional/path
*/
module.exports = function azblobClient(args, opts)
{
    const { BlobServiceClient,
            StorageSharedKeyCredential } = require('@azure/storage-blob');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.host)
        throw `Container name not provided for Azure Blob Storage connection`;

    args.prefix = `azure://${args.host}`;

    if (!args.path)
        args.path = '/';

    // Load credentials
    let credentials = null;
    if (args.cred && fs.existsSync(args.cred) && fs.lstatSync(args.cred).isFile())
    {   try { credentials = JSON.parse(fs.readFileSync(args.cred, 'utf8')); }
        catch(e) { throw `Invalid credentials file : ${args.cred}\r\n${e}`; }
    }

    let serviceClient   = null;
    let containerClient = null;
    let bConnected      = false;

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
        return a ? path.join(args.path, a) : args.path;
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

    /// Connects to Azure Blob Storage
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
                    if (credentials && credentials.connection_string)
                    {
                        serviceClient = BlobServiceClient.fromConnectionString(
                            credentials.connection_string);
                    }
                    else if (credentials && credentials.account_name && credentials.account_key)
                    {
                        const sharedKey = new StorageSharedKeyCredential(
                            credentials.account_name, credentials.account_key);
                        serviceClient = new BlobServiceClient(
                            `https://${credentials.account_name}.blob.core.windows.net`,
                            sharedKey);
                    }
                    else if (credentials && credentials.account_name && credentials.sas_token)
                    {
                        serviceClient = new BlobServiceClient(
                            `https://${credentials.account_name}.blob.core.windows.net?${credentials.sas_token}`);
                    }
                    else if (process.env.AZURE_STORAGE_CONNECTION_STRING)
                    {
                        serviceClient = BlobServiceClient.fromConnectionString(
                            process.env.AZURE_STORAGE_CONNECTION_STRING);
                    }
                    else
                    {
                        throw `No credentials for Azure Blob Storage. Provide a JSON credentials file or set AZURE_STORAGE_CONNECTION_STRING.`;
                    }

                    containerClient = serviceClient.getContainerClient(args.host);
                    bConnected = true;
                    resolve(true);
                }
                catch(e) { bConnected = false; reject(e); }
            }).catch(reject);
        });
    }

    /// Cleanup resources
    function close()
    {
        return new Promise((resolve) =>
        {
            if (!bConnected)
                return resolve(true);

            bConnected = false;
            if (opts.verbose)
                Log(`Closing : ${args.prefix}`);

            containerClient = null;
            serviceClient   = null;
            resolve(true);
        });
    }

    /** Async helper — iterate listBlobsByHierarchy and return array
        @param [in] dir     - Directory path (may start/end with /)
    */
    async function lsInternal(dir)
    {
        let prefix = trimStr(dir, '/');
        if (prefix.length)
            prefix += '/';

        let fl = [];

        for await (const item of containerClient.listBlobsByHierarchy('/', { prefix }))
        {
            if (item.kind === 'prefix')
            {
                // Virtual directory
                let full = '/' + trimStr(item.name, '/');
                fl.push({
                    name  : path.basename(trimStr(item.name, '/')),
                    path  : dir,
                    full,
                    isDir : true,
                    isFile: false,
                    mode  : 0,
                    size  : 0,
                    atime : 0,
                    mtime : 0,
                    ctime : 0
                });
            }
            else
            {
                // Skip directory placeholder objects (key ends with /)
                if (item.name === prefix)
                    continue;

                let mtime = item.properties.lastModified
                    ? new Date(item.properties.lastModified).getTime() / 1000 : 0;
                let full = '/' + trimStr(item.name, '/');
                fl.push({
                    name  : path.basename(full),
                    path  : dir,
                    full,
                    isDir : false,
                    isFile: true,
                    mode  : 0,
                    size  : item.properties.contentLength || 0,
                    atime : mtime,
                    mtime,
                    ctime : mtime
                });
            }
        }

        return fl;
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        if (!containerClient)
            return Promise.reject('No connection');
        return lsInternal(dir);
    }

    /** Creates the specified directory
        @note Azure Blob Storage has no real directories — this is a no-op
    */
    function mkDir(dir, o={})
    {
        return Promise.resolve(true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {
        return new Promise((resolve, reject) =>
        {
            if (!containerClient)
                return reject('No connection');
            let key = trimStr(file, '/');
            containerClient.getBlobClient(key).delete()
                .then(() => resolve(true))
                .catch(e => reject(e));
        });
    }

    /** Deletes the specified directory (lists and deletes all matching blobs)
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
                                recursive : Remove sub-directories as well
                                verbose   : Echo each deleted blob
    */
    function rmDir(dir, o={})
    {
        return ls(dir)
            .then(r =>
            {
                let files = r.filter(v => v.isFile);
                let dirs  = r.filter(v => v.isDir);

                return __config__.promiseWhileBatch(o.batch || 1, () => 0 < files.length, () =>
                {   let next = files.shift();
                    if (!next) return Promise.resolve(true);
                    if (o.verbose) console.log(` [Delete] ${getPrefix(next.full)}`);
                    return rmFile(next.full);
                })
                .then(() =>
                {
                    if (!o.recursive || !dirs.length)
                        return Promise.resolve(true);

                    return __config__.promiseWhileBatch(4, () => 0 < dirs.length, () =>
                    {   let next = dirs.shift();
                        return next ? rmDir(next.full, o) : Promise.resolve(true);
                    });
                });
            })
            .catch(e => { Log(String(e)); });
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read
    */
    function createReadStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!containerClient)
                return reject('No connection');
            let key = trimStr(file, '/');
            containerClient.getBlobClient(key).download()
                .then(resp => resolve(resp.readableStreamBody))
                .catch(e => reject(e));
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to write
        @param [in] o       - Options
                                contentType : Optional MIME type
    */
    function createWriteStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!containerClient)
                return reject('No connection');
            try
            {
                let key  = trimStr(file, '/');
                const pass = new PassThrough();
                const blockBlobClient = containerClient.getBlockBlobClient(key);

                const uploadPromise = blockBlobClient.uploadStream(pass, undefined, undefined,
                {
                    blobHTTPHeaders: {
                        blobContentType: o.contentType || 'application/octet-stream'
                    }
                });

                // Attach finalize so pumpStream can await the upload completing
                pass.finalize = () => uploadPromise;
                uploadPromise.catch(e => pass.destroy(e));

                resolve(pass);
            }
            catch(e) { reject(e); }
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
