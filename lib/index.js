#!/usr/bin/env nodejs
'use strict';

const fs = require('fs');
const path = require('path');
const sparen = require('sparen');
const Log = sparen.log;

let __config__ = require('./config.js');
const promiseWhile = __config__.promiseWhile;
module.exports =
{
    __config__      : __config__,
    __info__        : __config__.__info__,
    fakeClient      : require('./fake.js'),
    fileClient      : require('./file.js'),
    ftpClient       : require('./ftp.js'),
    sftpClient      : require('./sftp.js'),
    gcsClient       : require('./gcs.js'),
    gdriveClient    : require('./gdrive.js'),
    dropboxClient   : require('./dropbox.js'),
    getConnection   : getConnection,
    stdoutProgress  : stdoutProgress,
    copyFile        : copyFile,
    copyDir         : copyDir,
    syncDir         : syncDir,
    promiseWhile    : promiseWhile,
    toHuman         : toHuman
};

/// Returns a time stamp
function timeStr()
{   let now = new Date();
    let hour = String(now.getHours()).padStart(2,'0');
    let mins = String(now.getMinutes()).padStart(2,'0');
    let secs = String(now.getSeconds()).padStart(2,'0');
    return `[${hour}:${mins}:${secs}]`;
}

/** Searches for a file matching the specified pattern
    @param [in] dir         - Directory in which to start search
    @param [in] pat         - Pattern to search for
    @param [in] maxDepth    - Maximum depth to search
*/
function findFile(dir, pat, maxDepth=16)
{
    if (0 >= maxDepth)
        return null;

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
        return u.host ? findFile(credRoot, RegExp(u.hostname)) : null;

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

    let pathname = decodeURIComponent(u.pathname.replace(/\+/g, '%20'));

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
                            path: path.join(u.host, pathname),
                            args: args
                        }, opts);

        case 'file:':
            return new module.exports.fileClient({
                            name: url,
                            url: url,
                            path: path.join(u.host, pathname),
                            args: args
                        }, opts);

        case 'sftp:':
            return new module.exports.sftpClient({
                            name: u.hostname,
                            url:  url,
                            cred: credFile,
                            host: u.hostname,
                            user: u.username,
                            pass: u.password,
                            path: pathname,
                            port: u.port,
                            args: args
                        }, opts);

        case 'ftp:':
            return new module.exports.ftpClient({
                            name: u.hostname,
                            url:  url,
                            cred: credFile,
                            host: u.hostname,
                            user: u.username,
                            pass: u.password,
                            path: pathname,
                            port: u.port,
                            args: args
                        }, opts);

        case 'gs:': case 'gcs':
            return new module.exports.gcsClient({
                            name: u.hostname,
                            url:  url,
                            cred: credFile,
                            host: u.hostname,
                            user: u.username,
                            pass: u.password,
                            path: pathname,
                            port: u.port,
                            args: args
                        }, opts);

        case 'gdrive:':
            return new module.exports.gdriveClient({
                            name: url,
                            url: url,
                            path: path.join(u.host, pathname),
                            cred: credFile,
                            args: args
                        }, opts);

        case 'dropbox:':
            return new module.exports.dropboxClient({
                            name: url,
                            url: url,
                            path: path.join(u.host, pathname),
                            cred: credFile,
                            args: args
                        }, opts);


        default:
            throw `Unknown protocol : ${url}`;
    }

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


/** Shows size string in human friendly way
    @param [in] n   - Number to format
    @param [in] fix - Decimal digits to show / negative to trim
    @param [in] blk - Block size
    @param [in] suf - Suffix list
*/
function toHuman(n, fix = 2, blk = 1000, suf=['  B', ' KB', ' MB', ' GB', ' TB', ' PB', ' EB', ' ZB', ' YB'])
{   let i = 0;
    n = parseFloat(n);
    while (blk < n && i+1 < suf.length)
        n /= blk, i++;
    if (0 < fix)
        return `${n.toFixed(fix)}${suf[i]}`;
    else
        return n ? `${trimStr(n.toFixed(-fix), '0.')}${suf[i]}` : `0${suf[0]}`;
}


