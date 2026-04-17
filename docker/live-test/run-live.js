#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BlobServiceClient } = require('@azure/storage-blob');

const ROOT = '/app';
const FIXTURES   = path.join(ROOT, 'docker/live-test/fixtures/share');
const TMP        = process.env.FMELD_LIVE_TMP || '/tmp/fmeld-live';
const RUN_ID     = process.env.FMELD_LIVE_RUN_ID || `run-${Date.now()}`;
const CREDS      = path.join(TMP, 'creds');
const DOWNLOADS  = path.join(TMP, 'downloads');
const ROUNDTRIPS = path.join(TMP, 'roundtrips');
const UPLOAD_SRC = path.join(TMP, 'upload-src');
const SYNC_SRC_V1 = path.join(TMP, 'sync-src-v1');
const SYNC_SRC_V2 = path.join(TMP, 'sync-src-v2');
const DUPES_LOCAL = path.join(TMP, 'dupes-local');

const AZURITE_CONNECTION_STRING = [
    'DefaultEndpointsProtocol=http',
    'AccountName=devstoreaccount1',
    'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==',
    'BlobEndpoint=http://azurite:10000/devstoreaccount1'
].join(';');

function log(msg)
{
    console.log(`\n== ${msg}`);
}

function fileUrl(p)
{
    return `file://${p}`;
}

/** Append a sub-path to a URL, preserving any query string */
function appendUrlPath(url, subPath)
{
    const qIdx = url.indexOf('?');
    if (qIdx >= 0)
        return `${url.slice(0, qIdx)}/${subPath}${url.slice(qIdx)}`;
    return `${url}/${subPath}`;
}

function clearDir(dir)
{
    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
}

function walkFiles(dir, rel = '')
{
    const base = rel ? path.join(dir, rel) : dir;
    const out = [];
    for (const name of fs.readdirSync(base, {withFileTypes: true}))
    {
        const nextRel = rel ? path.join(rel, name.name) : name.name;
        if (name.isDirectory())
            out.push(...walkFiles(dir, nextRel));
        else
            out.push(nextRel);
    }
    return out;
}

function waitForPort(host, port, timeoutMs = 60000)
{
    const started = Date.now();
    return new Promise((resolve, reject) =>
    {
        const tryConnect = () =>
        {
            const socket = net.createConnection({host, port});
            socket.once('connect', () =>
            {
                socket.destroy();
                resolve();
            });
            socket.once('error', () =>
            {
                socket.destroy();
                if (Date.now() - started > timeoutMs)
                    reject(new Error(`Timed out waiting for ${host}:${port}`));
                else
                    setTimeout(tryConnect, 500);
            });
        };
        tryConnect();
    });
}

function runFmeld(args)
{
    console.log(`$ node bin/fmeld.js ${args.join(' ')}`);
    const proc = spawnSync('node', ['bin/fmeld.js', ...args],
        {cwd: ROOT, encoding: 'utf8', timeout: 30_000});

    if (proc.stdout)
        process.stdout.write(proc.stdout);
    if (proc.stderr)
        process.stderr.write(proc.stderr);

    if (proc.error)
        throw proc.error;
    if (0 !== proc.status)
        throw new Error(`fmeld exited with code ${proc.status}`);
}

async function seedS3()
{
    log('Seeding MinIO bucket');

    const client = new S3Client({
        region: 'us-east-1',
        endpoint: 'http://minio:9000',
        forcePathStyle: true,
        credentials: {
            accessKeyId: 'minioadmin',
            secretAccessKey: 'minioadmin'
        }
    });

    try
    {
        await client.send(new HeadBucketCommand({Bucket: 'fmeld-live'}));
    }
    catch(e)
    {
        await client.send(new CreateBucketCommand({Bucket: 'fmeld-live'}));
    }

    for (const rel of walkFiles(FIXTURES))
    {
        await client.send(new PutObjectCommand({
            Bucket: 'fmeld-live',
            Key: rel.replace(/\\/g, '/'),
            Body: fs.readFileSync(path.join(FIXTURES, rel))
        }));
    }
}

