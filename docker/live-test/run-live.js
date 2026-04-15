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
        },
        {
            name:     'webdav',
            readUrl:  'webdav://demo:password@webdav:8080/',
            writeUrl: `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav`,
            syncUrl:  `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav-sync`,
        },
        {
            name:     'sftp',
            readUrl:  'sftp://demo:password@sftp/home/demo/data',
            writeUrl: `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp`,
            syncUrl:  `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp-sync`,
        },
        {
            name:     'smb',
            readUrl:  'smb://demo:password@smb/share',
            writeUrl: `smb://demo:password@smb/share/uploads/${RUN_ID}/smb`,
            syncUrl:  `smb://demo:password@smb/share/uploads/${RUN_ID}/smb-sync`,
        },
        {
            name:     's3',
            readUrl:  's3://fmeld-live/?endpoint=http://minio:9000&region=us-east-1&force-path-style=true',
            writeUrl: `s3://fmeld-live/uploads/${RUN_ID}/s3?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            syncUrl:  `s3://fmeld-live/uploads/${RUN_ID}/s3-sync?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            cred:     path.join(CREDS, 's3.json'),
        },
        {
            name:     'azblob',
            readUrl:  'azblob://fmeld-live/',
            writeUrl: `azblob://fmeld-live/uploads/${RUN_ID}/azblob`,
            syncUrl:  `azblob://fmeld-live/uploads/${RUN_ID}/azblob-sync`,
            cred:     path.join(CREDS, 'azblob.json'),
        }
    ];

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
