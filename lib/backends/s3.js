#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
var Log = console.log;

let __config__ = require('../config.js');

/** s3Client()

    Provides Amazon S3 storage functionality

    https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/
    https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-nodejs.html

    Credential file format (JSON):
    {
        "access_key_id":     "YOUR_ACCESS_KEY_ID",
        "secret_access_key": "YOUR_SECRET_ACCESS_KEY",
        "region":            "us-east-1"
    }

    URL format: s3://bucket-name/optional/path
*/
module.exports = function s3Client(args, opts)
{
    const { requireBackend } = require('../setup.js');
    const { S3Client,
            ListObjectsV2Command,
            DeleteObjectCommand,
            GetObjectCommand,
            HeadObjectCommand
          } = requireBackend('@aws-sdk/client-s3', 's3://');
    const { Upload } = requireBackend('@aws-sdk/lib-storage', 's3://');
    const { PassThrough } = require('stream');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.host)
        throw `Bucket name not provided for S3 connection`;

    args.prefix = `s3://${args.host}`;

    // Default path
    if (!args.path)
        args.path = '/';

    // Load credentials from file or environment
    let credentials = null;
    if (args.cred && fs.existsSync(args.cred) && fs.lstatSync(args.cred).isFile())
    {   try { credentials = JSON.parse(fs.readFileSync(args.cred, 'utf8')); }
        catch(e) { throw `Invalid credentials file : ${args.cred}\r\n${e}`; }
    }

    let s3 = null;
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

    /// Connects to S3
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
                    {
                        let clientConfig = {};

                        if (credentials)
                        {   clientConfig.credentials = {
                                accessKeyId:     credentials.access_key_id,
                                secretAccessKey: credentials.secret_access_key
                            };
                            if (credentials.session_token)
                                clientConfig.credentials.sessionToken = credentials.session_token;
                            if (credentials.region)
                                clientConfig.region = credentials.region;
                        }

                        // Allow region override via URL args or credentials
                        if (args.args && args.args.region)
                            clientConfig.region = args.args.region;

                        // Allow custom endpoint (e.g. for S3-compatible services)
                        if (args.args && args.args.endpoint)
                            clientConfig.endpoint = args.args.endpoint;

                        s3 = new S3Client(clientConfig);
                        bConnected = true;
                        resolve(true);
                    }
                    catch(e) { bConnected = false; reject(e); }
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

            if (s3)
            {   s3.destroy();
                s3 = null;
            }

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
            if (!s3)
                return reject('No connection');

            let prefix = trimStr(dir, '/');
            if (prefix.length)
                prefix += '/';

            let fl = [];

            function nextPage(token)
            {
                let params = {
                    Bucket: args.host,
                    Delimiter: '/',
                    Prefix: prefix,
                    MaxKeys: 1000
                };
                if (token)
                    params.ContinuationToken = token;

                s3.send(new ListObjectsV2Command(params))
                    .then(resp =>
                    {
                        // Add virtual directories (common prefixes)
                        if (resp.CommonPrefixes)
                            resp.CommonPrefixes.forEach(v =>
                            {
                                let full = trimStr(v.Prefix, '/');
                                fl.push({
                                    name: path.basename(full),
                                    path: '/' + path.dirname(full),
                                    full: '/' + full,
                                    isDir: true,
                                    isFile: false,
                                    mode: 0,
                                    size: 0,
                                    atime: 0,
                                    mtime: 0,
                                    ctime: 0
                                });
                            });

                        // Add files
                        if (resp.Contents)
                            resp.Contents.forEach(v =>
                            {
                                // Skip the directory placeholder object itself
                                if (v.Key === prefix)
                                    return;

                                let full = trimStr(v.Key, '/');
                                let mtime = v.LastModified ? (new Date(v.LastModified).getTime() / 1000) : 0;
                                fl.push({
                                    name: path.basename(full),
                                    path: '/' + path.dirname(full),
                                    full: '/' + full,
                                    isDir: false,
                                    isFile: true,
                                    mode: 0,
                                    size: v.Size || 0,
                                    atime: 0,
                                    mtime: mtime,
                                    ctime: mtime,
                                    etag: v.ETag
                                });
                            });

                        if (resp.IsTruncated && resp.NextContinuationToken)
                            nextPage(resp.NextContinuationToken);
                        else
                            resolve(fl);
                    })
                    .catch(err => reject(err));
            }

            nextPage(null);
        });
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive : Create subdirectories as well

        @note S3 has no real directories; this is a no-op
    */
    function mkDir(dir, o={})
    {   return Promise.resolve(true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {   return new Promise((resolve, reject) =>
        {   if (!s3)
                return reject('No connection');
            let key = trimStr(file, '/');
            s3.send(new DeleteObjectCommand({ Bucket: args.host, Key: key }))
                .then(r => resolve(r))
                .catch(e => reject(e));
        });
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
                                recursive : Remove subdirectories as well
                                verbose   : Echo each deleted file

        @note S3 has no real directories; we list and delete all matching objects
    */
    function rmDir(dir, o={})
    {
        return ls(dir)
            .then(r =>
            {
                let files = r.filter(v => v.isFile);
                let dirs  = r.filter(v => v.isDir);
                return __config__.promiseWhileBatch(o.batch, () => 0 < files.length, () =>
                {   let next = files.shift();
                    if (!next)
                        return Promise.resolve(true);
                    if (o.verbose)
                        console.log(` [Delete] ${getPrefix(next.full)}`);
                    return rmFile(next.full);
                })
                .then(r =>
                {
                    if (!o.recursive || !dirs.length)
                        return Promise.resolve(true);

                    return __config__.promiseWhileBatch((o.batch <= 4) ? o.batch : 4, () => 0 < dirs.length, () =>
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
    {   return new Promise((resolve, reject) =>
        {   if (!s3)
                return reject('No connection');
            let key = trimStr(file, '/');
            s3.send(new GetObjectCommand({ Bucket: args.host, Key: key }))
                .then(resp => resolve(resp.Body))
                .catch(e => reject(e));
        });
    }

    /** Creates a write stream for the specified file
        @param [in] file    - File to write
        @param [in] o       - Options
                                expectedSize : Hint for multipart threshold
    */
    function createWriteStream(file, o={})
    {   return new Promise((resolve, reject) =>
        {   if (!s3)
                return reject('No connection');
            try
            {
                let key = trimStr(file, '/');
                let pass = new PassThrough();

                let upload = new Upload({
                    client: s3,
                    params: {
                        Bucket: args.host,
                        Key: key,
                        Body: pass
                    },
                    queueSize: 4,
                    partSize: 5 * 1024 * 1024
                });

                // Attach finalize so pumpStream can await the upload completing
                pass.finalize = () => upload.done();

                upload.done().catch(e => { pass.destroy(e); });

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