async function seedAzurite()
{
    log('Seeding Azurite container');

    const service = BlobServiceClient.fromConnectionString(AZURITE_CONNECTION_STRING);
    const container = service.getContainerClient('fmeld-live');
    await container.createIfNotExists();

    for (const rel of walkFiles(FIXTURES))
    {
        const blob = container.getBlockBlobClient(rel.replace(/\\/g, '/'));
        await blob.uploadData(fs.readFileSync(path.join(FIXTURES, rel)), {overwrite: true});
    }
}

function writeCredFiles()
{
    fs.mkdirSync(CREDS, {recursive: true});

    fs.writeFileSync(path.join(CREDS, 's3.json'), JSON.stringify({
        access_key_id: 'minioadmin',
        secret_access_key: 'minioadmin',
        region: 'us-east-1'
    }, null, 2));

    fs.writeFileSync(path.join(CREDS, 'azblob.json'), JSON.stringify({
        connection_string: AZURITE_CONNECTION_STRING
    }, null, 2));
}

function writeUploadSource()
{
    clearDir(UPLOAD_SRC);
    fs.mkdirSync(path.join(UPLOAD_SRC, 'nested'), {recursive: true});
    fs.writeFileSync(path.join(UPLOAD_SRC, 'upload.txt'), 'upload smoke\n');
    fs.writeFileSync(path.join(UPLOAD_SRC, 'nested', 'echo.txt'), 'nested upload smoke\n');
}

function writeSyncSources()
{
    // v1: initial two files
    clearDir(SYNC_SRC_V1);
    fs.writeFileSync(path.join(SYNC_SRC_V1, 'sync-a.txt'), 'sync file a\n');
    fs.writeFileSync(path.join(SYNC_SRC_V1, 'sync-b.txt'), 'sync file b\n');

    // v2: keeps sync-a.txt (unchanged — should not re-upload), adds sync-c.txt
    // sync-b.txt is absent; sync -U does not delete from destination, so it persists
    clearDir(SYNC_SRC_V2);
    fs.writeFileSync(path.join(SYNC_SRC_V2, 'sync-a.txt'), 'sync file a\n');
    fs.writeFileSync(path.join(SYNC_SRC_V2, 'sync-c.txt'), 'sync file c\n');
}

/** Assert that the seeded fixture tree was downloaded correctly, including content */
function assertSeedDownloaded(dir)
{
    const files = [
        'root.txt',
        path.join('nested', 'child.txt'),
        path.join('nested', 'deeper', 'value.json'),
        'has space.txt',
    ];
    for (const rel of files)
    {
        const downloaded = path.join(dir, rel);
        assert.ok(fs.existsSync(downloaded), `Missing file after download: ${rel}`);
        const actual   = fs.readFileSync(downloaded);
        const expected = fs.readFileSync(path.join(FIXTURES, rel));
        assert.ok(actual.equals(expected), `Content mismatch after download: ${rel}`);
    }
}

/** Assert that the upload source survived the round-trip, including content */
function assertUploadRoundTrip(dir)
{
    const files = ['upload.txt', path.join('nested', 'echo.txt')];
    for (const rel of files)
    {
        const roundtripped = path.join(dir, rel);
        assert.ok(fs.existsSync(roundtripped), `Missing file after round-trip: ${rel}`);
        const actual   = fs.readFileSync(roundtripped);
        const expected = fs.readFileSync(path.join(UPLOAD_SRC, rel));
        assert.ok(actual.equals(expected), `Content mismatch after round-trip: ${rel}`);
    }
}

