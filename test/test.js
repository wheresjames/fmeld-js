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
        'cleanDir', 'syncDir', 'promiseWhile', 'promiseWhileBatch', 'toHuman',
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

    for (const name of configFns)
        test(`fmeld.__config__.${name} is a function`,
             () => assert.equal(typeof fmeld.__config__[name], 'function'));
});
