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
const FIXTURES = path.join(ROOT, 'docker/live-test/fixtures/share');
const TMP = process.env.FMELD_LIVE_TMP || '/tmp/fmeld-live';
const RUN_ID = process.env.FMELD_LIVE_RUN_ID || `run-${Date.now()}`;
const CREDS = path.join(TMP, 'creds');
const DOWNLOADS = path.join(TMP, 'downloads');
const ROUNDTRIPS = path.join(TMP, 'roundtrips');
const UPLOAD_SRC = path.join(TMP, 'upload-src');

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

function assertSeedDownloaded(dir)
{
    assert.ok(fs.existsSync(path.join(dir, 'root.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'nested', 'child.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'nested', 'deeper', 'value.json')));
}

function assertUploadRoundTrip(dir)
{
    assert.ok(fs.existsSync(path.join(dir, 'upload.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'nested', 'echo.txt')));
}

async function main()
{
    clearDir(TMP);
    fs.mkdirSync(DOWNLOADS, {recursive: true});
    fs.mkdirSync(ROUNDTRIPS, {recursive: true});

    log('Waiting for live-test services');
    await Promise.all([
        waitForPort('ftp', 2121),
        waitForPort('webdav', 8080),
        waitForPort('sftp', 22),
        waitForPort('smb', 445),
        waitForPort('minio', 9000),
        waitForPort('azurite', 10000)
    ]);

    writeCredFiles();
    writeUploadSource();
    await seedS3();
    await seedAzurite();

    const cases = [
        {
            name: 'ftp',
            readUrl: 'ftp://demo:password@ftp:2121/',
            writeUrl: `ftp://demo:password@ftp:2121/uploads/${RUN_ID}/ftp`,
            writeMode: 'cp'
        },
        {
            name: 'webdav',
            readUrl: 'webdav://demo:password@webdav:8080/',
            writeUrl: `webdav://demo:password@webdav:8080/uploads/${RUN_ID}/webdav`,
            writeMode: 'cp'
        },
        {
            name: 'sftp',
            readUrl: 'sftp://demo:password@sftp/home/demo/data',
            writeUrl: `sftp://demo:password@sftp/home/demo/data/uploads/${RUN_ID}/sftp`,
            writeMode: 'sync'
        },
        {
            name: 'smb',
            readUrl: 'smb://demo:password@smb/share',
            writeUrl: `smb://demo:password@smb/share/uploads/${RUN_ID}/smb`,
            writeMode: 'cp'
        },
        {
            name: 's3',
            readUrl: 's3://fmeld-live/?endpoint=http://minio:9000&region=us-east-1&force-path-style=true',
            writeUrl: `s3://fmeld-live/uploads/${RUN_ID}/s3?endpoint=http://minio:9000&region=us-east-1&force-path-style=true`,
            cred: path.join(CREDS, 's3.json'),
            writeMode: 'sync'
        },
        {
            name: 'azblob',
            readUrl: 'azblob://fmeld-live/',
            writeUrl: `azblob://fmeld-live/uploads/${RUN_ID}/azblob`,
            cred: path.join(CREDS, 'azblob.json'),
            writeMode: 'cp'
        }
    ];

    for (const testCase of cases)
    {
        log(`Smoke testing ${testCase.name}`);

        const sourceCredArgs = testCase.cred ? ['-S', testCase.cred] : [];
        const destCredArgs = testCase.cred ? ['-E', testCase.cred] : [];

        runFmeld([...sourceCredArgs, '-s', testCase.readUrl, '-r', 'ls']);

        const downloadDir = path.join(DOWNLOADS, testCase.name);
        clearDir(downloadDir);
        runFmeld([...sourceCredArgs, '-s', testCase.readUrl, '-d', fileUrl(downloadDir), '-r', 'cp']);
        assertSeedDownloaded(downloadDir);

        if ('sync' === testCase.writeMode)
            runFmeld([...destCredArgs, '-s', fileUrl(UPLOAD_SRC), '-d', testCase.writeUrl, '-r', '-U', 'sync']);
        else
            runFmeld([...destCredArgs, '-s', fileUrl(UPLOAD_SRC), '-d', testCase.writeUrl, '-r', 'cp']);

        const roundTripDir = path.join(ROUNDTRIPS, testCase.name);
        clearDir(roundTripDir);
        runFmeld([...sourceCredArgs, '-s', testCase.writeUrl, '-d', fileUrl(roundTripDir), '-r', 'cp']);
        assertUploadRoundTrip(roundTripDir);
    }

    log('All live protocol checks passed');
}

main().catch(err =>
{
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