/** Limits a path length
    @param [in] p   - Path to limit
    @param [in] l   - Size to limit the path to
*/
function limitPath(p, l)
{
    if (p.length <= l)
        return p;

    let pp = p.split('/');
    while (3 < pp.length)
    {   pp.splice(1, 1);
        let ns = path.join(pp[0], '...', pp.slice(1).join('/'));
        if (ns.length <= l)
            return ns;
    }

    if (1 < pp.length)
    {   let ns = `${pp[0]}/.../${pp[pp.length-1]}`;
        if (ns.length <= l)
            return ns;
        return `${ns.slice(0, l - 3)}...`;
    }

    return `.../${pp[pp.length-1].slice(0, l - 7)}...`;
}


/** Default stdout progress
    @param [in] args    - Progress information
                            status      - Operation status
                            progress    - Progress value 0 - 100
                                            if exactly 0, operation is starting
                                            if exactly 100, operation is complete
                            from        - From location
                            to          - To location
                            type        - Operation type, 'file' or 'dir'
    @params [in] opts   - Options
                            timestamp   - Always show timestamp
                            detailed    - Show more details
*/
// function stdoutProgress(status, p, from, to, t)
function stdoutProgress(args, opts)
{
    const col = process.stdout.columns || 100;
    if (20 > col)
        col = 50;

    const mx = col - 2;
    const ovh = args.detailed ? 70 : 10;
    const pl = col - ovh;
    const rr = '\x1b[0G'; // '\r'
    const ts = opts.timestamp ? timeStr() : '';
    if ('file' == args.type)
    {
        let details = '';
        let haveProgress = 0 < args.progress && 100 > args.progress;
        let disp = haveProgress ? (String(args.progress.toFixed(2)).padStart(6,' ')+'% ') : args.status.slice(0, 8).padEnd(8, ' ');

        if (haveProgress && opts.detailed)
            disp = `${disp} | ${toHuman(args.bytesCopied).padStart(6, ' ')} / ${toHuman(args.size).padStart(6, ' ')}`;

        if (haveProgress && opts.detailed)
        {   let et = 0;
            if (args.start_time)
                et = (new Date().getTime() / 1000) - args.start_time;
            if (3 < et)
            {   let bbs = args.bytesCopied / et;
                let etf = args.progress / 100;
                let eta = parseInt(et / etf * (1-etf));
                let etas = String(parseInt(eta % 60)).padStart(2, '0');
                let etam = String(parseInt(eta/60) % 60).padStart(2, '0');
                let etah = parseInt(eta/(60*60));
                etah = String(etah < 100 ? etah : 99).padStart(2, '0');
                details = ` | ${toHuman(bbs).padStart(8, ' ')}/s | ${etah}:${etam}:${etas}`;
            }
        }

        let msg = `${rr}${ts} [${disp}${details}] -> ${limitPath(args.to.length ? args.to : args.from, pl)}`;
        process.stdout.write(msg.slice(0, mx).padEnd(mx,' ') + ((100==args.progress) ? '\r\n' : ''));
    }
    else if ('dir' == args.type)
        process.stdout.write(`${ts} ${rr}<--------> ${limitPath(args.from, pl/2)} => ${limitPath(args.to, pl/2)}\r\n`);
}


