#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const sparen = require('sparen');
const Log = sparen.log;

let __config__ = require('./config.js');
module.exports =
{
    __config__      : __config__,
    __info__        : __config__.__info__,
    fakeClient      : require('./fake.js'),
    fileClient      : require('./file.js'),
    sftpClient      : require('./sftp.js'),
    getConnection   : getConnection,
    stdoutProgress  : stdoutProgress,
    copyFile        : copyFile,
    copyDir         : copyDir,
    syncDir         : syncDir,
    promiseWhile    : promiseWhile
};

function findFile(dir, pat)
{
    let files = fs.readdirSync(dir);
    let subs = [];

    // Check files in this directory
    for (let k in files)
    {   let v = files[k];
        let full = path.join(dir, v);
        if (fs.lstatSync(full).isDirectory())
        subs.push(full);
        else if (v.match(pat))
            return full;
    }

    // Check sub directories
    for (let k in subs)
    {   let r = findFile(subs[k], pat);
        if (r)
            return r;
    }

    return null;
}

/** Find credentials in file tree
    @param [in] u       - Url components
    @param [in] cred    - Credential hint,
                            may be full path to credential file or
                            appended to opts.credRoot
    @param [in] opts    - opts.credRoot - Credential root folder
*/
function findCredential(u, cred, opts)
{
    if (cred)
    {
        // Replace?
        if (0 <= cred.indexOf('%'))
            for (let k in u)
                cred = cred.replace(`%${k}%`, u[k]);

        // Environment variable?
        if (0 <= cred.indexOf('$'))
            cred = process.env[cred];

        // Replace?
        if (0 <= cred.indexOf('%'))
            for (let k in u)
                cred = cred.replace(`%${k}%`, u[k]);

        // Is cred already a file?
        // if (fs.existsSync(cred) && fs.lstatSync(cred).isFile())
        //     return cred;
    }

    // Find root
    let credRoot = opts['cred-root'] || opts['credRoot'];
    if (credRoot)
    {
        // Environment variable
        if (0 <= credRoot.indexOf('$'))
            credRoot = process.env[credRoot];

        // Replace?
        if (0 <= credRoot.indexOf('%'))
            for (let k in u)
                credRoot = credRoot.replace(`%${k}%`, u[k]);

        // Did we get a valid directory?
        if (!fs.existsSync(credRoot))
            credRoot = null;

        else if (fs.lstatSync(credRoot).isFile())
        {   if (!cred)
                return credRoot;
            credRoot = null;
        }
    }

    // Search for it?
    if (credRoot && !cred)
        return u.host ? findFile(credRoot, RegExp(u.host)) : null;

    // If no root
    if (!credRoot)
    {   if (fs.existsSync(cred) && fs.lstatSync(cred).isFile())
            return cred;
        return null;
    }

    if (opts.verbose)
        Log(`Credential root: ${credRoot}`);

    // Check full path
    Log(credRoot, cred);
    cred = path.join(credRoot, cred);
    if (fs.existsSync(cred) && fs.lstatSync(cred).isFile())
        return cred;

    // Search for template match
    findFile(credRoot, RegExp(cred));

    return null;
}


/**
    @param [in] url     - URL describing the connection
    @param [in] cred    - Credentials file
    @param [in] opts    - Connection options
*/
function getConnection(url, cred, opts)
{
    let u = new URL(url);

    // Get URL arguments
    let args = {};
    if (u.search)
        u.search.split("&").forEach(function(part)
        {   let v = part.split("=");
            args[v[0]] = decodeURIComponent(v[1]);
        });

    let credFile = findCredential(u, cred, opts);
    if (opts.verbose)
        Log(`Credential file: ${credFile}`);

    switch(u.protocol.toLowerCase())
    {
        case 'fake:':
            return new module.exports.fakeClient({
                            name: url,
                            url: url,
                            path: path.join(u.host, u.pathname)
                        }, opts);

        case 'file:':
            return new module.exports.fileClient({
                            name: url,
                            url: url,
                            path: path.join(u.host, u.pathname)
                        }, opts);

        case 'sftp:':
            return new module.exports.sftpClient({
                            name: u.hostname,
                            url:  url,
                            cred: credFile,
                            host: u.hostname,
                            user: u.username,
                            pass: u.password,
                            path: u.pathname,
                            port: u.port,
                            args: args
                        }, opts);

        default:
            throw `Unknown protocol : ${url}`;
    }

}

