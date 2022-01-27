#!/usr/bin/env nodejs
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sparen = require('sparen');

const Log = sparen.log;
const Err = sparen.error;
const Fmt = JSON.stringify;

const fmeld = require('fmeld');

require("util").inspect.defaultOptions.depth = null;

function test_1()
{
    let failed = false;
    let tmp = path.join(os.tmpdir(), 'fmeld-test');
    Log(`Temp path: ${tmp}`);

    let fake = fmeld.getConnection('fake:///5.20/3.10', {verbose: true, throttle: 0});
    let tmpd = fmeld.getConnection(`file://${tmp}`, {verbose: true});

    // Copy files from fake tree to temp directory
    (async() => {
        await fmeld.copyDir(fake, tmpd, fake.makePath(), tmpd.makePath(), {recursive: true}, fmeld.stdoutProgress)
                .then((r) => { Log(`Done: ${r}`); })
                .catch((e)=>{ Log(e); failed = e; });
    })();
    if (failed)
        throw failed;

    Log('EOT');

}

function isCmd(lst, cmd)
{
    return !lst || !lst.length ||  0 <= `,${lst.toLowerCase()},`.indexOf(`,${cmd.toLowerCase()},`);
}

function main()
{
    let run = process.argv.slice(2).join(',');

    Log(Fmt(fmeld.__info__, null, 2));
    Log("--- START TESTS ---\n");

    // Run tests
    let tests = [test_1];
    for (let k in tests)
        if (isCmd(run, String(parseInt(k)+1)))
        {   Log('-----------------------------------------------------------');
            Log(` - ${tests[k].name}()`);
            Log('-----------------------------------------------------------\n');
            tests[k]();
        }

    Log('--- Done ---\n');
}

// Exit handling
process.on('exit',function() { Log('~ exit ~');});
process.on('SIGINT',function() { Log('~ keyboard ~'); process.exit(-1); });
process.on('uncaughtException',function(e) { Log('~ uncaught ~', e); process.exit(-1); });

// Run the program
main();

