#!/usr/bin/env node
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const fmeld = require('..');
const setup = require('..').setup;

// ---------------------------------------------------------------------------
// Optional-dependency availability checks
// ---------------------------------------------------------------------------

function pkgAvailable(name) { try { require(name); return true; } catch { return false; } }

// Use fmeld's own pkgAvailable so we test the real implementation
const { pkgAvailable: setupPkgAvailable } = setup;

const HAS_S3     = pkgAvailable('@aws-sdk/client-s3') && pkgAvailable('@aws-sdk/lib-storage');
const HAS_WEBDAV = pkgAvailable('webdav');
const HAS_AZBLOB = pkgAvailable('@azure/storage-blob');
const HAS_MSAL   = pkgAvailable('@azure/msal-node');
const HAS_SMB2   = pkgAvailable('@marsaud/smb2');
const HAS_BOX    = pkgAvailable('box-node-sdk');
const HAS_ADB    = pkgAvailable('@devicefarmer/adbkit');
const HAS_ZIP    = pkgAvailable('unzipper') && pkgAvailable('archiver');

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
// parseSize
// ---------------------------------------------------------------------------

describe('parseSize', () =>
{
    test('plain integer string', () => { assert.strictEqual(fmeld.parseSize('1024'), 1024); });
    test('bare number passes through', () => { assert.strictEqual(fmeld.parseSize(512), 512); });
    test('null returns null', () => { assert.strictEqual(fmeld.parseSize(null), null); });
    test('empty string returns null', () => { assert.strictEqual(fmeld.parseSize(''), null); });
    test('B suffix', () => { assert.strictEqual(fmeld.parseSize('500B'), 500); });
    test('KB (SI)', () => { assert.strictEqual(fmeld.parseSize('10KB'), 10_000); });
    test('MB (SI)', () => { assert.strictEqual(fmeld.parseSize('10MB'), 10_000_000); });
    test('GB (SI)', () => { assert.strictEqual(fmeld.parseSize('1GB'), 1_000_000_000); });
    test('TB (SI)', () => { assert.strictEqual(fmeld.parseSize('2TB'), 2_000_000_000_000); });
    test('KiB (IEC)', () => { assert.strictEqual(fmeld.parseSize('1KiB'), 1024); });
    test('MiB (IEC)', () => { assert.strictEqual(fmeld.parseSize('1MiB'), 1048576); });
    test('GiB (IEC)', () => { assert.strictEqual(fmeld.parseSize('1GiB'), 1073741824); });
    test('case-insensitive unit', () => { assert.strictEqual(fmeld.parseSize('5mb'), 5_000_000); });
    test('decimal value', () => { assert.strictEqual(fmeld.parseSize('1.5MB'), 1_500_000); });
    test('space between number and unit', () => { assert.strictEqual(fmeld.parseSize('2 GB'), 2_000_000_000); });
    test('unknown unit throws', () => { assert.throws(() => fmeld.parseSize('10XB'), /Unknown size unit/); });
    test('non-numeric input throws', () => { assert.throws(() => fmeld.parseSize('abc'), /Invalid size/); });
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
        { url: 'fake:///3.5',             key: 'fakeClient',   connected: true  },
        { url: 'file:///tmp/test-fmeld',  key: 'fileClient',   connected: true  },
        { url: 'zip:///tmp/test.zip',     key: 'zipClient',    connected: false },
        { url: 'ftp://user:pass@host/path',   key: 'ftpClient',  connected: false },
        { url: 'ftps://user:pass@host/path',  key: 'ftpClient',  connected: false },
        { url: 'sftp://user:pass@host/path',  key: 'sftpClient', connected: false },
        ...(HAS_S3 ? [
            { url: 's3://bucket/path',    key: 's3Client',     connected: false },
        ] : []),
        ...(HAS_WEBDAV ? [
            { url: 'webdav://myhost/path',    key: 'webdavClient', connected: false },
            { url: 'webdavs://myhost/path',   key: 'webdavClient', connected: false },
        ] : []),
        ...(HAS_AZBLOB ? [
            { url: 'azure://mycontainer/sub', key: 'azblobClient', connected: false },
            { url: 'azblob://mycontainer/sub',key: 'azblobClient', connected: false },
            { url: 'abs://mycontainer/sub',   key: 'azblobClient', connected: false },
        ] : []),
        ...(HAS_SMB2 ? [
            { url: 'smb://user:pass@server/share',      key: 'smbClient', connected: false },
            { url: 'cifs://user:pass@server/share/sub', key: 'smbClient', connected: false },
        ] : []),
    ];
    // Box requires a real credential file so it is excluded from the routing table above,
    // but it IS wired into getConnection — verified by the "every scheme" test below.

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

    test('onedrive:// without credentials throws', () =>
    {
        assert.throws(() => fmeld.getConnection('onedrive://Documents', null, {}));
    });

    test('missing optional package throws BACKEND_NOT_INSTALLED, not a raw module error', () =>
    {
        // @marsaud/smb2 is in optionalDependencies and not currently installed
        // — the typed error lets callers offer a helpful install prompt
        try
        {
            fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        }
        catch(e)
        {
            assert.equal(e.code, 'BACKEND_NOT_INSTALLED',
                `expected BACKEND_NOT_INSTALLED, got: ${String(e)}`);
            assert.equal(typeof e.pkg,  'string', 'e.pkg should be a string');
            assert.equal(typeof e.hint, 'string', 'e.hint should be a string');
            assert.ok(Array.isArray(e.allPkgs),   'e.allPkgs should be an array');
            assert.ok(e.allPkgs.includes(e.pkg),  'e.allPkgs should include e.pkg');
        }
    });

    test('absolute path is treated as file://', () =>
    {
        const client = fmeld.getConnection('/tmp/fmeld-test', null, {verbose: false});
        assert.ok(client instanceof fmeld.fileClient);
        assert.equal(client.makePath(), '/tmp/fmeld-test');
    });

    test('relative ./path is resolved to an absolute file://', () =>
    {
        const client = fmeld.getConnection('./some/dir', null, {verbose: false});
        assert.ok(client instanceof fmeld.fileClient);
        assert.equal(client.makePath(), path.resolve('./some/dir'));
    });

    test('../path is resolved to an absolute file://', () =>
    {
        const client = fmeld.getConnection('../other', null, {verbose: false});
        assert.ok(client instanceof fmeld.fileClient);
        assert.equal(client.makePath(), path.resolve('../other'));
    });

    test('~/path is expanded to home directory file://', () =>
    {
        const os = require('os');
        const client = fmeld.getConnection('~/photos', null, {verbose: false});
        assert.ok(client instanceof fmeld.fileClient);
        assert.equal(client.makePath(), path.join(os.homedir(), 'photos'));
    });

    test('bare .zip path routes to zipClient', () =>
    {
        const client = fmeld.getConnection('/tmp/archive.zip', null, {verbose: false});
        assert.ok(client instanceof fmeld.zipClient);
        assert.equal(client.makePath(), '/tmp/archive.zip');
    });

    test('relative .zip path routes to zipClient with resolved path', () =>
    {
        const client = fmeld.getConnection('./backup.zip', null, {verbose: false});
        assert.ok(client instanceof fmeld.zipClient);
        assert.equal(client.makePath(), path.resolve('./backup.zip'));
    });

    test('~/path to .zip routes to zipClient', () =>
    {
        const os = require('os');
        const client = fmeld.getConnection('~/Backup/test.zip', null, {verbose: false});
        assert.ok(client instanceof fmeld.zipClient);
        assert.equal(client.makePath(), path.join(os.homedir(), 'Backup/test.zip'));
    });

    test('explicit file:// with .zip extension routes to zipClient', () =>
    {
        const client = fmeld.getConnection('file:///tmp/archive.zip', null, {verbose: false});
        assert.ok(client instanceof fmeld.zipClient);
        assert.equal(client.makePath(), '/tmp/archive.zip');
    });

    test('explicit zip:// is unaffected by extension routing', () =>
    {
        const client = fmeld.getConnection('zip:///tmp/archive.zip', null, {verbose: false});
        assert.ok(client instanceof fmeld.zipClient);
    });

    test('file:// path without known extension stays as fileClient', () =>
    {
        const client = fmeld.getConnection('file:///tmp/somedir', null, {verbose: false});
        assert.ok(client instanceof fmeld.fileClient);
    });

    test('every scheme in the BACKENDS registry is handled by getConnection', () =>
    {
        // Guarantees that adding a backend to the registry without wiring it into
        // getConnection's switch is caught immediately.
        const schemeUrls =
        {
            'sftp:'     : 'sftp://user:pass@host/path',
            'ftp:'      : 'ftp://user:pass@host/path',
            'ftps:'     : 'ftps://user:pass@host/path',
            'webdav:'   : 'webdav://host/path',
            'webdavs:'  : 'webdavs://host/path',
            'smb:'      : 'smb://user:pass@host/share',
            'cifs:'     : 'cifs://user:pass@host/share',
            'gs:'       : 'gs://mybucket/path',
            'gcs:'      : 'gcs://mybucket/path',
            'gdrive:'   : 'gdrive://docs/sub',
            'dropbox:'  : 'dropbox:///uploads',
            's3:'       : 's3://mybucket/path',
            'azure:'    : 'azure://mycontainer/path',
            'azblob:'   : 'azblob://mycontainer/path',
            'abs:'      : 'abs://mycontainer/path',
            'onedrive:' : 'onedrive://Documents',
            'box:'      : 'box:///my-folder',
            'adb:'      : 'adb:///sdcard/',
            'zip:'      : 'zip:///tmp/test.zip',
        };

        for (const b of fmeld.setup.BACKENDS)
        {
            for (const scheme of b.schemes)
            {
                const url = schemeUrls[scheme];
                assert.ok(url, `no test URL defined for scheme ${scheme}`);

                try
                {
                    fmeld.getConnection(url, null, {verbose: false});
                    // If it didn't throw, the package is installed — that's fine
                }
                catch(e)
                {
                    const msg = String(e.message || e);
                    assert.ok(
                        !msg.toLowerCase().includes('unknown protocol'),
                        `${scheme} fell through to "Unknown protocol" — ` +
                        `add it to getConnection's switch statement`
                    );
                }
            }
        }
    });
});

