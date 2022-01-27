#!/usr/bin/env nodejs
'use strict';

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


/**
    @param [in] url     - URL describing the connection
    @param [in] opts    - Connection options
*/
function getConnection(url, opts)
{
    let u = new URL(url);

    let args = {};
    if (u.search)
        u.search.split("&").forEach(function(part)
        {   let v = part.split("=");
            args[v[0]] = decodeURIComponent(v[1]);
        });

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
            if (progress)
                progress('------', 0, from, to);

            ws.on('error', (e) =>
            {   Log(e);
                return reject(e);
            });
            // ws.on('finish', () => {} );
            ws.on('close', () =>
            {   if (progress) 100.00%
                    progress('  done  ', 100, from, to, 'file');
                // Log('write close');
                return resolve(true);
            });

            rs.on('error', (e) =>
            {   Log(e);
                return reject(e);
            });
            // rs.on('end', () => {});
            rs.on('data', data => {
                let per = data.length / size * 100;
                if (progress && 0 < per && 100 > per)
                    progress('copying', per, from, to, 'file');
            });
            rs.pipe(ws);
        }
        catch(e)
        {
            return reject(e);
        }
    });
}

function copyFile(src, dst, from, to, size, progress)
{
    return dst.mkdir(path.dirname(to))
        .then((r) => { return Promise.all([src.createReadStream(from), dst.createWriteStream(to)]) })
        .then((a) => { return pumpStream(a[0], a[1], from, to, size, progress); });
}

function copyDir(src, dst, from, to, opts, progress)
{
    progress('new dir', 0, from, to, 'dir');
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
    // progress('new dir', 0, from, to, 'dir');

    return Promise.all([src.ls(from), dst.ls(to)])
        .then((a) =>
        {
            let [srcList, dstList] = a;

            // Compare src to dst
            for (let ks in srcList)
                for (let kd in dstList)
                    if (compareItems(srcList[ks], dstList[kd]))
                        break;

            // Compare dst to src
            for (let kd in dstList)
                if (!dstList[kd].found)
                    for (let ks in srcList)
                        if (compareItems(dstList[kd], srcList[ks]))
                            break;

            let jobs = [];

            for (let k in srcList)
            {   let v = srcList[k];
                if (!v)
                    ;
                else if (v.isDir)
                {   if (opts.recursive)
                        jobs.push({src: src, dst: dst, item: v, to: to});
                }
                else if (v.found && v.match)
                    progress(' up2date', 100, v.full, v.other.full, 'file');
                else if (!v.found)
                {   jobs.push({src: src, dst: dst, item: v, to: to});
                    progress('*missing', 100, v.full, '', 'file');
                }
                else if (!v.match)
                {   jobs.push({src: src, dst: dst, item: v, to: to});
                    progress('*changed', 100, v.full, v.other.full, 'file');
                }
            }

            for (let k in dstList)
            {   let v = dstList[k];
                if (!v)
                    ;
                else if (v.isDir)
                    ;
                else if (!v.found)
                    progress('missing', 100, v.full, '', 'file');
            }

            // Update files
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


            // return promiseWhile(() => 0 < fileList.length, () =>
            //     {
            //         if (0 >= fileList.length)
            //             return Promise.resolve(false);

            //         // Next file
            //         let v = fileList.shift();

            //         // Copy files
            //         if (v.isFile)
            //             return copyFile(src, dst, v.full, path.join(to, v.name), v.size, progress);

            //         // Copy sub directories?
            //         else if (v.isDir && opts.recursive)
            //             return copyDir(src, dst, v.full, path.join(to, v.name), opts, progress);

            //         // Skip
            //         else
            //             return Promise.resolve(false);
            //     });
}