function promiseWhile(cond, prom)
{   return prom().then(r=> { return cond(r) ? promiseWhile(cond, prom) : r; });
}

function stdoutProgress(status, p, from, to, t)
{
    const rr = '\x1b[0G'; // '\r'
    if ('file' == t)
    {   let disp = (0 < p && 100 > p) ? (String(p.toFixed(2)).padStart(6,' ')+'% ') : status.slice(0, 8).padEnd(8, ' ');
        let msg = `${rr}[${disp}] ${from} -> ${to}`;
        process.stdout.write(msg.slice(0, 100).padEnd(100,' ') + ((100==p) ? '\r\n' : ''));
    }
    else if ('dir' == t)
    {
        process.stdout.write(`${rr}<========> ${from} => ${to}\r\n`);
    }
}

function pumpStream(rs, ws, from, to, size, progress)
{
    return new Promise((resolve, reject) =>
    {
        try
        {
            let timeout = 0;
            let bytesSent = 0;
            let refreshRate = .25;

            if (progress)
                progress('------', 0, from, to);

            ws.on('error', (e) =>
            {   Log(e);
                return reject(e);
            });
            // ws.on('finish', () => {} );
            ws.on('close', () =>
            {   if (progress) 100.00%
                    progress(' copied ', 100, from, to, 'file');
                return resolve(true);
            });

            rs.on('error', (e) =>
            {   Log(e);
                return reject(e);
            });

            //------------------------------------------------------
            // Method 1 - Monitor data written
            //------------------------------------------------------
            rs.on('data', data =>
            {   ws.write(data, () =>
                {   bytesSent += data.length;
                    let t = new Date().getTime() / 1000;
                    if (t > timeout)
                    {   timeout = t + refreshRate;
                        let per = bytesSent / size * 100;
                        if (progress && 0 < per && 100 > per)
                            progress('copying', per, from, to, 'file');
                    }
                });
                return false;
            });
            rs.on('end', () => { ws.end(); });

            //------------------------------------------------------
            // Method 2 - Monitor data read
            //------------------------------------------------------
            // rs.on('data', data => {
            //     bytesSent += data.length;
            //     let t = new Date().getTime() / 1000;
            //     if (t > timeout)
            //     {   timeout = t + refreshRate;
            //         let per = bytesSent / size * 100;
            //         if (progress && 0 < per && 100 > per)
            //             progress('copying', per, from, to, 'file');
            //     }
            // });
            // rs.pipe(ws);

        }
        catch(e)
        {
            return reject(e);
        }
    });
}

function copyFile(src, dst, from, to, size, progress)
{
    return Promise.all([src.createReadStream(from), dst.createWriteStream(to)])
            .then((a) => { return pumpStream(a[0], a[1], src.getPrefix(from), dst.getPrefix(to), size, progress); });
}

function copyDir(src, dst, from, to, opts, progress)
{
    progress(' copy ', 100, from, to, 'dir');
    return dst.mkdir(to)
        .then((r) =>
        {
            return src.ls(from)
                .then((fileList)=>
                {
                    return promiseWhile(() => 0 < fileList.length, () =>
                        {
                            if (0 >= fileList.length)
                                return Promise.resolve(false);

                            // Next file
                            let v = fileList.shift();

                            // Copy files
                            if (v.isFile)
                                return copyFile(src, dst, v.full, path.join(to, v.name), v.size, progress);

                            // Copy sub directories?
                            else if (v.isDir && opts.recursive)
                                return copyDir(src, dst, v.full, path.join(to, v.name), opts, progress);

                            // Skip
                            else
                                return Promise.resolve(false);
                        });
                });
        });
}

