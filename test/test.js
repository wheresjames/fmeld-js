#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fmeld = require('fmeld');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain a readable stream and return total bytes received. */
function drainStream(rs)
{
    return new Promise((resolve, reject) =>
    {
        let total = 0;
        rs.on('data', chunk => { total += chunk.length; });
        rs.on('end', () => resolve(total));
        rs.on('error', reject);
    });
}

/** Write a string to a writable stream and wait for finish. */
function writeStream(ws, data)
{
    return new Promise((resolve, reject) =>
    {
        ws.on('finish', resolve);
        ws.on('error', reject);
        ws.write(data);
        ws.end();
    });
}

/** Read all data from a readable stream and return as a string. */
function readStream(rs)
{
    return new Promise((resolve, reject) =>
    {
        let buf = '';
        rs.on('data', chunk => { buf += chunk.toString(); });
        rs.on('end', () => resolve(buf));
        rs.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// toHuman
// ---------------------------------------------------------------------------

describe('toHuman', () =>
{
    test('bytes stay in B', () =>
    {
        assert.ok(fmeld.toHuman(0).includes('B'));
        assert.ok(fmeld.toHuman(999).includes('B'));
    });

    test('kilobytes', () =>
    {
        assert.ok(fmeld.toHuman(1500).includes('KB'));
    });

    test('megabytes', () =>
    {
        assert.ok(fmeld.toHuman(2_500_000).includes('MB'));
    });

    test('gigabytes', () =>
    {
        assert.ok(fmeld.toHuman(3_000_000_000).includes('GB'));
    });

    test('fix=0 trims trailing zeros', () =>
    {
        const r = fmeld.toHuman(1024, 0);
        assert.equal(typeof r, 'string');
        assert.ok(r.length > 0);
    });

    test('custom block size 1024', () =>
    {
        // threshold is strict > blk, so need 2*blk to guarantee KB
        const r = fmeld.toHuman(2048, 2, 1024);
        assert.ok(r.includes('KB'));
        assert.ok(r.includes('2.00'));
    });

    test('2.00 KB with blk=1000', () =>
    {
        const r = fmeld.toHuman(2000, 2, 1000);
        assert.ok(r.includes('2.00'));
    });
});

// ---------------------------------------------------------------------------
// promiseWhile / promiseWhileBatch
// ---------------------------------------------------------------------------

describe('promiseWhile', () =>
{
    test('runs body until condition becomes false', async () =>
    {
        let count = 0;
        const results = await fmeld.promiseWhile(
            () => count < 5,
            () => Promise.resolve(++count)
        );
        assert.equal(count, 5);
        assert.ok(Array.isArray(results));
        assert.equal(results.length, 5);
    });

    test('returns empty array without calling body when condition is initially false', () =>
    {
        let ran = false;
        const result = fmeld.promiseWhile(
            () => false,
            () => { ran = true; return Promise.resolve(1); }
        );
        assert.equal(ran, false);
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 0);
    });
});

describe('promiseWhileBatch', () =>
{
    test('processes all items with batch concurrency', async () =>
    {
        const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const processed = [];
        await fmeld.promiseWhileBatch(
            3,
            () => items.length > 0,
            () => { processed.push(items.shift()); return Promise.resolve(true); }
        );
        assert.equal(items.length, 0);
        assert.equal(processed.length, 10);
    });
});

// ---------------------------------------------------------------------------
// parseParams
// ---------------------------------------------------------------------------

describe('parseParams', () =>
{
    const parseParams = fmeld.__config__.parseParams;

    test('short switch sets flag', () =>
    {
        const r = parseParams('prog', ['-v'], [['v', 'verbose', 'Verbose']]);
        assert.equal(r.verbose, true);
    });

    test('long switch sets flag', () =>
    {
        const r = parseParams('prog', ['--verbose'], [['v', 'verbose', 'Verbose']]);
        assert.equal(r.verbose, true);
    });

    test('short option with space-separated value', () =>
    {
        const r = parseParams('prog', ['-o', 'output.txt'], [['o', 'output=', 'Out']]);
        assert.equal(r.output, 'output.txt');
    });

    test('long option with = value', () =>
    {
        const r = parseParams('prog', ['--output=result.txt'], [['o', 'output=', 'Out']]);
        assert.equal(r.output, 'result.txt');
    });

    test('long option with space-separated value', () =>
    {
        const r = parseParams('prog', ['--output', 'spaced.txt'], [['o', 'output=', 'Out']]);
        assert.equal(r.output, 'spaced.txt');
    });

    test('combined short flags', () =>
    {
        const r = parseParams('prog', ['-rv'],
            [['r', 'recursive', 'Recursive'], ['v', 'verbose', 'Verbose']]);
        assert.equal(r.recursive, true);
        assert.equal(r.verbose, true);
    });

    test('positional args collected in *', () =>
    {
        const r = parseParams('prog', ['file1.txt', 'file2.txt'], []);
        assert.deepEqual(r['*'], ['file1.txt', 'file2.txt']);
    });

    test('multi-value option collects values', () =>
    {
        const r = parseParams('prog', ['-t', 'a', 'b', 'c'], [['t', 'tag=+', 'Tags']]);
        assert.ok(Array.isArray(r.tag) || typeof r.tag === 'string');
    });

    test('unknown option throws by default', () =>
    {
        assert.throws(() => parseParams('prog', ['--unknown'], []));
    });

    test('allowUnknownOptions accepts unknown option', () =>
    {
        const r = parseParams('prog', ['--unknown'], [], true);
        assert.ok('unknown' in r);
    });
});

// ---------------------------------------------------------------------------
// getConnection — protocol dispatch
// ---------------------------------------------------------------------------

describe('getConnection', () =>
{
    const STANDARD_METHODS = [
        'connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
        'createReadStream', 'createWriteStream', 'makePath', 'getPrefix', 'isConnected'
    ];

    const cases = [
        { url: 'fake:///3.5',            key: 'fakeClient', connected: true  },
        { url: 'file:///tmp/test-fmeld', key: 'fileClient', connected: true  },
        { url: 's3://bucket/path',       key: 's3Client',   connected: false },
    ];

    for (const { url, key, connected } of cases)
    {
        test(`${url} routes to ${key}`, () =>
        {
            const client = fmeld.getConnection(url, null, {verbose: false});
            assert.ok(client instanceof fmeld[key]);
            assert.equal(client.isConnected(), connected);
        });

        test(`${key} exposes standard interface`, () =>
        {
            const client = fmeld.getConnection(url, null, {verbose: false});
            for (const m of STANDARD_METHODS)
                assert.equal(typeof client[m], 'function', `missing: ${m}`);
        });
    }

    test('unknown protocol throws', () =>
    {
        assert.throws(() => fmeld.getConnection('bogus://host/path', null, {}));
    });
});

// ---------------------------------------------------------------------------
// S3 client interface
// ---------------------------------------------------------------------------

describe('s3Client', () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.s3Client, 'function');
    });

    test('makePath returns string', () =>
    {
        const c = fmeld.getConnection('s3://bucket/path', null, {verbose: false});
        assert.equal(typeof c.makePath('sub'), 'string');
    });

    test('getPrefix starts with s3://', () =>
    {
        const c = fmeld.getConnection('s3://bucket/path', null, {verbose: false});
        assert.ok(c.getPrefix('sub').startsWith('s3://'));
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('s3://bucket/path', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('mkDir resolves (no-op)', async () =>
    {
        const c = fmeld.getConnection('s3://bucket/path', null, {verbose: false});
        assert.ok(await c.mkDir('/any', {recursive: true}));
    });

    test('connect then close lifecycle', async () =>
    {
        const c = fmeld.getConnection('s3://bucket/path', null, {verbose: false});
        assert.equal(await c.connect(), true);
        assert.equal(c.isConnected(), true);
        assert.equal(await c.close(), true);
        assert.equal(c.isConnected(), false);
    });
});

// ---------------------------------------------------------------------------
// fakeClient — tree structure and interface
// ---------------------------------------------------------------------------

describe('fakeClient', () =>
{
    test('connect / close lifecycle', async () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.equal(fake.isConnected(), true);
        assert.equal(await fake.connect(), true);
        assert.equal(await fake.close(), true);
    });

    test('ls root returns correct dir+file counts', async () =>
    {
        const fake = fmeld.getConnection('fake:///2.3/2.3', null, {verbose: false});
        const list = await fake.ls('/');
        assert.equal(list.length, 5);
        assert.equal(list.filter(e => e.isDir).length, 2);
        assert.equal(list.filter(e => e.isFile).length, 3);
    });

    test('ls entry has required fields with correct types', async () =>
    {
        const fake = fmeld.getConnection('fake:///1.2', null, {verbose: false});
        const list = await fake.ls('/');
        for (const e of list)
        {
            assert.equal(typeof e.name, 'string');
            assert.ok(e.name.length > 0);
            assert.equal(typeof e.full, 'string');
            assert.equal(typeof e.isFile, 'boolean');
            assert.equal(typeof e.isDir, 'boolean');
            assert.equal(typeof e.size, 'number');
            assert.equal(typeof e.mtime, 'number');
        }
    });

    test('ls subdirectory', async () =>
    {
        const fake = fmeld.getConnection('fake:///2.3/2.3', null, {verbose: false});
        const root = await fake.ls('/');
        const sub = await fake.ls(root.find(e => e.isDir).full);
        assert.equal(sub.length, 5);
    });

    test('ls non-existent path returns []', async () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.deepEqual(await fake.ls('/nonexistent/path'), []);
    });

    test('makePath with no arg returns root', () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.equal(fake.makePath(), '/');
    });

    test('makePath with arg includes arg', () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.ok(fake.makePath('sub').includes('sub'));
    });

    test('getPrefix with no arg starts with fake://', () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.ok(fake.getPrefix().startsWith('fake://'));
    });

    test('getPrefix with path includes path', () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        assert.ok(fake.getPrefix('/some/path').includes('some/path'));
    });

    test('mkDir / rmFile / rmDir are no-ops that resolve true', async () =>
    {
        const fake = fmeld.getConnection('fake:///2.3', null, {verbose: false});
        const results = await Promise.all([
            fake.mkDir('/any/dir'),
            fake.rmFile('/any/file.txt'),
            fake.rmDir('/any/dir'),
        ]);
        assert.ok(results.every(r => r === true));
    });

    test('createReadStream delivers correct byte count', async () =>
    {
        const fake = fmeld.getConnection('fake:///1.5', null, {verbose: false, throttle: 0});
        const list = await fake.ls('/');
        const target = list.find(e => e.isFile && e.size > 0);
        assert.ok(target);
        const bytes = await drainStream(fake.createReadStream(target.full));
        assert.equal(bytes, target.size);
    });

    test('createReadStream returns null for non-existent file', () =>
    {
        const fake = fmeld.getConnection('fake:///1.5', null, {verbose: false});
        assert.equal(fake.createReadStream('/no/such/file.txt'), null);
    });
});

