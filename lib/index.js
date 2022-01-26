#!/usr/bin/env nodejs
'use strict';

const path = require('path');
const Log = console.log;

let __config__ = require('./config.js');
module.exports =
{
    __config__      : __config__,
    __info__        : __config__.__info__,
    fileClient      : require('./file.js'),
    sftpClient      : require('./sftp.js'),
    getConnection   : getConnection,
    copyFile        : copyFile,
    copyDir         : copyDir,
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

function copyFile(src, dst, from, to, size, progress)
{
    return new Promise((resolve, reject) =>
    {
        if (progress)
            progress(0, from, to);
        let dstRoot = path.dirname(to);
        dst.mkdir(dstRoot)
            .then((r) => { return Promise.all([src.createReadStream(from), dst.createWriteStream(to)]) })
            .then((a) => {
                let [readStream, writeStream] = a;
                writeStream.on('error', (e) =>
                {
                    return reject(e);
                });
                writeStream.on('close', () =>
                {   if (progress)
                        progress(100, from, to, 'file');
                    return resolve(true);
                });

                readStream.on('error', (e) =>
                {
                    return reject(e);
                });
                readStream.on('close', () =>
                {   if (progress)
                        progress(100, from, to, 'file');
                    return resolve(true);
                });

                let written = 0;
                readStream.on('data', data => {
                    writeStream.write(data, () => {
                        written += data.length;
                        let per = (written/size*100);
                        if (progress && 0 < per && 100 > per)
                            progress(per, from, to, 'file');
                    });
                });
            });
    });

}

function copyDir(src, dst, from, to, opts, progress)
{
    progress(0, from, to, 'dir');
    return src.ls(from)
        .then((fileList)=>
        {
            return fmeld.promiseWhile(() => 0 < fileList.length, () =>
                {
                    // Next file
                    let v = fileList.shift();

                    // Copy files
                    if (v.isFile)
                        return fmeld.copyFile(src, dst, v.full, path.join(to, v.name), v.size, progress)
                                        .then((r) => {})
                                        .catch((e)=>{ Log(e); throw `Failed to copy files : ${e}`; });

                    // Copy sub directories?
                    else if (v.isDir && opts.recursive)
                        return copyDir(src, dst, v.full, path.join(to, v.name), opts, progress);

                });

        });

}