function compareItems(a, b)
{
    let timeThreshold = 3;

    if (a.found || b.found)
        return false;

    if (a.name != b.name)
        return false;

    a.found = true;
    b.found = true;
    a.other = b;
    b.other = a;

    // Are they both file or directory?
    if (a.isFile != b.isFile || a.isDir != b.isDir)
    {   a.match = b.match = false;
        a.status = b.status = `${a.full} is a ${a.isDir?'directory':'file'}, while ${b.full} is a ${b.isDir?'directory':'file'}`;
    }

    // Directories match
    else if (a.isDir)
        a.match = b.match = true;

    // Compare sizes
    else if (a.size != b.size)
    {   a.match = b.match = false;
        a.status = b.status = `Size mismatch, ${a.full} is ${a.size}, ${b.full} is ${b.size}`;
    }

    // Compare times, destination should be newer than source
    else if ((a.mtime - timeThreshold) > b.mtime)
    {   a.match = b.match = false;
        a.status = b.status = `Time mismatch, ${a.full} is ${a.mtime}, ${b.full} is ${b.mtime}`;
    }

    else
    {   a.match = b.match = true;
        a.status = b.status = `Files match ${a.full} <==> ${b.full}`;
    }

    return true;
}

function syncDir(src, dst, from, to, opts, progress)
{
    progress(' sync ', 100, src.getPrefix(from), dst.getPrefix(to), 'dir');
    return dst.mkdir(to)
        .then((r) =>
        {
            return Promise.all([src.ls(from), dst.ls(to)])
                .then((a) =>
                {
                    let [srcList, dstList] = a;

                    let filterFiles = opts.filterFiles ? RegExp(opts.filterFiles) : null;
                    let filterDirs = opts.filterDirs ? RegExp(opts.filterDirs) : null;

                    // Compare src to dst
                    for (let ks in srcList)
                        for (let kd in dstList)
                            if (compareItems(srcList[ks], dstList[kd]))
                                break;

                    // Compare dst to src
                    for (let kd in dstList)
                            for (let ks in srcList)
                                if (compareItems(dstList[kd], srcList[ks]))
                                    break;

                    let jobs = [];

                    // Add jobs for uploading
                    for (let k in srcList)
                    {
                        let v = srcList[k];

                        if (filterFiles && v.isFile)
                            if (!filterFiles.test(v.name))
                                continue;

                        if (filterDirs && v.isDir)
                            if (!filterDirs.test(v.name))
                                continue;

                        if (!v)
                            ;
                        else if (v.isDir)
                        {   if (opts.recursive)
                                jobs.push({src: src, dst: dst, item: v, to: to});
                        }
                        else if (v.found && v.match)
                        {
                            if (!opts.less)
                                progress(' up2date', 100, src.getPrefix(v.full), dst.getPrefix(v.other.full), 'file');
                        }
                        else if (!v.found)
                        {   if (opts.upload)
                                jobs.unshift({src: src, dst: dst, item: v, to: to});
                            if (!opts.less)
                                progress('*missing', 100, src.getPrefix(v.full), '', 'file');
                        }
                        else if (!v.match)
                        {   if (opts.upload)
                                jobs.unshift({src: src, dst: dst, item: v, to: to});
                            if (!opts.less)
                                progress('*changed', 100, src.getPrefix(v.full), dst.getPrefix(v.other.full), 'file');
                        }
                    }

                    // Add jobs for downloading
                    for (let k in dstList)
                    {
                        let v = dstList[k];

                        if (filterFiles && v.isFile)
                            if (!filterFiles.test(v.name))
                                continue;

                        if (filterDirs && v.isDir)
                            if (!filterDirs.test(v.name))
                                continue;

                        if (!v)
                            ;
                        else if (v.isDir)
                            ;
                        else if (!v.found)
                        {   if (opts.download)
                                jobs.unshift({src: dst, dst: src, item: v, to: from});
                            if (!opts.less)
                                progress('*missing', 100, '', dst.getPrefix(v.full), 'file');
                        }
                    }

                    // Process jobs
                    return promiseWhile(() => 0 < jobs.length, () =>
                        {
                            if (0 >= jobs.length)
                                return Promise.resolve(false);

                            // Next file
                            let j = jobs.shift();
                            let v = j.item;

                            // Copy files
                            if (v.isFile)
                                return copyFile(j.src, j.dst, v.full, path.join(j.to, v.name), v.size, progress);

                            // Sync sub directories?
                            else if (v.isDir && opts.recursive)
                                return syncDir(src, dst, v.full, path.join(j.to, v.name), opts, progress);

                            // Skip
                            else
                                return Promise.resolve(false);
                        });

                });
        });
}