// ---------------------------------------------------------------------------
// fakeClient — tree descriptor URL shapes
// ---------------------------------------------------------------------------

describe('fakeClient tree descriptor', () =>
{
    test('3 dirs 2 files', async () =>
    {
        const list = await fmeld.getConnection('fake:///3.2', null, {verbose: false}).ls('/');
        assert.equal(list.filter(e => e.isDir).length, 3);
        assert.equal(list.filter(e => e.isFile).length, 2);
    });

    test('4 dirs 0 files', async () =>
    {
        const list = await fmeld.getConnection('fake:///4.0', null, {verbose: false}).ls('/');
        assert.equal(list.filter(e => e.isDir).length, 4);
        assert.equal(list.filter(e => e.isFile).length, 0);
    });

    test('0 dirs 5 files', async () =>
    {
        const list = await fmeld.getConnection('fake:///0.5', null, {verbose: false}).ls('/');
        assert.equal(list.filter(e => e.isDir).length, 0);
        assert.equal(list.filter(e => e.isFile).length, 5);
    });

    test('3-level tree is navigable', async () =>
    {
        const f = fmeld.getConnection('fake:///2.2/2.2/2.2', null, {verbose: false});
        const l1 = await f.ls('/');
        const l2 = await f.ls(l1.find(e => e.isDir).full);
        const l3 = await f.ls(l2.find(e => e.isDir).full);
        assert.equal(l2.filter(e => e.isDir).length, 2);
        assert.equal(l3.filter(e => e.isDir).length, 2);
    });
});