// ---------------------------------------------------------------------------
// S3 client interface
// ---------------------------------------------------------------------------

describe('s3Client', { skip: !HAS_S3 ? '@aws-sdk/client-s3 package not installed' : false }, () =>
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
// ftpClient — offline interface tests (ftp is a default dependency)
// ---------------------------------------------------------------------------

describe('ftpClient', () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.ftpClient, 'function');
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('ftp://user:pass@host/path', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('makePath returns string containing sub-path', () =>
    {
        const c = fmeld.getConnection('ftp://user:pass@host/data', null, {verbose: false});
        assert.equal(typeof c.makePath('sub'), 'string');
        assert.ok(c.makePath('sub').includes('sub'));
    });

    test('getPrefix starts with ftp://', () =>
    {
        const c = fmeld.getConnection('ftp://user:pass@host/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('ftp://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('port is reflected in prefix', () =>
    {
        const c = fmeld.getConnection('ftp://user:pass@host:2121/path', null, {verbose: false});
        assert.ok(c.getPrefix().includes('2121'));
    });

    test('ftps:// scheme produces ftps:// prefix', () =>
    {
        const c = fmeld.getConnection('ftps://user:pass@host/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('ftps://'));
    });

    test('ftps:// defaults to port 21 (explicit TLS)', () =>
    {
        const c = fmeld.getConnection('ftps://user:pass@host/path', null, {verbose: false});
        assert.ok(c.getPrefix().includes(':21'));
    });

    test('ftps:// routes to ftpClient', () =>
    {
        const c = fmeld.getConnection('ftps://user:pass@host/path', null, {verbose: false});
        assert.ok(c instanceof fmeld.ftpClient);
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('ftp://user:pass@host/path', null, {verbose: false});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });
});

// ---------------------------------------------------------------------------
// sftpClient — offline interface tests (ssh2 is a default dependency)
// ---------------------------------------------------------------------------

describe('sftpClient', () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.sftpClient, 'function');
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('sftp://user:pass@host/path', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('makePath returns string containing sub-path', () =>
    {
        const c = fmeld.getConnection('sftp://user:pass@host/data', null, {verbose: false});
        assert.equal(typeof c.makePath('sub'), 'string');
        assert.ok(c.makePath('sub').includes('sub'));
    });

    test('getPrefix starts with sftp://', () =>
    {
        const c = fmeld.getConnection('sftp://user:pass@host/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('sftp://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('port is reflected in prefix', () =>
    {
        const c = fmeld.getConnection('sftp://user:pass@host:2222/path', null, {verbose: false});
        assert.ok(c.getPrefix().includes('2222'));
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('sftp://user:pass@host/path', null, {verbose: false});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });
});

// ---------------------------------------------------------------------------
// webdavClient — offline interface tests
// ---------------------------------------------------------------------------

describe('webdavClient', { skip: !HAS_WEBDAV ? 'webdav package not installed' : false }, () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.webdavClient, 'function');
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('makePath returns string', () =>
    {
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        assert.equal(typeof c.makePath('sub'), 'string');
        assert.ok(c.makePath('sub').includes('sub'));
    });

    test('getPrefix starts with webdav://', () =>
    {
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('webdav://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('webdavs:// scheme produces webdavs:// prefix', () =>
    {
        const c = fmeld.getConnection('webdavs://myhost/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('webdavs://'));
    });

    test('connect creates client and isConnected becomes true', async () =>
    {
        // createClient() is non-blocking (no network) — connect resolves without a server
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        assert.equal(await c.connect(), true);
        assert.equal(c.isConnected(), true);
    });

    test('close after connect returns true and isConnected becomes false', async () =>
    {
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        await c.connect();
        assert.equal(await c.close(), true);
        assert.equal(c.isConnected(), false);
    });

    test('close without prior connect resolves true', async () =>
    {
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        assert.equal(await c.close(), true);
    });

    test('port is reflected in prefix', () =>
    {
        const c = fmeld.getConnection('webdav://myhost:8080/path', null, {verbose: false});
        assert.ok(c.getPrefix().includes('8080'));
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('webdav://myhost/path', null, {verbose: false});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });
});

// ---------------------------------------------------------------------------
// azblobClient — offline interface tests
// ---------------------------------------------------------------------------

describe('azblobClient', { skip: !HAS_AZBLOB ? '@azure/storage-blob package not installed' : false }, () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.azblobClient, 'function');
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('makePath returns string', () =>
    {
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        assert.equal(typeof c.makePath('sub'), 'string');
        assert.ok(c.makePath('sub').includes('sub'));
    });

    test('getPrefix starts with azure://', () =>
    {
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('azure://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('azblob:// and abs:// also route to azblobClient with azure:// prefix', () =>
    {
        for (const scheme of ['azblob', 'abs'])
        {
            const c = fmeld.getConnection(`${scheme}://mycontainer/path`, null, {verbose: false});
            assert.ok(c instanceof fmeld.azblobClient);
            assert.ok(c.getPrefix().startsWith('azure://'));
        }
    });

    test('mkDir resolves true (no-op — no real directories in blob storage)', async () =>
    {
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        assert.equal(await c.mkDir('/any/path', {recursive: true}), true);
    });

    test('connect rejects without credentials (no env var set)', async () =>
    {
        // Temporarily hide the env var if present
        const saved = process.env.AZURE_STORAGE_CONNECTION_STRING;
        delete process.env.AZURE_STORAGE_CONNECTION_STRING;
        try
        {
            const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
            await assert.rejects(async () => c.connect());
        }
        finally
        {
            if (saved !== undefined)
                process.env.AZURE_STORAGE_CONNECTION_STRING = saved;
        }
    });

    test('close without prior connect resolves true', async () =>
    {
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        assert.equal(await c.close(), true);
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('azure://mycontainer/path', null, {verbose: false});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });
});

// ---------------------------------------------------------------------------
// smbClient — offline interface tests
// ---------------------------------------------------------------------------

describe('smbClient', { skip: !HAS_SMB2 ? '@marsaud/smb2 package not installed' : false }, () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.smbClient, 'function');
    });

    test('throws when no share name in URL', () =>
    {
        assert.throws(
            () => fmeld.getConnection('smb://server/', null, {}),
            /Share name not provided/
        );
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        assert.equal(c.isConnected(), false);
    });

    test('makePath returns string containing sub-path', () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share/sub', null, {verbose: false});
        assert.equal(typeof c.makePath('child'), 'string');
        assert.ok(c.makePath('child').includes('child'));
    });

    test('root makePath does not duplicate share name', () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        assert.equal(c.makePath(), '/');
        assert.equal(c.getPrefix(c.makePath()), 'smb://server/share/');
    });

    test('getPrefix starts with smb://', () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        assert.ok(c.getPrefix().startsWith('smb://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('cifs:// scheme routes to smbClient with smb:// prefix', () =>
    {
        const c = fmeld.getConnection('cifs://user:pass@server/share', null, {verbose: false});
        assert.ok(c instanceof fmeld.smbClient);
        assert.ok(c.getPrefix().startsWith('smb://'));
    });

    test('connect creates client and isConnected becomes true', async () =>
    {
        // SMB2 uses lazy connections — new SMB2({...}) is non-blocking
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        assert.equal(await c.connect(), true);
        assert.equal(c.isConnected(), true);
    });

    test('close after connect returns true and isConnected becomes false', async () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        await c.connect();
        assert.equal(await c.close(), true);
        assert.equal(c.isConnected(), false);
    });

    test('close without prior connect resolves true', async () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        assert.equal(await c.close(), true);
    });

    test('port is reflected in prefix', () =>
    {
        const c = fmeld.getConnection('smb://user:pass@server:4450/share', null, {verbose: false});
        assert.ok(c.getPrefix().includes('4450'));
    });

    test('domain;user syntax is accepted without throwing', () =>
    {
        assert.doesNotThrow(() =>
            fmeld.getConnection('smb://CORP;alice:s3cr3t@fileserver/shared', null, {verbose: false})
        );
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('smb://user:pass@server/share', null, {verbose: false});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });
});

