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

    let fake = fmeld.getConnection('fake:///5.20/3.10', null, {verbose: true, throttle: 0});
    let tmpd = fmeld.getConnection(`file://${tmp}`, null, {verbose: true});

    // Copy files from fake tree to temp directory
    (async() => {
        await fmeld.copyDir(fake, tmpd, fake.makePath(), tmpd.makePath(), {recursive: true, batch: 4}, fmeld.stdoutProgress)
                .then((r) => { Log(`Done: ${r}`); })
                .catch((e)=>{ Log(e); failed = e; });
    })();
    if (failed)
        throw failed;

    Log('EOT');
}

/** test_2 - S3 client export and interface checks
    Verifies that:
      - fmeld.s3Client is exported
      - getConnection dispatches s3: URLs to the S3 provider
      - The resulting client exposes the expected interface
      - connect/close lifecycle completes without throwing
        (uses default AWS credential chain — no real bucket is accessed)
*/
function test_2()
{
    Log('Checking fmeld.s3Client is exported...');
    assert.ok(typeof fmeld.s3Client === 'function', 'fmeld.s3Client should be a constructor function');

    Log('Creating S3 client via getConnection...');
    let client = fmeld.getConnection('s3://test-bucket/some/path', null, {verbose: false});
    assert.ok(client, 'getConnection should return a client object for s3:// URLs');

    // Verify the full provider interface is present
    const requiredMethods = [
        'connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
        'createReadStream', 'createWriteStream', 'makePath', 'getPrefix', 'isConnected'
    ];
    for (let m of requiredMethods)
    {
        assert.ok(typeof client[m] === 'function', `s3Client should expose method: ${m}`);
        Log(`  ✓ ${m}`);
    }

    // isConnected should be false before connect()
    assert.strictEqual(client.isConnected(), false, 'isConnected() should be false before connect()');
    Log('  ✓ isConnected() returns false before connect()');

    // makePath and getPrefix should return strings
    let p = client.makePath('sub/dir');
    assert.ok(typeof p === 'string', 'makePath() should return a string');
    Log(`  ✓ makePath('sub/dir') => ${p}`);

    let pfx = client.getPrefix('sub/dir');
    assert.ok(typeof pfx === 'string', 'getPrefix() should return a string');
    assert.ok(pfx.startsWith('s3://'), 'getPrefix() result should start with s3://');
    Log(`  ✓ getPrefix('sub/dir') => ${pfx}`);

    // mkDir is a no-op on S3 and should resolve
    Log('Verifying mkDir resolves (no-op on S3)...');
    return client.mkDir('/any/path', {recursive: true})
        .then(r =>
        {
            assert.ok(r, 'mkDir should resolve with a truthy value');
            Log('  ✓ mkDir() resolved');
        });
}

/** test_3 - S3 connect/close lifecycle
    Verifies that connect() and close() complete without throwing
    when the AWS SDK is initialised with default (environment) credentials.
    No real bucket is accessed; this only tests the lifecycle.
*/
function test_3()
{
    Log('Testing S3 connect/close lifecycle...');

    let client = fmeld.getConnection('s3://test-bucket/path', null, {verbose: false});

    return client.connect()
        .then(r =>
        {
            assert.strictEqual(r, true, 'connect() should resolve with true');
            assert.strictEqual(client.isConnected(), true, 'isConnected() should be true after connect()');
            Log('  ✓ connect() resolved, isConnected() = true');
            return client.close();
        })
        .then(r =>
        {
            assert.strictEqual(r, true, 'close() should resolve with true');
            assert.strictEqual(client.isConnected(), false, 'isConnected() should be false after close()');
            Log('  ✓ close() resolved, isConnected() = false');
        });
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
    let tests = [test_1, test_2, test_3];
    let chain = Promise.resolve();

    for (let k in tests)
    {
        if (!isCmd(run, String(parseInt(k)+1)))
            continue;

        let fn = tests[k];
        chain = chain.then(() =>
        {
            Log('-----------------------------------------------------------');
            Log(` - ${fn.name}()`);
            Log('-----------------------------------------------------------\n');
            return Promise.resolve().then(() => fn())
                .then(() => { Log(`\n  [ PASSED ] ${fn.name}\n`); })
                .catch(e => { Err(`\n  [ FAILED ] ${fn.name}: ${e}\n`); });
        });
    }

    chain.then(() => { Log('--- Done ---\n'); });
}

// Exit handling
process.on('exit',function() { Log('~ exit ~');});
process.on('SIGINT',function() { Log('~ keyboard ~'); process.exit(-1); });
process.on('uncaughtException',function(e) { Log('~ uncaught ~', e); process.exit(-1); });

// Run the program
main();