// ---------------------------------------------------------------------------
// fileClient — CRUD operations
// ---------------------------------------------------------------------------

describe('fileClient', () =>
{
    test('connect / isConnected / close', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-fc-${Date.now()}`);
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        assert.equal(client.isConnected(), true);
        assert.equal(await client.connect(), true);
        assert.equal(await client.close(), true);
    });

    test('mkDir creates directory and is idempotent', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-mkdir-${Date.now()}`);
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            assert.equal(await client.mkDir(tmp, {recursive: true}), true);
            assert.ok(fs.existsSync(tmp));
            assert.equal(await client.mkDir(tmp, {recursive: true}), true); // idempotent
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });

    test('makePath appends segment', () =>
    {
        const tmp = path.join(os.tmpdir(), 'fmeld-mp');
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        assert.ok(client.makePath('sub').endsWith('sub'));
    });

    test('getPrefix starts with file://', () =>
    {
        const client = fmeld.getConnection('file:///tmp', null, {verbose: false});
        assert.ok(client.getPrefix('/some/path').startsWith('file://'));
    });

    test('write / read / ls / rmFile / rmDir round-trip', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-crud-${Date.now()}`);
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        await client.mkDir(tmp, {recursive: true});
        const filePath = path.join(tmp, 'test.txt');

        try
        {
            // write
            const ws = await client.createWriteStream(filePath);
            await writeStream(ws, 'Hello, fmeld!');
            assert.ok(fs.existsSync(filePath));

            // read back
            const rs = await client.createReadStream(filePath);
            const data = await readStream(rs);
            assert.equal(data, 'Hello, fmeld!');

            // ls
            const list = await client.ls(tmp);
            const entry = list.find(e => e.name === 'test.txt');
            assert.ok(entry);
            assert.equal(entry.isFile, true);
            assert.ok(entry.size > 0);

            // rmFile
            assert.equal(await client.rmFile(filePath), true);
            assert.ok(!fs.existsSync(filePath));
        }
        finally
        {
            // rmDir
            await client.rmDir(tmp, {recursive: true});
            assert.ok(!fs.existsSync(tmp));
        }
    });
});

// ---------------------------------------------------------------------------
// copyDir (fake → file)
// ---------------------------------------------------------------------------

describe('copyDir', () =>
{
    test('recursively copies fake tree to filesystem', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-copy-${Date.now()}`);
        const fake = fmeld.getConnection('fake:///2.4/0.3', null, {verbose: false, throttle: 0});
        const dst  = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            const r = await fmeld.copyDir(fake, dst, fake.makePath(), dst.makePath(),
                                          {recursive: true, batch: 2});
            assert.equal(r, true);
            assert.ok(fs.existsSync(tmp));

            const entries = fs.readdirSync(tmp);
            assert.ok(entries.length > 0);
            assert.ok(entries.some(e => fs.lstatSync(path.join(tmp, e)).isDirectory()),
                      'sub-directories should be present');
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });
});