describe('smbClient mocked behavior', () =>
{
    function withMockedSmb2(FakeSMB2, fn)
    {
        const originalRequireBackend = setup.requireBackend;
        setup.requireBackend = () => FakeSMB2;
        return Promise.resolve()
            .then(fn)
            .finally(() =>
            {
                setup.requireBackend = originalRequireBackend;
            });
    }

    test('ls filters dot directory entries', async () =>
    {
        class FakeSMB2
        {
            constructor() {}
            disconnect(cb) { cb(null); }
            readdir(dir, options, cb)
            {
                assert.equal(dir, 'uploads\\run\\smb');
                assert.deepEqual(options, {stats: true});
                cb(null,
                    [
                        {
                            name: '.',
                            isDirectory: () => true,
                            size: 0,
                            mtime: new Date(0),
                            atime: new Date(0),
                            ctime: new Date(0)
                        },
                        {
                            name: '..',
                            isDirectory: () => true,
                            size: 0,
                            mtime: new Date(0),
                            atime: new Date(0),
                            ctime: new Date(0)
                        },
                        {
                            name: 'nested',
                            isDirectory: () => true,
                            size: 0,
                            mtime: new Date(0),
                            atime: new Date(0),
                            ctime: new Date(0)
                        }
                    ]);
            }
        }

        await withMockedSmb2(FakeSMB2, async () =>
        {
            const client = fmeld.getConnection('smb://user:pass@server/share/uploads/run/smb', null, {verbose: false});
            await client.connect();
            const entries = await client.ls(client.makePath());
            assert.deepEqual(entries.map(v => v.name), ['nested']);
            await client.close();
        });
    });

    test('ls uses stats-aware readdir entries directly', async () =>
    {
        class FakeSMB2
        {
            constructor() {}
            disconnect(cb) { cb(null); }
            readdir(dir, options, cb)
            {
                assert.equal(dir, 'uploads\\run\\smb');
                assert.deepEqual(options, {stats: true});
                cb(null,
                    [
                        {
                            name: 'nested',
                            isDirectory: () => true,
                            size: 0,
                            mtime: new Date(0),
                            atime: new Date(0),
                            ctime: new Date(0)
                        },
                        {
                            name: 'gone.txt',
                            isDirectory: () => false,
                            size: 0,
                            mtime: new Date(0),
                            atime: new Date(0),
                            ctime: new Date(0)
                        }
                    ]);
            }
        }

        await withMockedSmb2(FakeSMB2, async () =>
        {
            const client = fmeld.getConnection('smb://user:pass@server/share/uploads/run/smb', null, {verbose: false});
            await client.connect();
            const entries = await client.ls(client.makePath());
            assert.deepEqual(entries.map(v => v.name), ['nested', 'gone.txt']);
            await client.close();
        });
    });

    test('rmDir retries STATUS_DIRECTORY_NOT_EMPTY after child deletes', async () =>
    {
        const state = {
            dirs: new Set(['', 'uploads', 'uploads/run', 'uploads/run/smb', 'uploads/run/smb/nested']),
            files: new Set(['uploads/run/smb/nested/echo.txt']),
            failRootOnce: true
        };

        function normalize(target)
        {
            return String(target || '').replace(/\\/g, '/').replace(/^\/+/, '');
        }

        function childNames(dir)
        {
            const prefix = dir ? `${dir}/` : '';
            const out = new Set();

            for (const entry of [...state.dirs, ...state.files])
            {
                if (!entry.startsWith(prefix) || entry === dir)
                    continue;

                const rest = entry.slice(prefix.length);
                const name = rest.split('/')[0];
                if (name)
                    out.add(name);
            }

            return [...out];
        }

        class FakeSMB2
        {
            constructor() {}
            disconnect(cb) { cb(null); }
            readdir(dir, options, cb)
            {
                assert.deepEqual(options, {stats: true});
                const out = childNames(normalize(dir)).map(name =>
                {
                    const norm = normalize(dir) ? `${normalize(dir)}/${name}` : name;
                    const isDir = state.dirs.has(norm);
                    return {
                        name,
                        isDirectory: () => isDir,
                        size: isDir ? 0 : 18,
                        mtime: new Date(0),
                        atime: new Date(0),
                        ctime: new Date(0)
                    };
                });
                cb(null, out);
            }
            unlink(target, cb)
            {
                state.files.delete(normalize(target));
                cb(null);
            }
            rmdir(target, cb)
            {
                const norm = normalize(target);
                if (!state.dirs.has(norm))
                    return cb({code: 'STATUS_OBJECT_NAME_NOT_FOUND'});

                const hasChildren = childNames(norm).length > 0;
                if (hasChildren)
                    return cb({code: 'STATUS_DIRECTORY_NOT_EMPTY'});

                if (norm === 'uploads/run/smb' && state.failRootOnce)
                {
                    state.failRootOnce = false;
                    return cb({code: 'STATUS_DIRECTORY_NOT_EMPTY'});
                }

                state.dirs.delete(norm);
                cb(null);
            }
        }

        await withMockedSmb2(FakeSMB2, async () =>
        {
            const client = fmeld.getConnection('smb://user:pass@server/share/uploads/run/smb', null, {verbose: false});
            await client.connect();
            await client.rmDir(client.makePath(), {recursive: true, rmDirRetries: 1, rmDirRetryDelayMs: 0});
            assert.equal(state.dirs.has('uploads/run/smb'), false);
            assert.equal(state.dirs.has('uploads/run/smb/nested'), false);
            assert.equal(state.files.size, 0);
            await client.close();
        });
    });

    test('rmDir retries STATUS_DELETE_PENDING while directory removal settles', async () =>
    {
        const state = {
            dirs: new Set(['', 'uploads', 'uploads/run', 'uploads/run/smb', 'uploads/run/smb/nested']),
            files: new Set(['uploads/run/smb/nested/echo.txt']),
            failNestedStatDeletePendingOnce: true
        };

        function normalize(target)
        {
            return String(target || '').replace(/\\/g, '/').replace(/^\/+/, '');
        }

        function childNames(dir)
        {
            const prefix = dir ? `${dir}/` : '';
            const out = new Set();

            for (const entry of [...state.dirs, ...state.files])
            {
                if (!entry.startsWith(prefix) || entry === dir)
                    continue;

                const rest = entry.slice(prefix.length);
                const name = rest.split('/')[0];
                if (name)
                    out.add(name);
            }

            return [...out];
        }

        class FakeSMB2
        {
            constructor() {}
            disconnect(cb) { cb(null); }
            readdir(dir, options, cb)
            {
                assert.deepEqual(options, {stats: true});
                const normDir = normalize(dir);
                if (normDir === 'uploads/run/smb' && state.failNestedStatDeletePendingOnce)
                {
                    state.failNestedStatDeletePendingOnce = false;
                    return cb({code: 'STATUS_DELETE_PENDING'});
                }

                const out = childNames(normDir).map(name =>
                {
                    const norm = normDir ? `${normDir}/${name}` : name;
                    const isDir = state.dirs.has(norm);
                    return {
                        name,
                        isDirectory: () => isDir,
                        size: isDir ? 0 : 18,
                        mtime: new Date(0),
                        atime: new Date(0),
                        ctime: new Date(0)
                    };
                });
                cb(null, out);
            }
            unlink(target, cb)
            {
                state.files.delete(normalize(target));
                cb(null);
            }
            rmdir(target, cb)
            {
                const norm = normalize(target);
                if (!state.dirs.has(norm))
                    return cb({code: 'STATUS_OBJECT_NAME_NOT_FOUND'});

                const hasChildren = childNames(norm).length > 0;
                if (hasChildren)
                    return cb({code: 'STATUS_DIRECTORY_NOT_EMPTY'});

                state.dirs.delete(norm);
                cb(null);
            }
        }

        await withMockedSmb2(FakeSMB2, async () =>
        {
            const client = fmeld.getConnection('smb://user:pass@server/share/uploads/run/smb', null, {verbose: false});
            await client.connect();
            await client.rmDir(client.makePath(), {recursive: true, rmDirRetries: 1, rmDirRetryDelayMs: 0});
            assert.equal(state.dirs.has('uploads/run/smb'), false);
            assert.equal(state.dirs.has('uploads/run/smb/nested'), false);
            assert.equal(state.files.size, 0);
            await client.close();
        });
    });
});

// ---------------------------------------------------------------------------
// boxClient — offline interface tests
// ---------------------------------------------------------------------------