/** Pumps the read stream to the write stream
    @param [in] rs          - Read stream
    @param [in] ws          - Write stream
    @param [in] args        - Operation information
                                from : From location
                                to   : To location
                                size : File size

    @param [in] opts        - Options
                                progress    : Optional progress callback function
                                timestamp   : True if timestmap should always be displayed
*/
function pumpStream(rs, ws, args, opts)
{
    return new Promise((resolve, reject) =>
    {
        try
        {
            let done = false;
            let timeout = 0;
            let refreshRate = .25;

            args.start_time = new Date().getTime() / 1000;
            if (opts.progress)
                opts.progress({...args, status:'--------', size:0}, opts);

            ws.on('error', (e) => { /*if (opts.verbose) Log(e);*/ return reject(e); });
            ws.on('finish', () =>
            {   if (done)
                    return;
                done = true;
                if (opts.progress)
                    opts.progress({...args, status:' copied ', progress:100, type:'file'}, opts);
                return resolve(true);
            });
            ws.on('close', () =>
            {   if (done)
                    return;
                done = true;
                if (opts.progress)
                    opts.progress({...args, status:' copied ', progress:100, type:'file'}, opts);
                return resolve(true);
            });

            rs.on('error', (e) => { /*if (opts.verbose) Log(e);*/ return reject(e); });

            //------------------------------------------------------
            // Method 1 - Monitor data written
            //------------------------------------------------------
            // let bytesWritten = 0;
            // rs.on('data', data =>
            // {   ws.write(data, () =>
            //     {   bytesWritten += data.length;
            //         let t = new Date().getTime() / 1000;
            //         if (t > timeout)
            //         {   timeout = t + refreshRate;
            //             let per = bytesWritten / args.size * 100;
            //             if (opts.progress && 0 < per && 100 > per)
            //             {   args.bytesCopied = bytesWritten;
            //                 args.bytesWritten = bytesWritten;
            //                 opts.progress({...args, status:'copying', progress:per, type:'file'}, opts);
            //             }
            //         }
            //     });
            //     return false;
            // });
            // rs.on('end', () => { ws.end(); });

            //------------------------------------------------------
            // Method 2 - Monitor data read
            //------------------------------------------------------
            let bytesRead = 0;
            rs.on('data', data => {
                bytesRead += data.length;
                let t = new Date().getTime() / 1000;
                if (t > timeout)
                {   timeout = t + refreshRate;
                    let per = bytesRead / args.size * 100;
                    if (opts.progress && 0 < per && 100 > per)
                    {   args.bytesCopied = bytesRead;
                        args.bytesRead = bytesRead;
                        opts.progress({...args, status:'copying', progress:per, type:'file'}, opts);
                    }
                }
            });
            rs.pipe(ws);

        }
        catch(e)
        {
            return reject(e);
        }
    });
}

/** Copy files from source to destination
    @param [in] src         - Source object
    @param [in] dst         - Destination object
    @param [in] from        - Source path
    @param [in] to          - Destination path
    @param [in] size        - File size (for progress calculations)
    @param [in] opts        - Options
                                timestamp : True to always show timestmap
                                progress  : Progress callback function
*/
function copyFile(src, dst, from, to, size, opts)
{
    return Promise.all([src.createReadStream(from), dst.createWriteStream(to)])
            .then((a) => { return pumpStream(a[0], a[1],
                                             {   from       : src.getPrefix(from),
                                                 to         : dst.getPrefix(to),
                                                 size       : size
                                             }, opts); });
}


/** Copy directory from source to destination
    @param [in] src         - Source object
    @param [in] dst         - Destination object
    @param [in] from        - Source path
    @param [in] to          - Destination path
    @param [in] opts        - Copy options
                                recursive   : True to recurse into sub directories
                                timestamp   : True to always show timestmap
                                progress    : Progress callback function
*/
function copyDir(src, dst, from, to, opts)
{
    if (opts.progress)
        opts.progress({status:' copy ', progress:100, from:from, to:to, type:'dir'}, opts);
    return dst.mkDir(to, {recursive: true})
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
                                return copyFile(src, dst, v.full, path.join(to, v.name), v.size, opts)
                                        .catch((e) => { if (!opts.skip) throw e; Log('Skipping:', opts.verbose ? e : String(e)); });

                            // Copy sub directories?
                            else if (v.isDir && opts.recursive)
                                return copyDir(src, dst, v.full, opts.flatten ? j.to : path.join(to, v.name), opts);

                            // Skip
                            else
                                return Promise.resolve(false);
                        });
                });
        });
}

