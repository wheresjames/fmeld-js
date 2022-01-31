#!/usr/bin/env nodejs
'use strict';

const os = require('os');
const path = require('path');

    const fmeld = require('fmeld');
    const Log = console.log;

    // Connect to ftp server
    let ftp = fmeld.getConnection('ftp://192.168.1.250/', null, {verbose: true});
    ftp.connect().then((r) => {

            // Show directory
            (async() => { await ftp.ls('/')
                                    .then((r)=>{ Log(r); })
                                    .catch((e)=>{ Log(e); });
                });

            // Sync files to local temp directory
            let tmpd = fmeld.getConnection(`file://${path.join(os.tmpdir(), 'test')}`, null, {verbose: true});
            tmpd.connect().then((r) => {
                    (async() => {
                    await fmeld.syncDir(ftp, tmpd, ftp.makePath(), tmpd.makePath(), {recursive: true, upload: true}, fmeld.stdoutProgress)
                            .then((r) => { Log(`Done: ${r}`); })
                            .catch((e)=>{ Log(e); });
                    })();
                });

        })
        .catch((e)=>{ Log(e); });