describe('boxClient', { skip: !HAS_BOX ? 'box-node-sdk package not installed' : false }, () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.boxClient, 'function');
    });

    test('throws when no credential file is provided', () =>
    {
        assert.throws(
            () => fmeld.getConnection('box:///my-folder', null, {}),
            /Credentials not provided/
        );
    });

    test('throws when credential file is missing', () =>
    {
        assert.throws(
            () => new fmeld.boxClient(
                { path: '/my-folder', cred: '/nonexistent/box-creds.json' },
                { verbose: false }
            ),
            /Credentials not provided/
        );
    });

    test('throws when credential file is invalid JSON', () =>
    {
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-bad-${Date.now()}.json`);
        fs.writeFileSync(credFile, 'not json');
        try
        {
            assert.throws(
                () => new fmeld.boxClient({ path: '/', cred: credFile }, { verbose: false }),
                /Invalid credentials file/
            );
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('constructs without throwing when given a valid stub credential', () =>
    {
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-cred-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ token: 'dev-token-stub' }));
        try
        {
            assert.doesNotThrow(() =>
                new fmeld.boxClient({ path: '/', cred: credFile }, { verbose: false })
            );
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('isConnected false before connect', () =>
    {
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-cred2-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ token: 'dev-token-stub' }));
        try
        {
            const c = new fmeld.boxClient({ path: '/', cred: credFile }, { verbose: false });
            assert.equal(c.isConnected(), false);
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('getPrefix starts with box://', () =>
    {
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-cred3-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ token: 'dev-token-stub' }));
        try
        {
            const c = new fmeld.boxClient({ path: '/docs', cred: credFile }, { verbose: false });
            assert.ok(c.getPrefix().startsWith('box://'));
            assert.ok(c.getPrefix('/some/path').includes('some/path'));
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('makePath returns string containing sub-path', () =>
    {
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-cred4-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ token: 'dev-token-stub' }));
        try
        {
            const c = new fmeld.boxClient({ path: '/docs', cred: credFile }, { verbose: false });
            assert.equal(typeof c.makePath('sub'), 'string');
            assert.ok(c.makePath('sub').includes('sub'));
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const tmp      = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-box-cred5-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ token: 'dev-token-stub' }));
        try
        {
            const c = new fmeld.boxClient({ path: '/', cred: credFile }, { verbose: false });
            for (const m of METHODS)
                assert.equal(typeof c[m], 'function', `missing: ${m}`);
        }
        finally { fs.unlinkSync(credFile); }
    });
});

// ---------------------------------------------------------------------------
// onedriveClient — construction and credential-guard tests
// ---------------------------------------------------------------------------

describe('onedriveClient', { skip: !HAS_MSAL ? '@azure/msal-node package not installed' : false }, () =>
{
    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.onedriveClient, 'function');
    });

    test('getConnection throws without a credentials file', () =>
    {
        assert.throws(
            () => fmeld.getConnection('onedrive://Documents/backups', null, {}),
            /Credentials not provided/
        );
    });

    test('constructor throws when credential file is missing', () =>
    {
        assert.throws(
            () => new fmeld.onedriveClient(
                { path: '/Documents', cred: '/nonexistent/creds.json' },
                { verbose: false }
            ),
            /Credentials not provided/
        );
    });

    test('constructor throws when credential file lacks client_id', () =>
    {
        const tmp = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-od-cred-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify({ client_secret: 'secret' }));
        try
        {
            assert.throws(
                () => new fmeld.onedriveClient(
                    { path: '/Documents', cred: credFile },
                    { verbose: false }
                ),
                /client_id missing/
            );
        }
        finally { fs.unlinkSync(credFile); }
    });

    test('exposes standard interface when constructed with valid credential stub', () =>
    {
        const tmp  = require('os').tmpdir();
        const credFile = path.join(tmp, `fmeld-od-cred2-${Date.now()}.json`);
        fs.writeFileSync(credFile, JSON.stringify(
        {   client_id    : 'test-client-id',
            client_secret: 'test-secret',
            tenant_id    : 'common'
        }));

        try
        {
            const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                             'createReadStream', 'createWriteStream', 'makePath',
                             'getPrefix', 'isConnected'];
            const c = new fmeld.onedriveClient(
                { path: '/Documents', cred: credFile },
                { verbose: false, authport: 19227 }
            );
            for (const m of METHODS)
                assert.equal(typeof c[m], 'function', `missing: ${m}`);

            assert.equal(c.isConnected(), false);
            assert.ok(c.getPrefix().startsWith('onedrive://'));
            assert.ok(c.makePath('sub').includes('sub'));
        }
        finally { fs.unlinkSync(credFile); }
    });
});

// ---------------------------------------------------------------------------
// adbClient — mocked offline tests
// ---------------------------------------------------------------------------

describe('adbClient mocked behavior', () =>
{
    function withMockedAdb(fakeAdbkit, fn)
    {
        const originalRequireBackend = setup.requireBackend;
        setup.requireBackend = () => fakeAdbkit;
        return Promise.resolve()
            .then(fn)
            .finally(() =>
            {
                setup.requireBackend = originalRequireBackend;
            });
    }

    // Minimal adbkit stub that reports one online USB device
    function makeAdbkit(serial = 'TESTSERIAL01', extraSetup = {})
    {
        const deviceObj = Object.assign(
        {
            shell:   (cmd) => Promise.resolve(
                Object.assign({ on(ev, cb) { if (ev === 'end') cb(); return this; } },
                              extraSetup.shell ? extraSetup.shell(cmd) : {})
            ),
            readdir: (dir) => Promise.resolve([]),
            pull:    (f)   => Promise.resolve({ on(e,cb){ return this; } }),
            push:    (s,f,m) =>
            {
                const t = { on(e,cb){ if(e==='end') setTimeout(cb,0); return this; } };
                return Promise.resolve(t);
            },
        },
        extraSetup.sync || {}
        );

        return {
            createClient: () =>
            ({
                listDevices: () => Promise.resolve([{ id: serial, type: 'device' }]),
                connect:     () => Promise.resolve(serial),
                getDevice:   (s) => deviceObj,
            })
        };
    }

    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.adbClient, 'function');
    });

    test('isConnected false before connect', () =>
    {
        return withMockedAdb(makeAdbkit(), () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            assert.equal(c.isConnected(), false);
        });
    });

    test('getPrefix contains serial after connect', async () =>
    {
        return withMockedAdb(makeAdbkit('ABC123'), async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            await c.connect();
            assert.ok(c.getPrefix().includes('ABC123'));
            await c.close();
        });
    });

    test('TCP/IP URL encodes host:port in prefix', () =>
    {
        return withMockedAdb(makeAdbkit('192.168.1.5:5555'), () =>
        {
            const c = fmeld.getConnection('adb://192.168.1.5:5555/sdcard/', null, {verbose: false});
            // prefix is set from URL args before connect
            assert.ok(c.getPrefix().includes('192.168.1.5'));
        });
    });

    test('makePath appends sub-path', () =>
    {
        return withMockedAdb(makeAdbkit(), () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            assert.ok(c.makePath('DCIM').includes('DCIM'));
        });
    });

    test('connect resolves true and isConnected becomes true', async () =>
    {
        return withMockedAdb(makeAdbkit('DEV001'), async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            assert.equal(await c.connect(), true);
            assert.equal(c.isConnected(), true);
            await c.close();
        });
    });

    test('close resolves true and isConnected becomes false', async () =>
    {
        return withMockedAdb(makeAdbkit(), async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            await c.connect();
            assert.equal(await c.close(), true);
            assert.equal(c.isConnected(), false);
        });
    });

    test('close without connect resolves true', async () =>
    {
        return withMockedAdb(makeAdbkit(), async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            assert.equal(await c.close(), true);
        });
    });

    test('connect rejects when no devices found', async () =>
    {
        const emptyAdbkit = {
            createClient: () => ({ listDevices: () => Promise.resolve([]) })
        };
        return withMockedAdb(emptyAdbkit, async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            await assert.rejects(() => c.connect(), /No ADB devices found/);
        });
    });

    test('connect rejects when named serial not found', async () =>
    {
        return withMockedAdb(makeAdbkit('DIFFERENT'), async () =>
        {
            const c = fmeld.getConnection('adb://MYSERIAL/sdcard/', null, {verbose: false});
            await assert.rejects(() => c.connect(), /ADB device not found/);
        });
    });

    test('ls returns mapped file list', async () =>
    {
        const entries = [
            { name: 'Camera', mode: 0x4000 | 0o755, size: 0,    mtime: 1000 },
            { name: 'photo.jpg', mode: 0o644,        size: 2048, mtime: 2000 },
        ];
        const kit = makeAdbkit('DEV', { sync: { readdir: () => Promise.resolve(entries) } });
        return withMockedAdb(kit, async () =>
        {
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            await c.connect();
            const list = await c.ls('/sdcard');
            assert.equal(list.length, 2);
            assert.equal(list[0].name, 'Camera');
            assert.equal(list[0].isDir, true);
            assert.equal(list[1].name, 'photo.jpg');
            assert.equal(list[1].isFile, true);
            assert.equal(list[1].size, 2048);
            await c.close();
        });
    });

    test('exposes standard interface', () =>
    {
        return withMockedAdb(makeAdbkit(), () =>
        {
            const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                             'createReadStream', 'createWriteStream', 'makePath',
                             'getPrefix', 'isConnected'];
            const c = fmeld.getConnection('adb:///sdcard/', null, {verbose: false});
            for (const m of METHODS)
                assert.equal(typeof c[m], 'function', `missing: ${m}`);
        });
    });
});

// ---------------------------------------------------------------------------
// zipClient
// ---------------------------------------------------------------------------

describe('zipClient', { skip: !HAS_ZIP ? 'unzipper or archiver package not installed' : false }, () =>
{
    /** Build a small ZIP at destPath containing the given entries. */
    async function makeZip(destPath, entries)
    {
        const archiver = require('archiver');
        const output   = fs.createWriteStream(destPath);
        const archive  = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(output);
        for (const { name, content } of entries)
            archive.append(content, { name });
        await new Promise((res, rej) => { output.on('close', res); archive.on('error', rej); archive.finalize(); });
    }

    test('exported as constructor', () =>
    {
        assert.equal(typeof fmeld.zipClient, 'function');
    });

    test('zip:// routes to zipClient', () =>
    {
        const c = fmeld.getConnection('zip:///tmp/test.zip', null, {});
        assert.ok(c instanceof fmeld.zipClient);
    });

    test('exposes standard interface', () =>
    {
        const METHODS = ['connect', 'close', 'ls', 'mkDir', 'rmFile', 'rmDir',
                         'createReadStream', 'createWriteStream', 'makePath',
                         'getPrefix', 'isConnected'];
        const c = fmeld.getConnection('zip:///tmp/test.zip', null, {});
        for (const m of METHODS)
            assert.equal(typeof c[m], 'function', `missing: ${m}`);
    });

    test('isConnected false before connect', () =>
    {
        const c = fmeld.getConnection('zip:///tmp/test.zip', null, {});
        assert.equal(c.isConnected(), false);
    });

    test('getPrefix starts with zip://', () =>
    {
        const c = fmeld.getConnection('zip:///tmp/test.zip', null, {});
        assert.ok(c.getPrefix().startsWith('zip://'));
        assert.ok(c.getPrefix('/some/path').includes('some/path'));
    });

    test('makePath appends segment', () =>
    {
        const c = fmeld.getConnection('zip:///tmp/test.zip', null, {});
        assert.ok(c.makePath('subdir').includes('subdir'));
    });

    test('connect resolves true and isConnected becomes true', async () =>
    {
        const c = fmeld.getConnection('zip:///tmp/fmeld-test-conn.zip', null, {});
        assert.equal(await c.connect(), true);
        assert.equal(c.isConnected(), true);
        await c.close();
    });

    test('close without writes resolves true without creating an archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-nowrites-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        await c.connect();
        assert.equal(await c.close(), true);
        assert.equal(c.isConnected(), false);
        assert.equal(fs.existsSync(archivePath), false);
    });

    test('ls on non-existent archive returns empty array', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-empty-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        await c.connect();
        const list = await c.ls(archivePath);
        assert.deepEqual(list, []);
        await c.close();
    });

    test('ls root of existing archive returns correct entries', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-ls-${Date.now()}.zip`);
        await makeZip(archivePath, [
            { name: 'file.txt',      content: 'hello' },
            { name: 'sub/deep.txt',  content: 'deep'  },
        ]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const list = await c.ls(archivePath);
            assert.equal(list.length, 2);
            const names = list.map(e => e.name).sort();
            assert.deepEqual(names, ['file.txt', 'sub']);
            const sub = list.find(e => e.name === 'sub');
            assert.equal(sub.isDir,  true);
            assert.equal(sub.isFile, false);
            const file = list.find(e => e.name === 'file.txt');
            assert.equal(file.isFile, true);
            assert.equal(file.size,   5);
        }
        finally
        {
            await c.close();
            fs.unlinkSync(archivePath);
        }
    });

    test('ls subdirectory returns children', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-lssub-${Date.now()}.zip`);
        await makeZip(archivePath, [
            { name: 'sub/a.txt', content: 'aaa' },
            { name: 'sub/b.txt', content: 'bbb' },
        ]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const list = await c.ls(archivePath + '/sub');
            assert.equal(list.length, 2);
            assert.ok(list.every(e => e.isFile));
        }
        finally
        {
            await c.close();
            fs.unlinkSync(archivePath);
        }
    });

    test('createReadStream reads a file from the archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-read-${Date.now()}.zip`);
        await makeZip(archivePath, [{ name: 'hello.txt', content: 'hello world' }]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const rs      = await c.createReadStream(archivePath + '/hello.txt');
            const content = await readStream(rs);
            assert.equal(content, 'hello world');
        }
        finally
        {
            await c.close();
            fs.unlinkSync(archivePath);
        }
    });

    test('createWriteStream then close creates a valid archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-write-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/new.txt');
            await writeStream(ws, 'new content');
            await c.close();

            assert.ok(fs.existsSync(archivePath));
            const unzipper = require('unzipper');
            const dir      = await unzipper.Open.file(archivePath);
            const files    = dir.files.filter(f => f.type === 'File');
            assert.equal(files.length, 1);
            assert.equal(files[0].path, 'new.txt');
            const buf = await files[0].buffer();
            assert.equal(buf.toString(), 'new content');
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('createWriteStream adds a file to an existing archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-add-${Date.now()}.zip`);
        await makeZip(archivePath, [{ name: 'existing.txt', content: 'existing' }]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/added.txt');
            await writeStream(ws, 'added');
            await c.close();

            const unzipper = require('unzipper');
            const dir      = await unzipper.Open.file(archivePath);
            const files    = dir.files.filter(f => f.type === 'File').map(f => f.path).sort();
            assert.deepEqual(files, ['added.txt', 'existing.txt']);
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('rmFile removes a file from an existing archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-rm-${Date.now()}.zip`);
        await makeZip(archivePath, [
            { name: 'keep.txt',   content: 'keep'   },
            { name: 'delete.txt', content: 'delete' },
        ]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            await c.rmFile(archivePath + '/delete.txt');
            await c.close();

            const unzipper = require('unzipper');
            const dir      = await unzipper.Open.file(archivePath);
            const files    = dir.files.filter(f => f.type === 'File').map(f => f.path);
            assert.deepEqual(files, ['keep.txt']);
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('rmDir removes a subdirectory and its contents', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-rmdir-${Date.now()}.zip`);
        await makeZip(archivePath, [
            { name: 'keep.txt',     content: 'keep'  },
            { name: 'sub/a.txt',    content: 'a'     },
            { name: 'sub/b.txt',    content: 'b'     },
        ]);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            await c.rmDir(archivePath + '/sub', { recursive: true });
            await c.close();

            const unzipper = require('unzipper');
            const dir      = await unzipper.Open.file(archivePath);
            const files    = dir.files.filter(f => f.type === 'File').map(f => f.path);
            assert.deepEqual(files, ['keep.txt']);
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('copyDir file→zip produces a readable archive', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-cpdir-${Date.now()}.zip`);
        const srcDir      = path.join(os.tmpdir(), `fmeld-zip-src-${Date.now()}`);
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'alpha.txt'), 'alpha');
        fs.writeFileSync(path.join(srcDir, 'beta.txt'),  'beta');

        const src = fmeld.getConnection(`file://${srcDir}`,  null, {});
        const dst = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await Promise.all([src.connect(), dst.connect()]);
            await fmeld.copyDir(src, dst, srcDir, archivePath, { recursive: true, batch: 1 });
            await Promise.all([src.close(), dst.close()]);

            const unzipper = require('unzipper');
            const dir      = await unzipper.Open.file(archivePath);
            const files    = dir.files.filter(f => f.type === 'File').map(f => f.path).sort();
            assert.deepEqual(files, ['alpha.txt', 'beta.txt']);
        }
        finally
        {
            fs.rmSync(srcDir, { recursive: true, force: true });
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('orphan staging dirs older than 24h are removed on connect', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-orphan-${Date.now()}.zip`);
        const orphanDir   = archivePath + '.staging.deadbeef';
        fs.mkdirSync(path.join(orphanDir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(orphanDir, 'meta.json'), '{}');
        // Backdate the orphan beyond the 24h threshold
        const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
        fs.utimesSync(orphanDir, old, old);

        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        await c.connect();
        assert.equal(fs.existsSync(orphanDir), false, 'orphan dir should have been removed');
        await c.close();
    });

    test('no staging files left after a successful write + close', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-clean-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/f.txt');
            await writeStream(ws, 'data');
            await c.close();

            // No staging dirs beside the archive
            const dir    = path.dirname(archivePath);
            const base   = path.basename(archivePath);
            const leftovers = fs.readdirSync(dir)
                .filter(e => e.startsWith(base + '.staging.') || e.startsWith(base + '.final.'));
            assert.deepEqual(leftovers, []);
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('close() after writes logs success message with archive path', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-log-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        const logged = [];
        const origLog = console.log;
        console.log = (...args) => { logged.push(args.join(' ')); };
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/f.txt');
            await writeStream(ws, 'data');
            await c.close();
            assert.ok(
                logged.some(msg => msg.includes(archivePath)),
                'success message should include archive path'
            );
        }
        finally
        {
            console.log = origLog;
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('close() after writes emits compressing status to stderr', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-progress-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        const stderrLines = [];
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = (data, ...rest) => { stderrLines.push(String(data)); return origWrite(data, ...rest); };
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/f.txt');
            await writeStream(ws, 'progress test data');
            await c.close();
            assert.ok(
                stderrLines.some(s => s.includes('compressing')),
                'stderr should contain compressing status'
            );
        }
        finally
        {
            process.stderr.write = origWrite;
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('abort() after writes discards staging and leaves original untouched', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-abort-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        try
        {
            await c.connect();
            const ws = await c.createWriteStream(archivePath + '/f.txt');
            await writeStream(ws, 'data that should be discarded');
            assert.equal(typeof c.abort, 'function', 'abort should be exposed on zip client');
            await c.abort();
            assert.equal(c.isConnected(), false);
            // Original archive must not have been created
            assert.equal(fs.existsSync(archivePath), false, 'archive must not exist after abort');
            // Subsequent close() should be a no-op (already disconnected)
            await c.close();
            assert.equal(fs.existsSync(archivePath), false, 'archive must still not exist after close');
        }
        finally
        {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
        }
    });

    test('abort() on a connected client with no writes is a no-op', async () =>
    {
        const archivePath = path.join(os.tmpdir(), `fmeld-zip-abort-nowrites-${Date.now()}.zip`);
        const c = fmeld.getConnection(`zip://${archivePath}`, null, {});
        await c.connect();
        await c.abort();
        assert.equal(c.isConnected(), false);
        assert.equal(fs.existsSync(archivePath), false);
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

    test('getConnection file url does not emit warning without creds', () =>
    {
        const warnings = [];
        const onWarning = (warning) => warnings.push(warning);
        process.on('warning', onWarning);

        try
        {
            const client = fmeld.getConnection('file:///tmp', null, {verbose: false});
            assert.ok(client);
            assert.equal(warnings.some(w => String(w.code) === 'DEP0187'), false);
        }
        finally
        {
            process.off('warning', onWarning);
        }
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
// setup module
// ---------------------------------------------------------------------------

describe('fmeld.setup', () =>
{
    const setup = fmeld.setup;

    test('BACKENDS is a non-empty array', () =>
    {
        assert.ok(Array.isArray(setup.BACKENDS));
        assert.ok(setup.BACKENDS.length > 0);
    });

    test('every backend entry has required fields', () =>
    {
        for (const b of setup.BACKENDS)
        {
            assert.equal(typeof b.key,         'string',  `${b.key}: key`);
            assert.equal(typeof b.label,       'string',  `${b.key}: label`);
            assert.ok(Array.isArray(b.pkgs),              `${b.key}: pkgs`);
            assert.ok(b.pkgs.length > 0,                  `${b.key}: pkgs non-empty`);
            assert.equal(typeof b.size,        'string',  `${b.key}: size`);
            assert.ok(Array.isArray(b.schemes),           `${b.key}: schemes`);
            assert.ok(b.schemes.length > 0,               `${b.key}: schemes non-empty`);
        }
    });

    test('pkgAvailable returns true for an installed npm package', () =>
    {
        // 'sparen' is a hard dependency, always present in fmeld's own node_modules
        assert.equal(setupPkgAvailable('sparen'), true);
    });

    test('pkgAvailable returns false for a non-existent package', () =>
    {
        assert.equal(setupPkgAvailable('__fmeld_nonexistent_pkg__'), false);
    });

    test('requireBackend returns the module when the package is installed', () =>
    {
        // 'sparen' is a hard dependency, always present in fmeld's own node_modules
        const result = setup.requireBackend('sparen', 'test://');
        assert.ok(result);
        assert.equal(typeof result, 'object');
    });

    test('requireBackend throws BACKEND_NOT_INSTALLED for a missing package', () =>
    {
        try
        {
            setup.requireBackend('__fmeld_nonexistent_pkg__', 'test://');
            assert.fail('should have thrown');
        }
        catch(e)
        {
            assert.equal(e.code, 'BACKEND_NOT_INSTALLED');
            assert.equal(typeof e.pkg,     'string');
            assert.equal(typeof e.hint,    'string');
            assert.ok(Array.isArray(e.allPkgs));
        }
    });

    test('getBackendByPkg finds a backend by its primary package', () =>
    {
        // ssh2 is always in the registry regardless of whether it's installed
        const b = setup.getBackendByPkg('ssh2');
        assert.ok(b);
        assert.equal(b.key, 'sftp');
    });

    test('getBackendByPkg returns null for an unknown package', () =>
    {
        assert.equal(setup.getBackendByPkg('__unknown_pkg__'), null);
    });

    test('every BACKENDS entry is findable by each of its packages', () =>
    {
        for (const b of setup.BACKENDS)
            for (const pkg of b.pkgs)
            {
                const found = setup.getBackendByPkg(pkg);
                assert.ok(found, `${pkg} not findable`);
                assert.equal(found.key, b.key);
            }
    });

    test('pkgAvailable returns true for a core dependency that is always installed', () =>
    {
        // 'sparen' is in dependencies (not optional) so it is always present
        assert.equal(setup.pkgAvailable('sparen'), true);
    });

    test('pkgAvailable returns false for a package that is not installed', () =>
    {
        assert.equal(setup.pkgAvailable('__fmeld_nonexistent_pkg__'), false);
    });

    test('backend keys are unique across the registry', () =>
    {
        const keys = setup.BACKENDS.map(b => b.key);
        assert.equal(new Set(keys).size, keys.length, 'duplicate key in BACKENDS');
    });

    test('schemes are unique across the registry', () =>
    {
        const schemes = setup.BACKENDS.flatMap(b => b.schemes);
        assert.equal(new Set(schemes).size, schemes.length, 'duplicate scheme in BACKENDS');
    });

    test('installPackages is exported as a function', () =>
    {
        assert.equal(typeof setup.installPackages, 'function');
    });
});

// ---------------------------------------------------------------------------
// exports completeness
// ---------------------------------------------------------------------------

describe('fmeld exports', () =>
{
    const functions = [
        'getConnection', 'stdoutProgress', 'copyFile', 'copyDir',
        'cleanDir', 'syncDir', 'promiseWhile', 'promiseWhileBatch', 'toHuman', 'parseSize',
        'findDuplicates',
    ];
    const constructors = [
        'fakeClient', 'fileClient', 'ftpClient', 'sftpClient',
        'gcsClient', 'gdriveClient', 'dropboxClient', 's3Client',
        'webdavClient', 'azblobClient', 'onedriveClient', 'smbClient', 'boxClient',
        'adbClient',
    ];
    const configFns = [
        'promiseWhile', 'promiseDoWhile', 'promiseWhileBatch',
        'loadConfig', 'installPath', 'getConfig', 'processFile', 'parseParams',
    ];

    for (const name of functions)
        test(`fmeld.${name} is a function`, () => assert.equal(typeof fmeld[name], 'function'));

    for (const name of constructors)
        test(`fmeld.${name} is a constructor`, () => assert.equal(typeof fmeld[name], 'function'));

    test('fmeld.__info__ is present',   () => assert.ok(fmeld.__info__));
    test('fmeld.__config__ is present', () => assert.ok(fmeld.__config__));
    test('fmeld.setup is present',      () => assert.ok(fmeld.setup));
    test('fmeld.setup.BACKENDS is present', () => assert.ok(Array.isArray(fmeld.setup.BACKENDS)));
    test('fmeld.dupeSession is an object', () => assert.equal(typeof fmeld.dupeSession, 'object'));
    test('fmeld.dupeUI is an object',      () => assert.equal(typeof fmeld.dupeUI, 'object'));

    for (const name of configFns)
        test(`fmeld.__config__.${name} is a function`,
             () => assert.equal(typeof fmeld.__config__[name], 'function'));
});

// ---------------------------------------------------------------------------
// cleanDir — minsize / maxsize bug fix
// ---------------------------------------------------------------------------

describe('cleanDir size filters', () =>
{
    test('minsize filter applies to files (not opts.isFile)', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-clean-sz-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const small = path.join(tmp, 'small.txt');
        const large = path.join(tmp, 'large.txt');
        fs.writeFileSync(small, 'hi');          // 2 bytes
        fs.writeFileSync(large, 'hello world'); // 11 bytes
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            await fmeld.cleanDir(client, tmp,
                { batch: 1, 'clean-files': true, minsize: 5 });
            assert.ok(fs.existsSync(small),  'small file should survive minsize filter');
            assert.ok(!fs.existsSync(large), 'large file should be cleaned');
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });

    test('maxsize filter applies to files (not opts.isFile)', async () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-clean-sz2-${Date.now()}`);
        fs.mkdirSync(tmp, {recursive: true});
        const small = path.join(tmp, 'small.txt');
        const large = path.join(tmp, 'large.txt');
        fs.writeFileSync(small, 'hi');          // 2 bytes
        fs.writeFileSync(large, 'hello world'); // 11 bytes
        const client = fmeld.getConnection(`file://${tmp}`, null, {verbose: false});
        try
        {
            await fmeld.cleanDir(client, tmp,
                { batch: 1, 'clean-files': true, maxsize: 5 });
            assert.ok(!fs.existsSync(small), 'small file should be cleaned by maxsize');
            assert.ok(fs.existsSync(large),  'large file should survive maxsize filter');
        }
        finally { fs.rmSync(tmp, {recursive: true, force: true}); }
    });
});

// ---------------------------------------------------------------------------
// normalizeFileName
// ---------------------------------------------------------------------------

describe('normalizeFileName', () =>
{
    const { normalizeFileName } = require('../lib/dupes.js');

    test('lowercases ASCII names', () =>
    {
        assert.equal(normalizeFileName('PHOTO.JPG'), 'photo.jpg');
    });

    test('strips directory component', () =>
    {
        assert.equal(normalizeFileName('/some/path/File.TXT'), 'file.txt');
    });

    test('applies NFC normalization', () =>
    {
        // café: precomposed (NFC \u00e9) vs decomposed (NFD e + \u0301)
        const nfd = 'caf\u0065\u0301.txt';
        const nfc = 'caf\u00e9.txt';
        assert.equal(normalizeFileName(nfd), normalizeFileName(nfc));
    });

    test('empty string stays empty', () =>
    {
        assert.equal(normalizeFileName(''), '');
    });
});

// ---------------------------------------------------------------------------
// dupes — findDuplicates (filesystem integration)
// ---------------------------------------------------------------------------

describe('findDuplicates', () =>
{
    function makeTmpTree(files)
    {
        const root = path.join(os.tmpdir(), `fmeld-dupes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        for (const [rel, content] of Object.entries(files))
        {
            const full = path.join(root, rel);
            fs.mkdirSync(path.dirname(full), {recursive: true});
            fs.writeFileSync(full, content);
        }
        return root;
    }

    test('sha256 mode groups identical files', async () =>
    {
        const root = makeTmpTree({
            'a/dup.txt':    'same content',
            'b/dup2.txt':   'same content',
            'c/unique.txt': 'different',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: true, batch: 1 });
            assert.equal(sd.version, 1);
            assert.equal(sd.mode, 'sha256');
            assert.equal(sd.summary.groups, 1, 'expected one duplicate group');
            assert.equal(sd.entries[0].files.length, 2);
            assert.equal(sd.entries[0].detection.method, 'sha256');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('name mode groups by normalized filename', async () =>
    {
        const root = makeTmpTree({
            'a/Photo.JPG': 'aaa',
            'b/photo.jpg': 'bbb',  // same name (case-insensitive)
            'c/other.png': 'ccc',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'name', recursive: true, batch: 1 });
            assert.equal(sd.summary.groups, 1);
            assert.equal(sd.entries[0].files.length, 2);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('name,size mode requires both name and size to match', async () =>
    {
        const root = makeTmpTree({
            'a/file.txt': 'abc',   // same name, same size
            'b/file.txt': 'abc',
            'c/file.txt': 'abcd',  // same name, different size — not a dup
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'name,size', recursive: true, batch: 1 });
            assert.equal(sd.summary.groups, 1);
            assert.equal(sd.entries[0].files.length, 2);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('empty files are excluded by default', async () =>
    {
        const root = makeTmpTree({
            'a/empty.txt': '',
            'b/empty.txt': '',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: true, batch: 1 });
            assert.equal(sd.summary.groups, 0, 'empty files should be ignored by default');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('includeEmpty: true includes zero-byte files', async () =>
    {
        const root = makeTmpTree({
            'a/empty.txt': '',
            'b/empty.txt': '',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: true, batch: 1, includeEmpty: true });
            assert.equal(sd.summary.groups, 1);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('no duplicates produces empty entries', async () =>
    {
        const root = makeTmpTree({
            'a.txt': 'aaa',
            'b.txt': 'bbb',
            'c.txt': 'ccc',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: false, batch: 1 });
            assert.equal(sd.summary.groups, 0);
            assert.equal(sd.entries.length, 0);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('non-recursive scan does not descend into subdirectories', async () =>
    {
        const root = makeTmpTree({
            'top.txt':      'same',
            'sub/deep.txt': 'same',  // only reachable recursively
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: false, batch: 1 });
            assert.equal(sd.summary.groups, 0, 'only top-level file; no dups without recursion');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('minsize filter excludes files below threshold', async () =>
    {
        const root = makeTmpTree({
            'a/small.txt': 'hi',          // 2 bytes
            'b/small.txt': 'hi',          // 2 bytes — same content, but below minsize
            'c/large.bin': 'hello world', // 11 bytes
            'd/large.bin': 'hello world', // 11 bytes — above minsize, should group
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: true, batch: 1, minsize: 5 });
            assert.equal(sd.summary.groups, 1, 'small files filtered; only large group remains');
            assert.ok(sd.entries[0].files.every(f => f.size >= 5));
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('session data has correct structure', async () =>
    {
        const root = makeTmpTree({
            'x.txt': 'dup',
            'y.txt': 'dup',
        });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        try
        {
            const sd = await fmeld.findDuplicates(client, root,
                { by: 'sha256', recursive: false, batch: 1 });
            assert.equal(sd.version, 1);
            assert.ok(sd.source);
            assert.ok(sd.root);
            assert.ok(sd.generated_at);
            assert.ok(sd.scan);
            assert.ok(sd.session);
            assert.ok(sd.summary);
            assert.ok(Array.isArray(sd.entries));
            const e = sd.entries[0];
            assert.ok(e.group_id);
            assert.ok(e.detection);
            assert.equal(e.detection.method, 'sha256');
            assert.ok(e.detection.hash);
            assert.ok(Array.isArray(e.files));
            assert.ok(e.files[0].path);
            assert.equal(e.files[0].action, 'none');
            assert.equal(e.files[0].applied, false);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
});

// ---------------------------------------------------------------------------
// dupes — applyPreset
// ---------------------------------------------------------------------------

describe('applyPreset', () =>
{
    const Session = require('../lib/dupes-session.js');

    function makeSession(files)
    {
        return {
            version: 1, mode: 'sha256', entries: [{
                group_id: 'sha256:test',
                result: null,
                detection: { method: 'sha256', hash: 'deadbeef' },
                files: files.map((f, i) => ({
                    path: f.path, name: path.basename(f.path),
                    size: f.size || 0, mtime: f.mtime || i * 100,
                    action: 'none', applied: false
                }))
            }]
        };
    }

    test('first — marks first file keep, rest with remaining action', () =>
    {
        const sd = makeSession([{path: '/a/f.txt'}, {path: '/b/f.txt'}, {path: '/c/f.txt'}]);
        Session.applyPreset(sd, { keep: 'first', remaining: 'delete' });
        assert.equal(sd.entries[0].files[0].action, 'keep');
        assert.equal(sd.entries[0].files[1].action, 'delete');
        assert.equal(sd.entries[0].files[2].action, 'delete');
    });

    test('newest — keeps file with highest mtime', () =>
    {
        const sd = makeSession([
            {path: '/a/f.txt', mtime: 100},
            {path: '/b/f.txt', mtime: 300},
            {path: '/c/f.txt', mtime: 200},
        ]);
        Session.applyPreset(sd, { keep: 'newest', remaining: 'delete' });
        assert.equal(sd.entries[0].files[1].action, 'keep', 'highest mtime should be kept');
        assert.equal(sd.entries[0].files[0].action, 'delete');
        assert.equal(sd.entries[0].files[2].action, 'delete');
    });

    test('oldest — keeps file with lowest mtime', () =>
    {
        const sd = makeSession([
            {path: '/a/f.txt', mtime: 200},
            {path: '/b/f.txt', mtime: 100},
            {path: '/c/f.txt', mtime: 300},
        ]);
        Session.applyPreset(sd, { keep: 'oldest', remaining: 'delete' });
        assert.equal(sd.entries[0].files[1].action, 'keep', 'lowest mtime should be kept');
    });

    test('shortest-path — keeps file with shortest full path', () =>
    {
        const sd = makeSession([
            {path: '/a/very/long/path/f.txt'},
            {path: '/b/f.txt'},
            {path: '/c/medium/path/f.txt'},
        ]);
        Session.applyPreset(sd, { keep: 'shortest-path', remaining: 'delete' });
        assert.equal(sd.entries[0].files[1].action, 'keep');
    });

    test('longest-path — keeps file with longest full path', () =>
    {
        const sd = makeSession([
            {path: '/a/very/long/path/f.txt'},
            {path: '/b/f.txt'},
        ]);
        Session.applyPreset(sd, { keep: 'longest-path', remaining: 'delete' });
        assert.equal(sd.entries[0].files[0].action, 'keep');
    });

    test('regex — keeps first file matching pattern', () =>
    {
        const sd = makeSession([
            {path: '/tmp/scratch/f.txt'},
            {path: '/archive/2024/f.txt'},
            {path: '/tmp/other/f.txt'},
        ]);
        Session.applyPreset(sd, { keep: 'regex', keepPattern: '/archive/', remaining: 'delete' });
        assert.equal(sd.entries[0].files[1].action, 'keep');
        assert.equal(sd.entries[0].files[0].action, 'delete');
    });

    test('regex with no match — leaves all files as review and does not throw', () =>
    {
        const sd = makeSession([{path: '/a/f.txt'}, {path: '/b/f.txt'}]);
        // Swallow the stderr warning
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try
        {
            Session.applyPreset(sd, { keep: 'regex', keepPattern: '/nomatch/', remaining: 'delete' });
            assert.equal(sd.entries[0].files[0].action, 'review');
            assert.equal(sd.entries[0].files[1].action, 'review');
        }
        finally { process.stderr.write = origWrite; }
    });

    test('remaining defaults to review when not specified', () =>
    {
        const sd = makeSession([{path: '/a/f.txt'}, {path: '/b/f.txt'}]);
        Session.applyPreset(sd, { keep: 'first' });
        assert.equal(sd.entries[0].files[0].action, 'keep');
        assert.equal(sd.entries[0].files[1].action, 'review');
    });

    test('skips groups with existing explicit decisions by default', () =>
    {
        const sd = makeSession([{path: '/a/f.txt'}, {path: '/b/f.txt'}]);
        sd.entries[0].files[0].action = 'keep';     // already decided
        Session.applyPreset(sd, { keep: 'oldest', remaining: 'delete' });
        assert.equal(sd.entries[0].files[0].action, 'keep', 'explicit decision should be preserved');
    });

    test('forcePreset overwrites existing decisions', () =>
    {
        const sd = makeSession([
            {path: '/a/f.txt', mtime: 100},
            {path: '/b/f.txt', mtime: 200},
        ]);
        sd.entries[0].files[0].action = 'keep';
        Session.applyPreset(sd, { keep: 'newest', remaining: 'delete', forcePreset: true });
        assert.equal(sd.entries[0].files[1].action, 'keep', 'newest should win after force');
        assert.equal(sd.entries[0].files[0].action, 'delete');
    });

    test('tie-breaking falls back to first (group file order)', () =>
    {
        const sd = makeSession([
            {path: '/a/f.txt', mtime: 100},
            {path: '/b/f.txt', mtime: 100},  // same mtime — tie
        ]);
        Session.applyPreset(sd, { keep: 'newest', remaining: 'delete' });
        assert.equal(sd.entries[0].files[0].action, 'keep', 'first in group order wins tie');
        assert.equal(sd.entries[0].files[1].action, 'delete');
    });
});

// ---------------------------------------------------------------------------
// dupes — validateGroup
// ---------------------------------------------------------------------------

describe('validateGroup', () =>
{
    const { validateGroup } = require('../lib/dupes-session.js');

    function entry(actions)
    {
        return { group_id: 'x', files: actions.map(a => ({ action: a, applied: false })) };
    }

    test('keep + delete is valid', () =>
    {
        assert.equal(validateGroup(entry(['keep', 'delete'])).valid, true);
    });

    test('keep + link is valid', () =>
    {
        assert.equal(validateGroup(entry(['keep', 'link'])).valid, true);
    });

    test('any review blocks the group', () =>
    {
        const r = validateGroup(entry(['keep', 'review']));
        assert.equal(r.valid, false);
        assert.ok(r.reason.includes('review'));
    });

    test('link without keep blocks the group', () =>
    {
        const r = validateGroup(entry(['none', 'link']));
        assert.equal(r.valid, false);
        assert.ok(r.reason.includes('keep'));
    });

    test('all-none is invalid but flagged as skip (not a hard block)', () =>
    {
        const r = validateGroup(entry(['none', 'none']));
        assert.equal(r.valid, false);
        assert.ok(r.reason.includes('none'));
        assert.equal(r.skip, true);
    });

    test('review is invalid without skip flag (hard block)', () =>
    {
        const r = validateGroup(entry(['keep', 'review']));
        assert.equal(r.valid, false);
        assert.equal(r.skip, undefined);
    });

    test('already-applied result: keep + delete still validates', () =>
    {
        assert.equal(validateGroup(entry(['keep', 'none', 'delete'])).valid, true);
    });
});

// ---------------------------------------------------------------------------
// dupes — carryForward
// ---------------------------------------------------------------------------

describe('carryForward', () =>
{
    const { carryForward } = require('../lib/dupes-session.js');

    function makeEntry(hash, files)
    {
        return {
            group_id: `sha256:${hash}`,
            detection: { method: 'sha256', hash },
            files: files.map(([p, a]) => ({ path: p, action: a, applied: false }))
        };
    }

    test('carries prior selections when path and fingerprint match', () =>
    {
        const old = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'keep'], ['/b.txt', 'delete']])] };
        const nd  = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'none'],  ['/b.txt', 'none']])] };
        carryForward(old, nd);
        assert.equal(nd.entries[0].files[0].action, 'keep');
        assert.equal(nd.entries[0].files[1].action, 'delete');
    });

    test('does not carry when mode changed', () =>
    {
        const old = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'keep']])] };
        const nd  = { mode: 'md5',    entries: [makeEntry('aabb', [['/a.txt', 'none']])] };
        carryForward(old, nd);
        assert.equal(nd.entries[0].files[0].action, 'none', 'mode change should prevent carry-forward');
    });

    test('does not carry when fingerprint changed', () =>
    {
        const old = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'keep']])] };
        const nd  = { mode: 'sha256', entries: [makeEntry('ccdd', [['/a.txt', 'none']])] };
        carryForward(old, nd);
        assert.equal(nd.entries[0].files[0].action, 'none', 'fingerprint mismatch; no carry');
    });

    test('does not carry when path changed', () =>
    {
        const old = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'keep']])] };
        const nd  = { mode: 'sha256', entries: [makeEntry('aabb', [['/renamed.txt', 'none']])] };
        carryForward(old, nd);
        assert.equal(nd.entries[0].files[0].action, 'none', 'path mismatch; no carry');
    });

    test('carries forward only files with non-none prior action', () =>
    {
        const old = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'none'], ['/b.txt', 'delete']])] };
        const nd  = { mode: 'sha256', entries: [makeEntry('aabb', [['/a.txt', 'none'], ['/b.txt', 'none']])] };
        carryForward(old, nd);
        assert.equal(nd.entries[0].files[0].action, 'none',   '/a.txt had none — not carried');
        assert.equal(nd.entries[0].files[1].action, 'delete', '/b.txt had delete — carried');
    });
});

// ---------------------------------------------------------------------------
// dupes — session save / load round-trip
// ---------------------------------------------------------------------------

describe('dupes session save/load', () =>
{
    const Session = require('../lib/dupes-session.js');

    test('saveSession / loadSession round-trips session data', () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-sess-${Date.now()}.yml`);
        const sd = {
            version: 1, source: 'file:///tmp', root: '/tmp', mode: 'sha256',
            generated_at: new Date().toISOString(),
            scan: { recursive: true, include_empty: false, before: null, after: null,
                    minsize: null, maxsize: null, fnametime: null,
                    filter_files: null, filter_dirs: null },
            session: { path: tmp, state: 'review', temporary: false,
                       last_saved_at: null, last_applied_at: null,
                       last_scanned_at: new Date().toISOString() },
            summary: { groups: 1, files: 2, grouped_bytes: 100, reclaimable_bytes: 0 },
            entries: [{
                group_id: 'sha256:abc123',
                status: 'review', result: null,
                detection: { method: 'sha256', hash: 'abc123', hash_source: 'streamed' },
                files: [
                    { path: '/tmp/a.txt', name: 'a.txt', size: 50, mtime: 1000, action: 'keep',   applied: false },
                    { path: '/tmp/b.txt', name: 'b.txt', size: 50, mtime: 900,  action: 'delete', applied: false },
                ]
            }]
        };
        try
        {
            Session.saveSession(sd, tmp);
            assert.ok(fs.existsSync(tmp), 'session file should be written');
            const loaded = Session.loadSession(tmp);
            assert.equal(loaded.version, 1);
            assert.equal(loaded.mode, 'sha256');
            assert.equal(loaded.entries.length, 1);
            assert.equal(loaded.entries[0].files[0].action, 'keep');
            assert.equal(loaded.entries[0].files[1].action, 'delete');
        }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    });

    test('loadSession throws on missing file', () =>
    {
        assert.throws(
            () => Session.loadSession('/nonexistent/session.yml'),
            /Session file not found/
        );
    });

    test('loadSession throws on unsupported version', () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-sess-v99-${Date.now()}.yml`);
        const yaml = require('js-yaml');
        fs.writeFileSync(tmp, yaml.dump({ version: 99, entries: [] }));
        try
        {
            assert.throws(
                () => Session.loadSession(tmp),
                /Unsupported session version/
            );
        }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    });

    test('saveSession updates last_saved_at and reclaimable_bytes', () =>
    {
        const tmp = path.join(os.tmpdir(), `fmeld-sess-meta-${Date.now()}.yml`);
        const sd = {
            version: 1, source: '', root: '/', mode: 'sha256',
            generated_at: new Date().toISOString(),
            scan: { recursive: false, include_empty: false, before: null, after: null,
                    minsize: null, maxsize: null, fnametime: null,
                    filter_files: null, filter_dirs: null },
            session: { path: null, state: 'review', temporary: false,
                       last_saved_at: null, last_applied_at: null,
                       last_scanned_at: null },
            summary: { groups: 1, files: 2, grouped_bytes: 200, reclaimable_bytes: 0 },
            entries: [{
                group_id: 'x', result: null, detection: { method: 'sha256', hash: 'x' },
                files: [
                    { path: '/a.txt', name: 'a.txt', size: 100, mtime: 0, action: 'keep',   applied: false },
                    { path: '/b.txt', name: 'b.txt', size: 100, mtime: 0, action: 'delete', applied: false },
                ]
            }]
        };
        try
        {
            Session.saveSession(sd, tmp);
            assert.ok(sd.session.last_saved_at, 'last_saved_at should be set');
            assert.equal(sd.summary.reclaimable_bytes, 100, 'reclaimable should reflect delete actions');
        }
        finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    });
});

// ---------------------------------------------------------------------------
// dupes — applySession (filesystem integration)
// ---------------------------------------------------------------------------

describe('applySession', () =>
{
    const Session = require('../lib/dupes-session.js');

    function makeTmpFiles(files)
    {
        const root = path.join(os.tmpdir(),
            `fmeld-apply-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        for (const [rel, content] of Object.entries(files))
        {
            const full = path.join(root, rel);
            fs.mkdirSync(path.dirname(full), {recursive: true});
            fs.writeFileSync(full, content);
        }
        return root;
    }

    test('delete action removes the file', async () =>
    {
        const root   = makeTmpFiles({ 'keep.txt': 'data', 'delete.txt': 'data' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const keepPath = path.join(root, 'keep.txt');
        const delPath  = path.join(root, 'delete.txt');
        const sd = {
            entries: [{
                group_id: 'test', result: null,
                detection: { method: 'sha256', hash: 'abc' },
                files: [
                    { path: keepPath, name: 'keep.txt', size: 4, mtime: 0, action: 'keep',   applied: false },
                    { path: delPath,  name: 'del.txt',  size: 4, mtime: 0, action: 'delete', applied: false },
                ]
            }],
            session: { state: 'review', last_applied_at: null },
            summary: { reclaimable_bytes: 4 },
        };
        try
        {
            const r = await Session.applySession(client, sd, { isFileBk: true });
            assert.equal(r.applied, 1);
            assert.ok(fs.existsSync(keepPath),  'kept file should remain');
            assert.ok(!fs.existsSync(delPath),  'deleted file should be gone');
            assert.equal(sd.entries[0].result, 'applied');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('link action creates a hardlink to the kept file', async () =>
    {
        const root   = makeTmpFiles({ 'original.txt': 'content', 'copy.txt': 'content' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const keepPath = path.join(root, 'original.txt');
        const linkPath = path.join(root, 'copy.txt');
        const sd = {
            entries: [{
                group_id: 'test', result: null,
                detection: { method: 'sha256', hash: 'abc' },
                files: [
                    { path: keepPath, name: 'original.txt', size: 7, mtime: 0, action: 'keep', applied: false },
                    { path: linkPath, name: 'copy.txt',     size: 7, mtime: 0, action: 'link', applied: false },
                ]
            }],
            session: { state: 'review', last_applied_at: null },
            summary: { reclaimable_bytes: 0 },
        };
        try
        {
            const r = await Session.applySession(client, sd, { isFileBk: true });
            assert.equal(r.applied, 1);
            assert.ok(fs.existsSync(keepPath));
            assert.ok(fs.existsSync(linkPath), 'link path should still exist as a hardlink');
            // Both paths share the same inode number after hardlinking
            const keepIno = fs.statSync(keepPath).ino;
            const linkIno = fs.statSync(linkPath).ino;
            assert.equal(keepIno, linkIno, 'hardlink should share inode with original');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('already-applied group is counted as skipped (idempotent)', async () =>
    {
        const root   = makeTmpFiles({ 'a.txt': 'x' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const sd = {
            entries: [{
                group_id: 'test', result: 'applied',  // already done
                detection: { method: 'sha256', hash: 'abc' },
                files: [{ path: path.join(root, 'a.txt'), name: 'a.txt', size: 1, mtime: 0, action: 'keep', applied: false }]
            }],
            session: { state: 'applied', last_applied_at: null },
            summary: { reclaimable_bytes: 0 },
        };
        try
        {
            const r = await Session.applySession(client, sd, { isFileBk: true });
            assert.equal(r.applied, 0);
            assert.equal(r.skipped, 1);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('review group blocks non-force apply', async () =>
    {
        const root   = makeTmpFiles({ 'a.txt': 'x', 'b.txt': 'x' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const sd = {
            entries: [{
                group_id: 'test', result: null,
                detection: { method: 'sha256', hash: 'abc' },
                files: [
                    { path: path.join(root, 'a.txt'), name: 'a.txt', size: 1, mtime: 0, action: 'keep',   applied: false },
                    { path: path.join(root, 'b.txt'), name: 'b.txt', size: 1, mtime: 0, action: 'review', applied: false },
                ]
            }],
            session: { state: 'review', last_applied_at: null },
            summary: { reclaimable_bytes: 0 },
        };
        try
        {
            await assert.rejects(
                () => Session.applySession(client, sd, { isFileBk: true, force: false }),
                /Blocking/
            );
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('review group is skipped with --force', async () =>
    {
        const root   = makeTmpFiles({ 'a.txt': 'x', 'b.txt': 'x' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const sd = {
            entries: [{
                group_id: 'test', result: null,
                detection: { method: 'sha256', hash: 'abc' },
                files: [
                    { path: path.join(root, 'a.txt'), name: 'a.txt', size: 1, mtime: 0, action: 'keep',   applied: false },
                    { path: path.join(root, 'b.txt'), name: 'b.txt', size: 1, mtime: 0, action: 'review', applied: false },
                ]
            }],
            session: { state: 'review', last_applied_at: null },
            summary: { reclaimable_bytes: 0 },
        };
        try
        {
            // Swallow the stderr warning
            const origWrite = process.stderr.write.bind(process.stderr);
            process.stderr.write = () => true;
            let r;
            try  { r = await Session.applySession(client, sd, { isFileBk: true, force: true }); }
            finally { process.stderr.write = origWrite; }
            assert.equal(r.skipped, 1);
            assert.equal(r.failed,  0);
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    test('all-none group is skipped automatically without --force', async () =>
    {
        const root   = makeTmpFiles({ 'a.txt': 'x', 'b.txt': 'x' });
        const client = fmeld.getConnection(`file://${root}`, null, {verbose: false});
        await client.connect();
        const sd = {
            entries: [{
                group_id: 'test', result: null,
                detection: { method: 'sha256', hash: 'abc' },
                files: [
                    { path: path.join(root, 'a.txt'), name: 'a.txt', size: 1, mtime: 0, action: 'none', applied: false },
                    { path: path.join(root, 'b.txt'), name: 'b.txt', size: 1, mtime: 0, action: 'none', applied: false },
                ]
            }],
            session: { state: 'review', last_applied_at: null },
            summary: { reclaimable_bytes: 0 },
        };
        try
        {
            const origWrite = process.stderr.write.bind(process.stderr);
            process.stderr.write = () => true;
            let r;
            try  { r = await Session.applySession(client, sd, { isFileBk: true, force: false }); }
            finally { process.stderr.write = origWrite; }
            assert.equal(r.skipped, 1);
            assert.equal(r.applied, 0);
            assert.ok(fs.existsSync(path.join(root, 'a.txt')), 'files should be untouched');
            assert.ok(fs.existsSync(path.join(root, 'b.txt')), 'files should be untouched');
        }
        finally
        {
            await client.close();
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
});