/** Compares two file objects to determine if they have changed
    @param [in] a   - First file object
    @param [in] b   - Second file object
*/
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

/** Sync directory from source to destination
    @param [in] src         - Source object
    @param [in] dst         - Destination object
    @param [in] from        - Source path
    @param [in] to          - Destination path
    @param [in] opts        - Copy options
                                recursive   : true to recurse into sub directories
                                filterFiles : Optional regex expression to filter files
                                filterDirs  : Optional regex expression to filter directories
                                upload      : true to upload missing or changed files from source to destination
                                download    : true to download missing files from destination to source
                                                * Changed files will not be downloaded, if that's what you want,
                                                  then switch the source and destination.
                                less        : If true, status of modified or missing files will not be reported
                                progress    : Optional progress callback function

    Only copies files that have changed.
*/
function syncDir(src, dst, from, to, opts)
{
    if (opts.progress)
        opts.progress({status:' sync ', progress:100, from:src.getPrefix(from), to:dst.getPrefix(to), type:'dir'}, opts);
    return dst.mkDir(to, {recursive: true})
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

                        if (!v || !v.full)
                            ;
                        else if (v.isDir)
                        {   if (opts.recursive)
                                jobs.push({item: v, to: to});
                        }
                        else if (v.found && v.match)
                        {   if (opts.progress && !opts.less)
                                opts.progress({status:' up2date', progress:100, from:src.getPrefix(v.full), to:dst.getPrefix(v.other.full), type:'file'}, opts);
                        }
                        else if (!v.found)
                        {   if (opts.upload)
                                jobs.unshift({item: v, to: to});
                            if (opts.progress && !opts.less)
                                opts.progress({status:'missing>', progress:100, from:src.getPrefix(v.full), to:'', type:'file'}, opts);
                        }
                        else if (!v.match)
                        {   if (opts.upload)
                                jobs.unshift({item: v, to: to});
                            if (opts.progress && !opts.less)
                                opts.progress({status:'*changed', progress:100, from:src.getPrefix(v.full), to:dst.getPrefix(v.other.full), type:'file'}, opts);
                        }
                    }

                    // Add jobs for downloading
                    if (!opts.flatten)
                        for (let k in dstList)
                        {
                            let v = dstList[k];

                            if (filterFiles && v.isFile)
                                if (!filterFiles.test(v.name))
                                    continue;

                            if (filterDirs && v.isDir)
                                if (!filterDirs.test(v.name))
                                    continue;

                            if (!v || !v.full)
                                ;
                            else if (v.isDir)
                                ;
                            else if (!v.found)
                            {   if (opts.download)
                                    jobs.unshift({item: v, to: from});
                                if (opts.progress && !opts.less)
                                    opts.progress({status:'<missing', progress:100, from:'', to:dst.getPrefix(v.full), type:'file'}, opts);
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

                            if (!src.isConnected())
                                throw `Source not connected : ${j.src.getPrefix()}`;

                            if (!dst.isConnected())
                                throw `Destination not connected : ${j.src.getPrefix()}`;

                            // Copy files
                            if (v.isFile)
                                return copyFile(src, dst, v.full, path.join(j.to, v.name), v.size, opts)
                                        .catch((e) => { if (!opts.skip) throw e; Log('Skipping:', opts.verbose ? e : String(e)); });

                            // Sync sub directories?
                            else if (v.isDir && opts.recursive)
                                return syncDir(src, dst, v.full, opts.flatten ? j.to : path.join(j.to, v.name), opts);

                            // Skip
                            else
                                return Promise.resolve(false);
                        });
                });
        });
}