async function main()
{
    clearDir(TMP);
    fs.mkdirSync(DOWNLOADS,  {recursive: true});
    fs.mkdirSync(ROUNDTRIPS, {recursive: true});

    log('Waiting for live-test services');
    await Promise.all([
        waitForPort('ftp',     2121),
        waitForPort('webdav',  8080),
        waitForPort('sftp',    22),
        waitForPort('smb',     445),
        waitForPort('minio',   9000),
        waitForPort('azurite', 10000)
    ]);

    writeCredFiles();
    writeUploadSource();
    writeSyncSources();
    await seedS3();
    await seedAzurite();

    const cases = [
        {
            name:     'ftp',
            readUrl:  'ftp://demo:password@ftp:2121/',
            writeUrl: `ftp://demo:password@ftp:2121/uploads/${RUN_ID}/ftp`,
            syncUrl:  `ftp://demo:password@ftp:2121/uploads/${RUN_ID}/ftp-sync`,
            dupesUrl: `ftp://demo:password@ftp:2121/uploads/${RUN_ID}/ftp-dupes`,
        },
        {
            name:     'webdav',
            readUrl:  'webdav://demo:password@webdav:8080/',
            writeUrl: `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav`,
            syncUrl:  `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav-sync`,
            dupesUrl: `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav-dupes`,
        },
        {
            name:     'sftp',
            readUrl:  'sftp://demo:password@sftp/home/demo/data',
            writeUrl: `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp`,
            syncUrl:  `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp-sync`,
            dupesUrl: `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp-dupes`,
        },
        {
            name:     'smb',
            readUrl:  'smb://demo:password@smb/share',
            writeUrl: `smb://demo:password@smb/share/uploads/${RUN_ID}/smb`,
            syncUrl:  `smb://demo:password@smb/share/uploads/${RUN_ID}/smb-sync`,
            dupesUrl: `smb://demo:password@smb/share/uploads/${RUN_ID}/smb-dupes`,
        },
        {
            name:     's3',
            readUrl:  's3://fmeld-live/?endpoint=http://minio:9000&region=us-east-1&force-path-style=true',
            writeUrl: `s3://fmeld-live/uploads/${RUN_ID}/s3?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            syncUrl:  `s3://fmeld-live/uploads/${RUN_ID}/s3-sync?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            dupesUrl: `s3://fmeld-live/uploads/${RUN_ID}/s3-dupes?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            cred:     path.join(CREDS, 's3.json'),
        },
        {
            name:     'azblob',
            readUrl:  'azblob://fmeld-live/',
            writeUrl: `azblob://fmeld-live/uploads/${RUN_ID}/azblob`,
            syncUrl:  `azblob://fmeld-live/uploads/${RUN_ID}/azblob-sync`,
            dupesUrl: `azblob://fmeld-live/uploads/${RUN_ID}/azblob-dupes`,
            cred:     path.join(CREDS, 'azblob.json'),
        }
    ];

    // ── local file:// dupes tests ──────────────────────────────────────────────

    log('dupes: local delete (sha256 + shortest-path keep)');
    {
        const dir = path.join(DUPES_LOCAL, 'delete');
        clearDir(dir);
        fs.mkdirSync(path.join(dir, 'sub'), {recursive: true});
        const dup = 'duplicate content for delete smoke test\n';
        // 'a.txt' has the shortest full path; the others are longer
        fs.writeFileSync(path.join(dir, 'a.txt'), dup);
        fs.writeFileSync(path.join(dir, 'longer-copy.txt'), dup);
        fs.writeFileSync(path.join(dir, 'sub', 'x.txt'), dup);
        fs.writeFileSync(path.join(dir, 'unique.txt'), 'unique content\n');

        runFmeld(['-s', fileUrl(dir), '-r', 'dupes', '--by', 'sha256',
                  '--keep', 'shortest-path', '--remaining', 'delete',
                  '--session', path.join(DUPES_LOCAL, 'delete.yml'), '--apply']);

        assert.ok(fs.existsSync(path.join(dir, 'unique.txt')),
            'unique.txt must survive dupes delete');
        assert.ok(fs.existsSync(path.join(dir, 'a.txt')),
            'a.txt (shortest path) must be kept');
        assert.ok(!fs.existsSync(path.join(dir, 'longer-copy.txt')),
            'longer-copy.txt must be deleted');
        assert.ok(!fs.existsSync(path.join(dir, 'sub', 'x.txt')),
            'sub/x.txt must be deleted');
    }

    log('dupes: local hardlink (sha256 + inode check)');
    {
        const dir = path.join(DUPES_LOCAL, 'link');
        clearDir(dir);
        const dup = 'duplicate content for link smoke test\n';
        fs.writeFileSync(path.join(dir, 'original.txt'), dup);
        fs.writeFileSync(path.join(dir, 'copy.txt'), dup);

        runFmeld(['-s', fileUrl(dir), '-r', 'dupes', '--by', 'sha256',
                  '--keep', 'shortest-path', '--remaining', 'link',
                  '--session', path.join(DUPES_LOCAL, 'link.yml'), '--apply']);

        assert.ok(fs.existsSync(path.join(dir, 'original.txt')),
            'original.txt must exist after link');
        assert.ok(fs.existsSync(path.join(dir, 'copy.txt')),
            'copy.txt must exist after link');
        const inoA = fs.statSync(path.join(dir, 'original.txt')).ino;
        const inoB = fs.statSync(path.join(dir, 'copy.txt')).ino;
        assert.strictEqual(inoA, inoB,
            'hardlinked files must share the same inode');
    }

    log('dupes: local name-only mode');
    {
        const dir = path.join(DUPES_LOCAL, 'name');
        clearDir(dir);
        fs.mkdirSync(path.join(dir, 'a'), {recursive: true});
        fs.mkdirSync(path.join(dir, 'ab'), {recursive: true});
        // same filename, different content — grouped by name only
        // 'a/report.txt' has a shorter full path than 'ab/report.txt' (1-char vs 2-char dir)
        fs.writeFileSync(path.join(dir, 'a', 'report.txt'), 'version A\n');
        fs.writeFileSync(path.join(dir, 'ab', 'report.txt'), 'version B\n');
        // unique name — must not be touched
        fs.writeFileSync(path.join(dir, 'a', 'other.txt'), 'only once\n');

        runFmeld(['-s', fileUrl(dir), '-r', 'dupes', '--by', 'name',
                  '--keep', 'shortest-path', '--remaining', 'delete',
                  '--session', path.join(DUPES_LOCAL, 'name.yml'), '--apply']);

        // a/report.txt path is shorter than ab/report.txt → kept
        assert.ok(fs.existsSync(path.join(dir, 'a', 'report.txt')),
            'a/report.txt (shorter path) must be kept');
        assert.ok(!fs.existsSync(path.join(dir, 'ab', 'report.txt')),
            'ab/report.txt must be deleted (same name, longer path)');
        assert.ok(fs.existsSync(path.join(dir, 'a', 'other.txt')),
            'other.txt (unique name) must be untouched');
    }

    log('dupes: local md5 mode + regex keep');
    {
        const dir = path.join(DUPES_LOCAL, 'md5-regex');
        clearDir(dir);
        fs.mkdirSync(path.join(dir, 'archive'), {recursive: true});
        const dup = 'duplicate content for md5 regex test\n';
        fs.writeFileSync(path.join(dir, 'current.txt'), dup);
        fs.writeFileSync(path.join(dir, 'archive', 'old.txt'), dup);

        runFmeld(['-s', fileUrl(dir), '-r', 'dupes', '--by', 'md5',
                  '--keep', 'regex', '--keep-pattern', '/archive/',
                  '--remaining', 'delete',
                  '--session', path.join(DUPES_LOCAL, 'md5-regex.yml'), '--apply']);

        // archive/old.txt matches the regex → kept; current.txt → deleted
        assert.ok(fs.existsSync(path.join(dir, 'archive', 'old.txt')),
            'archive/old.txt (regex match) must be kept');
        assert.ok(!fs.existsSync(path.join(dir, 'current.txt')),
            'current.txt must be deleted (no regex match)');
    }

    log('dupes: idempotent re-apply (session already applied)');
    {
        const dir = path.join(DUPES_LOCAL, 'idempotent');
        clearDir(dir);
        const dup = 'idempotent test content\n';
        fs.writeFileSync(path.join(dir, 'a.txt'), dup);
        fs.writeFileSync(path.join(dir, 'b.txt'), dup);
        const sess = path.join(DUPES_LOCAL, 'idempotent.yml');

        // first apply: deletes one file
        runFmeld(['-s', fileUrl(dir), '-r', 'dupes', '--by', 'sha256',
                  '--keep', 'first', '--remaining', 'delete',
                  '--session', sess, '--apply']);

        // second apply of the same session: all entries already 'applied' → skipped
        runFmeld(['-s', fileUrl(dir), 'dupes', '--session', sess, '--apply']);
    }

    // ── per-backend tests ───────────────────────────────────────────────────

    for (const tc of cases)
    {
        log(`Smoke testing ${tc.name}`);

        const srcCred  = tc.cred ? ['-S', tc.cred] : [];
        const dstCred  = tc.cred ? ['-E', tc.cred] : [];
        const writeSrcCred = tc.cred ? ['-S', tc.cred] : [];

        // ls
        runFmeld([...srcCred, '-s', tc.readUrl, '-r', 'ls']);

        // download seed and verify content
        const downloadDir = path.join(DOWNLOADS, tc.name);
        clearDir(downloadDir);
        runFmeld([...srcCred, '-s', tc.readUrl, '-d', fileUrl(downloadDir), '-r', 'cp']);
        assertSeedDownloaded(downloadDir);

        // upload via sync (exercises sync on every backend)
        runFmeld([...dstCred, '-s', fileUrl(UPLOAD_SRC), '-d', tc.writeUrl, '-r', '-U', 'sync']);

        // round-trip download and verify content
        const roundTripDir = path.join(ROUNDTRIPS, tc.name);
        clearDir(roundTripDir);
        runFmeld([...srcCred, '-s', tc.writeUrl, '-d', fileUrl(roundTripDir), '-r', 'cp']);
        assertUploadRoundTrip(roundTripDir);

        // ── unlink: delete one file and verify it is gone ───────────────────

        log(`unlink: ${tc.name}`);

        runFmeld([...writeSrcCred, '-s', appendUrlPath(tc.writeUrl, 'upload.txt'), '-r', 'unlink']);

        const postUnlinkDir = path.join(TMP, 'post-unlink', tc.name);
        clearDir(postUnlinkDir);
        runFmeld([...srcCred, '-s', tc.writeUrl, '-d', fileUrl(postUnlinkDir), '-r', 'cp']);
        assert.ok(
            !fs.existsSync(path.join(postUnlinkDir, 'upload.txt')),
            `${tc.name}: upload.txt should be absent after unlink`
        );
        assert.ok(
            fs.existsSync(path.join(postUnlinkDir, 'nested', 'echo.txt')),
            `${tc.name}: nested/echo.txt should remain after unlink`
        );

        // ── rm: delete the uploaded directory entirely ──────────────────────

        log(`rm: ${tc.name}`);

        runFmeld([...writeSrcCred, '-s', tc.writeUrl, '-r', 'rm']);

        // ── sync delta: verify new files appear after a second sync pass ────

        log(`sync delta: ${tc.name}`);

        // initial sync
        runFmeld([...dstCred, '-s', fileUrl(SYNC_SRC_V1), '-d', tc.syncUrl, '-r', '-U', 'sync']);

        // second sync: sync-a.txt unchanged (should be skipped), sync-c.txt added
        runFmeld([...dstCred, '-s', fileUrl(SYNC_SRC_V2), '-d', tc.syncUrl, '-r', '-U', 'sync']);

        const syncDeltaDir = path.join(TMP, 'sync-delta', tc.name);
        clearDir(syncDeltaDir);
        runFmeld([...srcCred, '-s', tc.syncUrl, '-d', fileUrl(syncDeltaDir), '-r', 'cp']);

        // sync-a and sync-b were in v1; sync -U does not delete, so both persist
        assert.ok(fs.existsSync(path.join(syncDeltaDir, 'sync-a.txt')), `${tc.name}: sync-a.txt missing`);
        assert.ok(fs.existsSync(path.join(syncDeltaDir, 'sync-b.txt')), `${tc.name}: sync-b.txt missing`);
        // sync-c was added in v2 and should have been uploaded
        assert.ok(fs.existsSync(path.join(syncDeltaDir, 'sync-c.txt')), `${tc.name}: sync-c.txt missing after sync delta`);
        assert.ok(
            fs.readFileSync(path.join(syncDeltaDir, 'sync-c.txt')).equals(fs.readFileSync(path.join(SYNC_SRC_V2, 'sync-c.txt'))),
            `${tc.name}: sync-c.txt content mismatch`
        );

        // ── dupes: upload duplicate files, scan, apply delete, verify ──────────

        log(`dupes: ${tc.name}`);

        const dupesUploadDir = path.join(TMP, 'dupes-upload', tc.name);
        clearDir(dupesUploadDir);
        const dupContent = 'remote duplicate content for smoke test\n';
        fs.writeFileSync(path.join(dupesUploadDir, 'original.txt'), dupContent);
        fs.writeFileSync(path.join(dupesUploadDir, 'copy1.txt'),    dupContent);
        fs.writeFileSync(path.join(dupesUploadDir, 'copy2.txt'),    dupContent);
        fs.writeFileSync(path.join(dupesUploadDir, 'unique.txt'),   'unique remote content\n');

        runFmeld([...dstCred, '-s', fileUrl(dupesUploadDir), '-d', tc.dupesUrl, '-r', '-U', 'sync']);

        const dupesSessionFile = path.join(TMP, `dupes-${tc.name}.yml`);
        runFmeld([...srcCred, '-s', tc.dupesUrl, '-r', 'dupes', '--by', 'sha256',
                  '--keep', 'first', '--remaining', 'delete',
                  '--session', dupesSessionFile, '--apply']);

        const dupesVerifyDir = path.join(TMP, 'dupes-verify', tc.name);
        clearDir(dupesVerifyDir);
        runFmeld([...srcCred, '-s', tc.dupesUrl, '-d', fileUrl(dupesVerifyDir), '-r', 'cp']);

        const dupesRemaining = walkFiles(dupesVerifyDir);
        assert.ok(dupesRemaining.includes('unique.txt'),
            `${tc.name}: unique.txt must remain after dupes`);
        assert.strictEqual(
            dupesRemaining.filter(f => ['original.txt', 'copy1.txt', 'copy2.txt'].includes(f)).length,
            1,
            `${tc.name}: exactly one duplicate must remain after dupes (found: ${dupesRemaining.join(', ')})`
        );
    }

    // ── cross-backend: ftp → webdav (no local intermediate) ────────────────

    log('Cross-backend: ftp → webdav');

    const crossUrl = `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/cross`;
    runFmeld(['-s', 'ftp://demo:password@ftp:2121/', '-d', crossUrl, '-r', 'cp']);

    const crossDir = path.join(DOWNLOADS, 'cross');
    clearDir(crossDir);
    runFmeld(['-s', crossUrl, '-d', fileUrl(crossDir), '-r', 'cp']);
    assertSeedDownloaded(crossDir);

    log('All live protocol checks passed');
}

main().catch(err =>
{
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
