#!/usr/bin/env nodejs
'use strict';

const os = require('os');
const path = require('path');

    const fmeld = require('fmeld');
    const Log = console.log;

    // Connect to ftp server
    let tmpd = null;

    // Connect to ftp
    let ftp = fmeld.getConnection('ftp://guest:guest@192.168.1.250/backup', null, {verbose: true});
    ftp.connect()

        // List files on ftp server
        .then((r) =>
        {
            return ftp.ls('/');
        })

        // Connect to local temporary directory
        .then(r =>
        {
            Log(r);

            tmpd = fmeld.getConnection(`file://${path.join(os.tmpdir(), 'test')}`, null, {verbose: true});
            return tmpd.connect();
        })

        // Sync files from ftp server to local temporary directory
        .then(r =>
        {
            return fmeld.syncDir(ftp, tmpd, ftp.makePath(), tmpd.makePath(),
                                 {recursive: true, upload: true, progress: fmeld.stdoutProgress})
        })

        // Done
        .then(r =>
        {
            Log('Done');
        })

        // Errors
        .catch((e)=>{ Log(e); });