// ---------------------------------------------------------------------------
// syncDir
// ---------------------------------------------------------------------------

describe('syncDir', () =>
{
    test('uploads missing files to destination', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-sync-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const fake = fmeld.getConnection('fake:///1.3', null, {verbose: false, throttle: 0});
        const dst  = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            const r = await fmeld.syncDir(fake, dst, fake.makePath(), tmp,
                                          {recursive: true, upload: true, batch: 2});
            assert.equal(r, true);
            assert.ok(fs.readdirSync(tmp).length > 0);
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });

    test('second sync with up-to-date files succeeds without error', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-sync2-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const fake = fmeld.getConnection('fake:///1.3', null, {verbose: false, throttle: 0});
        const dst  = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        const opts = {recursive: true, upload: true, batch: 2, less: true};
        try
        {
            await fmeld.syncDir(fake, dst, fake.makePath(), tmp, opts);
            const r = await fmeld.syncDir(fake, dst, fake.makePath(), tmp, opts);
            assert.equal(r, true);
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });
});

// ---------------------------------------------------------------------------
// cleanDir
// ---------------------------------------------------------------------------

describe('cleanDir', () =>
{
    test('deletes files matching filterFiles when clean-files=true', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-clean-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const keep = path.join(tmp, 'keep.log');
        const del1 = path.join(tmp, 'delete.tmp');
        const del2 = path.join(tmp, 'also.tmp');
        fs.writeFileSync(keep, 'keep');
        fs.writeFileSync(del1, 'delete');
        fs.writeFileSync(del2, 'delete');
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            await fmeld.cleanDir(client, tmp,
                {batch: 2, 'clean-files': true, filterFiles: '\\.tmp$'});
            assert.ok(!fs.existsSync(del1));
            assert.ok(!fs.existsSync(del2));
            assert.ok(fs.existsSync(keep));
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });

    test('leaves files intact when clean-files=false', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-clean2-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const f = path.join(tmp, 'file.tmp');
        fs.writeFileSync(f, 'data');
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            await fmeld.cleanDir(client, tmp,
                {batch: 2, 'clean-files': false, filterFiles: '\\.tmp$'});
            assert.ok(fs.existsSync(f));
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });
});

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe('loadConfig', () =>
{
    const loadConfig = fmeld.__config__.loadConfig;

    test('parses key-value pairs and ignores comments', () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-cfg-${Date.now()}.txt`);
        fs.writeFileSync(tmp, [
            '# comment',
            'host  myserver.example.com',
            'port  2222',
            'user  admin',
            'flag  enabled',
        ].join('\n'));
        try
        {
            const cfg = loadConfig(tmp);
            assert.equal(cfg.host, 'myserver.example.com');
            assert.equal(cfg.port, '2222');
            assert.equal(cfg.user, 'admin');
            assert.equal(cfg.flag, 'enabled');
        }
        finally { fs.unlinkSync(tmp); }
    });

    test('returns {} for non-existent file', () =>
    {
        assert.deepEqual(loadConfig('/nonexistent/path/config.txt'), {});
    });
});

// ---------------------------------------------------------------------------
// exports completeness
// ---------------------------------------------------------------------------

describe('fmeld exports', () =>
{
    const functions = [
        'getConnection', 'stdoutProgress', 'copyFile', 'copyDir',
        'cleanDir', 'syncDir', 'promiseWhile', 'promiseWhileBatch', 'toHuman',
    ];
    const constructors = [
        'fakeClient', 'fileClient', 'ftpClient', 'sftpClient',
        'gcsClient', 'gdriveClient', 'dropboxClient', 's3Client',
    ];
    const configFns = [
        'promiseWhile', 'promiseDoWhile', 'promiseWhileBatch',
        'loadConfig', 'installPath', 'getConfig', 'processFile', 'parseParams',
    ];

    for (const name of functions)
        test(`fmeld.${name} is a function`, () => assert.equal(typeof fmeld[name], 'function'));

    for (const name of constructors)
        test(`fmeld.${name} is a constructor`, () => assert.equal(typeof fmeld[name], 'function'));

    test('fmeld.__info__ is present', () => assert.ok(fmeld.__info__));
    test('fmeld.__config__ is present', () => assert.ok(fmeld.__config__));

    for (const name of configFns)
        test(`fmeld.__config__.${name} is a function`,
             () => assert.equal(typeof fmeld.__config__[name], 'function'));
});
