#!/usr/bin/env nodejs
'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const stream = require('stream');
const auth   = require('../auth.js');
var Log = console.log;

/** onedriveClient()

    Provides Microsoft OneDrive functionality via the Microsoft Graph API.

    https://learn.microsoft.com/en-us/graph/api/resources/onedrive
    https://www.npmjs.com/package/@azure/msal-node

    Credential file format (JSON):
    {
        "client_id":      "your-azure-app-client-id",
        "client_secret":  "your-azure-app-client-secret",
        "tenant_id":      "common",
        "redirect_uris":  ["http://localhost:19227"]
    }

    To create credentials:
    1. Go to https://portal.azure.com/ → Azure Active Directory → App registrations
    2. New registration, set redirect URI to http://localhost:19227 (or your --authport)
    3. Under "Certificates & secrets", create a client secret
    4. Under "API permissions", add Microsoft Graph → Files.ReadWrite (Delegated)
    5. Save client_id (Application ID) and client_secret to the JSON file

    On first run fmeld prints an authorization URL. After you log in, the
    token is cached next to the credentials file (.token.json) for future runs.

    URL format: onedrive://path/to/folder
*/
module.exports = function onedriveClient(args, opts)
{
    const { ConfidentialClientApplication } = require('@azure/msal-node');

    this.args = args;
    this.opts = opts;

    if (opts.verbose)
    {   const sparen = require('sparen');
        Log = sparen.log;
    }

    if (!args.path)
        args.path = '/';

    args.prefix = 'onedrive://';

    // Must have credential file
    if (!args.cred || !fs.existsSync(args.cred) || !fs.lstatSync(args.cred).isFile())
        throw `Credentials not provided for : ${args.prefix}`;

    let credentials = null;
    try { credentials = JSON.parse(fs.readFileSync(args.cred, 'utf8')); }
    catch(e) { throw `Invalid credentials file : ${args.cred}\r\n${e}`; }

    if (!credentials.client_id)
        throw `client_id missing in credentials file : ${args.cred}`;

    const tokenFile   = args.cred + '.token.json';
    const scopes      = ['https://graph.microsoft.com/Files.ReadWrite', 'offline_access'];
    const redirectUri = `http://localhost:${opts.authport || 19227}`;
    const tenantId    = credentials.tenant_id || 'common';

    let pca         = null;
    let bConnected  = false;

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

    /** Encode each path segment, preserving slashes
        @param [in] p   - Path string
    */
    function encodePath(p)
    {
        return p.split('/').map(seg => encodeURIComponent(seg)).join('/');
    }

    /** Return the Graph API item path for a OneDrive path
        @param [in] p   - OneDrive path (e.g. /My Folder/file.txt)
    */
    function itemPath(p)
    {
        p = p.replace(/\/+$/, '');
        if (!p || p === '/')
            return '/me/drive/root';
        return `/me/drive/root:${encodePath(p)}:`;
    }

    /** Get a valid access token, refreshing silently if needed */
    function getToken()
    {
        return pca.getTokenCache().getAllAccounts()
            .then(accounts =>
            {
                if (!accounts.length)
                    throw new Error('No cached account — call connect() first');

                return pca.acquireTokenSilent({ account: accounts[0], scopes });
            })
            .then(result =>
            {
                // Persist refreshed cache
                try { fs.writeFileSync(tokenFile, pca.getTokenCache().serialize()); }
                catch(e) {}
                return result.accessToken;
            });
    }

    /** Make a Graph API JSON request
        @param [in] method      - HTTP method
        @param [in] apiPath     - Path relative to /v1.0
        @param [in] body        - Optional request body (will be JSON-encoded)
    */
    function graphRequest(method, apiPath, body=null)
    {
        return getToken()
            .then(token => new Promise((resolve, reject) =>
            {
                const postData = body ? JSON.stringify(body) : null;
                const options  =
                {
                    hostname : 'graph.microsoft.com',
                    path     : `/v1.0${apiPath}`,
                    method,
                    headers  :
                    {   'Authorization' : `Bearer ${token}`,
                        'Accept'        : 'application/json',
                        'Content-Type'  : 'application/json'
                    }
                };
                if (postData)
                    options.headers['Content-Length'] = Buffer.byteLength(postData);

                const req = https.request(options, res =>
                {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () =>
                    {
                        if (res.statusCode >= 200 && res.statusCode < 300)
                        {   try { resolve(data ? JSON.parse(data) : null); }
                            catch(e) { resolve(data); }
                            return;
                        }
                        reject(new Error(`Graph ${method} ${apiPath} → ${res.statusCode}: ${data}`));
                    });
                });
                req.on('error', reject);
                if (postData) req.write(postData);
                req.end();
            }));
    }

    /** Stream a GET request, following HTTP redirects
        @param [in] apiPath     - Path relative to /v1.0
    */
    function graphStream(apiPath)
    {
        return getToken()
            .then(token => streamFollow(
            {   hostname : 'graph.microsoft.com',
                path     : `/v1.0${apiPath}`,
                method   : 'GET',
                headers  : { 'Authorization': `Bearer ${token}`, 'Accept': '*/*' }
            }));
    }

    /** Follow HTTP redirects and resolve with the final response stream
        @param [in] options         - https.request options
        @param [in] maxRedirects    - Redirect limit
    */
    function streamFollow(options, maxRedirects=5)
    {
        return new Promise((resolve, reject) =>
        {
            if (maxRedirects <= 0)
                return reject(new Error('Too many redirects'));

            const req = https.request(options, res =>
            {
                const loc = res.headers.location;
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && loc)
                {
                    try
                    {   const u = new URL(loc);
                        streamFollow(
                        {   hostname : u.hostname,
                            path     : u.pathname + u.search,
                            method   : 'GET',
                            headers  : {}
                        }, maxRedirects - 1).then(resolve).catch(reject);
                    }
                    catch(e) { reject(e); }
                    return;
                }

                if (res.statusCode >= 200 && res.statusCode < 300)
                    return resolve(res);

                let err = '';
                res.on('data', c => err += c);
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${err}`)));
            });
            req.on('error', reject);
            req.end();
        });
    }

    /** Fetch a page of directory children, following @odata.nextLink pagination
        @param [in] urlOrPath   - Full URL (for nextLink) or Graph API path
        @param [in] acc         - Accumulated results
        @param [in] dir         - Parent directory path (for building file entries)
    */
    function fetchPage(urlOrPath, acc, dir)
    {
        return getToken()
            .then(token => new Promise((resolve, reject) =>
            {
                let reqOptions;
                try
                {   // Full URL (pagination nextLink)
                    const u = new URL(urlOrPath);
                    reqOptions =
                    {   hostname : u.hostname,
                        path     : u.pathname + u.search,
                        method   : 'GET',
                        headers  :
                        {   'Authorization' : `Bearer ${token}`,
                            'Accept'        : 'application/json'
                        }
                    };
                }
                catch(e)
                {   // Relative API path
                    reqOptions =
                    {   hostname : 'graph.microsoft.com',
                        path     : `/v1.0${urlOrPath}`,
                        method   : 'GET',
                        headers  :
                        {   'Authorization' : `Bearer ${token}`,
                            'Accept'        : 'application/json'
                        }
                    };
                }

                const req = https.request(reqOptions, res =>
                {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () =>
                    {
                        if (res.statusCode < 200 || res.statusCode >= 300)
                            return reject(new Error(`ls ${dir} → ${res.statusCode}: ${data}`));

                        try
                        {
                            const parsed = JSON.parse(data);
                            for (const v of (parsed.value || []))
                            {
                                let isDir = !!v.folder;
                                let mtime = v.lastModifiedDateTime
                                    ? new Date(v.lastModifiedDateTime).getTime() / 1000 : 0;
                                let ctime = v.createdDateTime
                                    ? new Date(v.createdDateTime).getTime() / 1000 : 0;
                                acc.push(
                                {   id    : v.id,
                                    name  : v.name,
                                    path  : dir,
                                    full  : path.posix.join(dir, v.name),
                                    isDir,
                                    isFile: !isDir,
                                    mode  : 0,
                                    size  : v.size || 0,
                                    atime : mtime,
                                    mtime,
                                    ctime
                                });
                            }

                            if (parsed['@odata.nextLink'])
                                return resolve(fetchPage(parsed['@odata.nextLink'], acc, dir));

                            resolve(acc);
                        }
                        catch(e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.end();
            }));
    }

    /// Connects to OneDrive (authenticates and caches token)
    function connect()
    {
        return new Promise((resolve, reject) =>
        {
            close().then(() =>
            {
                if (opts.verbose)
                    Log(`Connecting to : ${args.prefix}`);

                pca = new ConfidentialClientApplication(
                {   auth:
                    {   clientId    : credentials.client_id,
                        clientSecret: credentials.client_secret,
                        authority   : `https://login.microsoftonline.com/${tenantId}`
                    }
                });

                // Try cached token first
                if (!opts.uncached && fs.existsSync(tokenFile))
                {
                    try
                    {
                        const cached = fs.readFileSync(tokenFile, 'utf8');
                        pca.getTokenCache().deserialize(cached);

                        return pca.getTokenCache().getAllAccounts()
                            .then(accounts =>
                            {
                                if (!accounts.length) throw new Error('No cached accounts');
                                return pca.acquireTokenSilent({ account: accounts[0], scopes });
                            })
                            .then(() =>
                            {   bConnected = true;
                                resolve(true);
                            })
                            .catch(() => doAuthFlow(resolve, reject));
                    }
                    catch(e)
                    {
                        if (opts.verbose) Log(`Cache load failed: ${e}`);
                        doAuthFlow(resolve, reject);
                    }
                    return;
                }

                doAuthFlow(resolve, reject);
            }).catch(reject);
        });
    }

    /** Interactive OAuth2 authorization code flow */
    function doAuthFlow(resolve, reject)
    {
        pca.getAuthCodeUrl({ scopes, redirectUri })
            .then(authUrl =>
            {
                Log(`\r\n--- AUTHORIZE ONEDRIVE BY VISITING THIS URL ---\r\n\r\n${authUrl}\r\n`);
                return auth.getAuthCode(opts.authport || 19227);
            })
            .then(r =>
            {
                Log(`${JSON.stringify(r)}\r\n`);
                if (!r.code)
                    return reject(`Bad code in : ${r}`);

                return pca.acquireTokenByCode({ code: r.code, scopes, redirectUri });
            })
            .then(result =>
            {
                try { fs.writeFileSync(tokenFile, pca.getTokenCache().serialize()); }
                catch(e) { if (opts.verbose) Log(e); }
                bConnected = true;
                resolve(true);
            })
            .catch(e => reject(e));
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

            resolve(true);
        });
    }

    /** Returns a list of the directory contents
        @param [in] dir     - Directory to list
    */
    function ls(dir)
    {
        if (!bConnected)
            return Promise.reject('No connection');

        const apiPath = (!dir || dir === '/')
            ? '/me/drive/root/children'
            : `${itemPath(dir)}/children`;

        return fetchPage(apiPath, [], dir);
    }

    /** Creates the specified directory
        @param [in] dir     - Directory to create
        @param [in] o       - Options
                                recursive   : Create parent directories as needed
    */
    function mkDir(dir, o={})
    {
        if (!bConnected)
            return Promise.reject('No connection');

        function createOne(p)
        {
            const parent = path.posix.dirname(p);
            const name   = path.posix.basename(p);
            if (!name) return Promise.resolve(true);

            const parentApi = (!parent || parent === '/')
                ? '/me/drive/root/children'
                : `${itemPath(parent)}/children`;

            return graphRequest('POST', parentApi,
            {   name,
                folder: {},
                '@microsoft.graph.conflictBehavior': 'rename'
            })
            .then(() => true)
            .catch(e =>
            {   const msg = String(e);
                if (msg.includes('nameAlreadyExists') || msg.includes('conflict'))
                    return true;
                throw e;
            });
        }

        if (!o.recursive)
            return createOne(dir);

        // Recursive: create each path component in sequence
        const parts = dir.split('/').filter(p => p.length);
        let built = '';
        return parts.reduce((promise, part) =>
        {
            return promise.then(() =>
            {   built += '/' + part;
                return createOne(built);
            });
        }, Promise.resolve()).then(() => true);
    }

    /** Deletes the specified file
        @param [in] file    - File to delete
    */
    function rmFile(file)
    {
        if (!bConnected)
            return Promise.reject('No connection');

        return graphRequest('DELETE', itemPath(file))
            .then(() => true)
            .catch(e =>
            {   const msg = String(e);
                if (msg.includes('404') || msg.includes('itemNotFound'))
                    return true;
                throw e;
            });
    }

    /** Deletes the specified directory
        @param [in] dir     - Directory to delete
        @param [in] o       - Options
    */
    function rmDir(dir, o={})
    {
        return rmFile(dir);
    }

    /** Creates a read stream for the specified file
        @param [in] file    - File to read
    */
    function createReadStream(file, o={})
    {
        if (!bConnected)
            return Promise.reject('No connection');

        return graphStream(`${itemPath(file)}/content`);
    }

    /** Creates a write stream for the specified file.

        Data is buffered locally, then uploaded when finalize() is called.
        Files up to 60 MB use a simple PUT; larger files use an upload session.

        @param [in] file    - File to write
        @param [in] o       - Options
    */
    function createWriteStream(file, o={})
    {
        return new Promise((resolve, reject) =>
        {
            if (!bConnected)
                return reject('No connection');

            const chunks = [];
            const ws = new stream.Writable(
            {
                write(chunk, enc, callback)
                {   chunks.push(chunk);
                    callback();
                }
            });

            ws.finalize = () =>
            {
                const data = Buffer.concat(chunks);
                return getToken().then(token => uploadData(file, token, data));
            };

            resolve(ws);
        });
    }

    /** Route to simple PUT or upload-session based on file size
        @param [in] file    - Destination path
        @param [in] token   - Bearer token
        @param [in] data    - File data as Buffer
    */
    function uploadData(file, token, data)
    {
        const SIMPLE_LIMIT = 60 * 1024 * 1024; // 60 MB
        if (data.length <= SIMPLE_LIMIT)
            return simplePut(file, token, data);
        return uploadSession(file, token, data);
    }

    /** Simple PUT upload (≤ 60 MB) */
    function simplePut(file, token, data)
    {
        return new Promise((resolve, reject) =>
        {
            const options =
            {   hostname : 'graph.microsoft.com',
                path     : `/v1.0${itemPath(file)}/content`,
                method   : 'PUT',
                headers  :
                {   'Authorization' : `Bearer ${token}`,
                    'Content-Type'  : 'application/octet-stream',
                    'Content-Length': data.length
                }
            };
            const req = https.request(options, res =>
            {
                let resp = '';
                res.on('data', c => resp += c);
                res.on('end', () =>
                {   if (res.statusCode >= 200 && res.statusCode < 300)
                        return resolve(true);
                    reject(new Error(`Upload ${file} → ${res.statusCode}: ${resp}`));
                });
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    }

    /** Upload-session based upload (> 60 MB, sent in 10 MB chunks) */
    function uploadSession(file, token, data)
    {
        const CHUNK = 10 * 1024 * 1024;

        return new Promise((resolve, reject) =>
        {
            const body = JSON.stringify(
            {   item: { '@microsoft.graph.conflictBehavior': 'replace' }
            });

            const createOptions =
            {   hostname : 'graph.microsoft.com',
                path     : `/v1.0${itemPath(file)}/createUploadSession`,
                method   : 'POST',
                headers  :
                {   'Authorization' : `Bearer ${token}`,
                    'Content-Type'  : 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            };

            const req = https.request(createOptions, res =>
            {
                let resp = '';
                res.on('data', c => resp += c);
                res.on('end', () =>
                {
                    if (res.statusCode < 200 || res.statusCode >= 300)
                        return reject(new Error(`createUploadSession → ${res.statusCode}: ${resp}`));

                    let session;
                    try { session = JSON.parse(resp); }
                    catch(e) { return reject(e); }

                    // Upload in chunks
                    let offset = 0;

                    function nextChunk()
                    {
                        if (offset >= data.length)
                            return resolve(true);

                        const end   = Math.min(offset + CHUNK, data.length);
                        const chunk = data.slice(offset, end);
                        const u     = new URL(session.uploadUrl);

                        const chunkReq = https.request(
                        {   hostname : u.hostname,
                            path     : u.pathname + u.search,
                            method   : 'PUT',
                            headers  :
                            {   'Content-Length': chunk.length,
                                'Content-Range' : `bytes ${offset}-${end-1}/${data.length}`
                            }
                        }, chunkRes =>
                        {
                            let r = '';
                            chunkRes.on('data', c => r += c);
                            chunkRes.on('end', () =>
                            {   if (chunkRes.statusCode < 200 || chunkRes.statusCode >= 300)
                                    return reject(new Error(
                                        `Chunk upload @ ${offset} → ${chunkRes.statusCode}: ${r}`));
                                offset = end;
                                nextChunk();
                            });
                        });
                        chunkReq.on('error', reject);
                        chunkReq.write(chunk);
                        chunkReq.end();
                    }

                    nextChunk();
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
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
