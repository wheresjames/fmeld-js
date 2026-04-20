#!/usr/bin/env node
'use strict';

/**
 * Live cloud smoke test runner.
 *
 * Usage:
 *   node run-live-cloud-smoketests.js --config live-tests.yml [--doctor]
 *
 * --doctor  Validates the manifest and environment without writing anything.
 * --config  Path to the live test manifest (YAML).
 *
 * See todo/smoketests.md for the manifest format and full strategy.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;

// ── helpers ────────────────────────────────────────────────────────────────

function nowStamp()
{
    return new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
}

function formatDuration(ms)
{
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function loadYaml(filePath)
{
    // js-yaml is a direct dependency of fmeld
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function redact(str)
{
    if (typeof str !== 'string') return str;
    return str.replace(/(key|secret|password|token|cred)[^:]*:\s*\S+/gi, '$1: [REDACTED]');
}

function runFmeld(args, opts = {})
{
    const display = args.map(a =>
        (typeof a === 'string' && /password|secret|key|token/i.test(a)) ? '[REDACTED]' : a
    ).join(' ');
    if (!opts.quiet)
        console.log(`  $ node bin/fmeld.js ${display}`);

    const proc = spawnSync('node', ['bin/fmeld.js', ...args],
        {cwd: ROOT, encoding: 'utf8', timeout: 60_000});

    if (proc.stdout && !opts.quiet) process.stdout.write(proc.stdout);
    if (proc.stderr && !opts.quiet) process.stderr.write(proc.stderr);
    if (proc.error)  throw proc.error;
    if (0 !== proc.status)
        throw new Error(`fmeld exited with code ${proc.status}`);

    return proc.stdout || '';
}

function walkFiles(dir, rel = '')
{
    const base = rel ? path.join(dir, rel) : dir;
    const out  = [];
    for (const name of fs.readdirSync(base, {withFileTypes: true}))
    {
        const nextRel = rel ? path.join(rel, name.name) : name.name;
        if (name.isDirectory()) out.push(...walkFiles(dir, nextRel));
        else out.push(nextRel);
    }
    return out;
}

function clearDir(dir)
{
    fs.rmSync(dir, {recursive: true, force: true});
    fs.mkdirSync(dir, {recursive: true});
}

// ── manifest validation ────────────────────────────────────────────────────

const KNOWN_OPS = new Set(['ls', 'cp', 'sync', 'unlink', 'rm', 'dupes']);
const DESTRUCTIVE_OPS = new Set(['unlink', 'rm']);

function validateManifest(manifest, configPath)
{
    const errors = [];

    if (!manifest || typeof manifest !== 'object')
        return ['Manifest is not a valid YAML object'];

    if (manifest.version !== 1)
        errors.push(`version must be 1 (got: ${manifest.version})`);

    if (manifest.backends && typeof manifest.backends === 'object')
    {
        for (const [name, cfg] of Object.entries(manifest.backends))
        {
            if (!cfg.enabled) continue;

            if (!cfg.root)
                errors.push(`backends.${name}: root is required`);
            else if (cfg.root === '/' || cfg.root === '')
                errors.push(`backends.${name}: root must not be the filesystem root`);

            const credFile = cfg.cred_file
                ? cfg.cred_file.replace(/^~/, os.homedir())
                : null;
            const credEnv = cfg.cred_env
                ? process.env[cfg.cred_env]
                : null;

            if (!credFile && !credEnv)
                errors.push(`backends.${name}: either cred_file or cred_env is required`);
            else if (credFile && !fs.existsSync(credFile))
                errors.push(`backends.${name}: cred_file not found: ${credFile}`);

            if (cfg.ops)
            {
                for (const op of cfg.ops)
                    if (!KNOWN_OPS.has(op))
                        errors.push(`backends.${name}: unknown op: ${op}`);
            }
        }
    }

    return errors;
}

// ── doctor mode ────────────────────────────────────────────────────────────

function doctor(manifest, configPath)
{
    console.log(`\nfmeld doctor — validating: ${configPath}\n`);

    const errors = validateManifest(manifest, configPath);
    if (errors.length)
    {
        console.error('Manifest errors:');
        for (const e of errors) console.error(`  ✗ ${e}`);
        process.exit(1);
    }

    const effectiveDestructive = manifest.allow_destructive !== false;

    console.log(`  version:           ${manifest.version}`);
    console.log(`  report_dir:        ${manifest.report_dir || './reports'}`);
    console.log(`  run_id_prefix:     ${manifest.run_id_prefix || 'run'}`);
    console.log(`  allow_destructive: ${effectiveDestructive}`);
    console.log('');

    const backends = manifest.backends || {};
    for (const [name, cfg] of Object.entries(backends))
    {
        const enabled = !!cfg.enabled;
        if (!enabled) { console.log(`  ${name.padEnd(12)} SKIP  (disabled)`); continue; }

        const credFile = cfg.cred_file
            ? cfg.cred_file.replace(/^~/, os.homedir())
            : null;
        const credEnv = cfg.cred_env
            ? process.env[cfg.cred_env]
            : null;

        const credOk = (credFile && fs.existsSync(credFile)) ||
                       (credEnv  && credEnv.trim().length > 0);

        if (!credOk)
        {
            console.log(`  ${name.padEnd(12)} SKIP  (no credentials)`);
            continue;
        }

        const backendDestructive = cfg.allow_destructive !== undefined
            ? cfg.allow_destructive
            : effectiveDestructive;

        const ops     = cfg.ops || ['ls', 'cp', 'sync', 'unlink', 'rm'];
        const safeOps = backendDestructive
            ? ops
            : ops.filter(o => !DESTRUCTIVE_OPS.has(o));

        const mode = cfg.read_only ? 'read-only' : (backendDestructive ? 'full' : 'non-destructive');
        console.log(`  ${name.padEnd(12)} RUN   root=${cfg.root}  ops=[${safeOps.join(',')}]  mode=${mode}`);
    }

    console.log('\ndoctor: OK\n');
}

// ── per-backend smoke ──────────────────────────────────────────────────────

function smokeBackend(name, cfg, manifest, tmpDir)
{
    const result = {
        name,
        result:       'fail',
        operations:   [],
        failedAt:     null,
        cleanupOk:    null,
        leakedPrefix: null,
        durationMs:   0
    };

    const started = Date.now();

    const effectiveDestructive = cfg.allow_destructive !== undefined
        ? cfg.allow_destructive
        : (manifest.allow_destructive !== false);

    const allowedOps = new Set(cfg.ops || ['ls', 'cp', 'sync', 'unlink', 'rm']);
    if (!effectiveDestructive)
        for (const op of DESTRUCTIVE_OPS) allowedOps.delete(op);
    if (cfg.read_only)
        for (const op of ['sync', 'unlink', 'rm']) allowedOps.delete(op);

    const runId = `${manifest.run_id_prefix || 'run'}-${nowStamp()}`;
    const root  = cfg.root.replace(/\/$/, '');
    const runPrefix = `${root}/${runId}`;

    const credFile = cfg.cred_file
        ? cfg.cred_file.replace(/^~/, os.homedir())
        : (cfg.cred_env ? process.env[cfg.cred_env] : null);

    const srcCred = credFile ? ['-S', credFile] : [];
    const dstCred = credFile ? ['-E', credFile] : [];

    const uploadSrc = path.join(tmpDir, name, 'upload-src');
    const downloadDir = path.join(tmpDir, name, 'download');
    const syncV1Dir   = path.join(tmpDir, name, 'sync-v1');
    const syncV2Dir   = path.join(tmpDir, name, 'sync-v2');
    const syncDstDir  = path.join(tmpDir, name, 'sync-dl');

    clearDir(uploadSrc);
    fs.mkdirSync(path.join(uploadSrc, 'nested'), {recursive: true});
    fs.writeFileSync(path.join(uploadSrc, 'upload.txt'),           'upload smoke\n');
    fs.writeFileSync(path.join(uploadSrc, 'nested', 'echo.txt'),   'nested upload smoke\n');
    fs.writeFileSync(path.join(uploadSrc, 'binary.bin'),
        Buffer.from(Array.from({length: 256}, (_, i) => i)));

    clearDir(syncV1Dir);
    fs.copyFileSync(path.join(uploadSrc, 'upload.txt'), path.join(syncV1Dir, 'upload.txt'));
    fs.copyFileSync(path.join(uploadSrc, 'binary.bin'), path.join(syncV1Dir, 'binary.bin'));

    clearDir(syncV2Dir);
    fs.copyFileSync(path.join(syncV1Dir, 'upload.txt'), path.join(syncV2Dir, 'upload.txt'));
    fs.copyFileSync(path.join(syncV1Dir, 'binary.bin'), path.join(syncV2Dir, 'binary.bin'));
    fs.writeFileSync(path.join(syncV2Dir, 'sync-added.txt'), 'added in v2\n');

    const uploadUrl  = `${runPrefix}/upload`;
    const syncUrl    = `${runPrefix}/sync`;

    function op(label, fn)
    {
        result.operations.push(label);
        try { fn(); }
        catch(e)
        {
            result.failedAt = label;
            result.durationMs = Date.now() - started;
            throw e;
        }
    }

    try
    {
        console.log(`\n  ${name}`);

        // Phase 1: ls seed
        if (allowedOps.has('ls'))
            op('ls', () => runFmeld([...srcCred, '-s', root + '/', '-r', 'ls']));

        // Phase 2: upload round trip
        if (allowedOps.has('sync'))
        {
            op('upload', () =>
                runFmeld([...dstCred, '-s', `file://${uploadSrc}`, '-d', uploadUrl, '-r', '-U', 'sync']));

            clearDir(downloadDir);
            op('download', () =>
                runFmeld([...srcCred, '-s', uploadUrl, '-d', `file://${downloadDir}`, '-r', 'cp']));

            for (const rel of ['upload.txt', path.join('nested', 'echo.txt'), 'binary.bin'])
            {
                const got = fs.readFileSync(path.join(downloadDir, rel));
                const exp = fs.readFileSync(path.join(uploadSrc, rel));
                if (!got.equals(exp))
                    throw new Error(`${name}: round-trip content mismatch: ${rel}`);
            }
        }

        // Phase 3: cross-backend cp (upload → local file://)
        if (allowedOps.has('cp'))
        {
            const crossDst = path.join(tmpDir, name, 'cross-cp');
            clearDir(crossDst);
            op('cp (binary.bin)', () =>
                runFmeld([...srcCred, '-s', `${uploadUrl}/binary.bin`,
                          '-d', `file://${crossDst}`, '-r', 'cp']));

            const got = fs.readFileSync(path.join(crossDst, 'binary.bin'));
            const exp = fs.readFileSync(path.join(uploadSrc, 'binary.bin'));
            if (!got.equals(exp))
                throw new Error(`${name}: cross-cp binary.bin content mismatch`);
        }

        // Phase 4: unlink
        if (allowedOps.has('unlink'))
        {
            op('unlink', () =>
                runFmeld([...srcCred, '-s', `${uploadUrl}/upload.txt`, '-r', 'unlink']));
        }

        // Phase 5: rm
        if (allowedOps.has('rm'))
        {
            op('rm', () =>
                runFmeld([...srcCred, '-s', uploadUrl, '-r', 'rm']));
        }

        // Phase 6: sync delta
        if (allowedOps.has('sync'))
        {
            op('sync v1', () =>
                runFmeld([...dstCred, '-s', `file://${syncV1Dir}`, '-d', syncUrl, '-r', '-U', 'sync']));
            op('sync v2', () =>
                runFmeld([...dstCred, '-s', `file://${syncV2Dir}`, '-d', syncUrl, '-r', '-U', 'sync']));

            clearDir(syncDstDir);
            op('sync verify', () =>
                runFmeld([...srcCred, '-s', syncUrl, '-d', `file://${syncDstDir}`, '-r', 'cp']));

            for (const rel of ['upload.txt', 'binary.bin'])
                if (!fs.existsSync(path.join(syncDstDir, rel)))
                    throw new Error(`${name}: sync delta missing v1 file: ${rel}`);

            if (!fs.existsSync(path.join(syncDstDir, 'sync-added.txt')))
                throw new Error(`${name}: sync-added.txt missing after sync delta`);
        }

        result.result = 'pass';
        console.log(`    ✅ ${formatDuration(Date.now() - started)}`);
    }
    catch(e)
    {
        result.result = 'fail';
        console.error(`    ✗ ${e.message || e}`);
    }

    // Phase 8: cleanup
    try
    {
        if (allowedOps.has('rm'))
        {
            runFmeld([...srcCred, '-s', runPrefix, '-r', 'rm'], {quiet: true});
            result.cleanupOk = true;
        }
        else
        {
            result.cleanupOk  = false;
            result.leakedPrefix = runPrefix;
            console.warn(`    ⚠ cleanup skipped (rm not in ops) — leaked prefix: ${runPrefix}`);
        }
    }
    catch(e)
    {
        result.cleanupOk    = false;
        result.leakedPrefix = runPrefix;
        console.warn(`    ⚠ cleanup failed — leaked prefix: ${runPrefix}`);
        if (result.result === 'pass') result.result = 'warn';
    }

    result.durationMs = Date.now() - started;
    return result;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main()
{
    const argv = process.argv.slice(2);

    const configIdx = argv.indexOf('--config');
    if (configIdx < 0 || !argv[configIdx + 1])
    {
        console.error('Usage: node run-live-cloud-smoketests.js --config <manifest.yml> [--doctor]');
        process.exit(1);
    }

    const configPath  = path.resolve(argv[configIdx + 1]);
    const doctorMode  = argv.includes('--doctor');

    if (!fs.existsSync(configPath))
    {
        console.error(`Config not found: ${configPath}`);
        process.exit(1);
    }

    let manifest;
    try { manifest = loadYaml(configPath); }
    catch(e) { console.error(`Failed to parse manifest: ${e.message}`); process.exit(1); }

    const errors = validateManifest(manifest, configPath);
    if (errors.length)
    {
        console.error('Manifest errors:');
        for (const e of errors) console.error(`  ✗ ${e}`);
        process.exit(1);
    }

    if (doctorMode)
    {
        doctor(manifest, configPath);
        return;
    }

    // ── smoke run ──────────────────────────────────────────────────────────

    const reportDir = path.resolve(manifest.report_dir || './reports');
    fs.mkdirSync(reportDir, {recursive: true});

    const ts         = nowStamp();
    const reportBase = path.join(reportDir, `live-smoke-${ts}`);
    const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'fmeld-live-smoke-'));

    const started  = Date.now();
    const results  = [];
    const backends = manifest.backends || {};

    console.log(`\nfmeld live smoke tests — ${new Date().toUTCString()}`);
    console.log(`Config: ${configPath}`);
    console.log(`Report: ${reportBase}.md\n`);

    for (const [name, cfg] of Object.entries(backends))
    {
        if (!cfg.enabled)
        {
            results.push({name, result: 'skipped-disabled', durationMs: 0});
            console.log(`  ${name.padEnd(12)} SKIP  (disabled)`);
            continue;
        }

        const credFile = cfg.cred_file
            ? cfg.cred_file.replace(/^~/, os.homedir())
            : null;
        const credEnvVal = cfg.cred_env ? process.env[cfg.cred_env] : null;
        const hasCredentials = (credFile && fs.existsSync(credFile)) ||
                               (credEnvVal && credEnvVal.trim().length > 0);

        if (!hasCredentials)
        {
            results.push({name, result: 'skipped-no-credentials', durationMs: 0});
            console.log(`  ${name.padEnd(12)} SKIP  (no credentials)`);
            continue;
        }

        results.push(smokeBackend(name, cfg, manifest, tmpDir));
    }

    try { fs.rmSync(tmpDir, {recursive: true, force: true}); } catch(e) {}

    const totalDuration = Date.now() - started;
    const anyFail       = results.some(r => r.result === 'fail');
    const overallStatus = anyFail ? 'FAILED' : 'PASSED';

    // ── build markdown report ──────────────────────────────────────────────

    const statusIcon = anyFail ? '❌' : '✅';

    const tableRows = results.map(r =>
    {
        const icon = {
            pass:                    '✅',
            warn:                    '⚠️ ',
            fail:                    '❌',
            'skipped-disabled':      '—',
            'skipped-no-credentials':'—',
            'infra-failure':         '💥'
        }[r.result] || '?';

        const label = {
            pass:                    'Pass',
            warn:                    'Warn (leaked)',
            fail:                    'Fail',
            'skipped-disabled':      'Skipped (disabled)',
            'skipped-no-credentials':'Skipped (no creds)',
            'infra-failure':         'Infra failure'
        }[r.result] || r.result;

        const dur = r.durationMs ? formatDuration(r.durationMs) : '—';
        return `| ${r.name.padEnd(12)} | ${icon} ${label.padEnd(20)} | ${dur.padEnd(8)} |`;
    });

    const leakedPrefixes = results
        .filter(r => r.leakedPrefix)
        .map(r => `- ${r.name}: ${r.leakedPrefix}`);

    const mdLines = [
        `# Live Smoke Test Report`,
        ``,
        `**Status:**   ${statusIcon} ${overallStatus}`,
        `**Date:**     ${new Date().toUTCString()}`,
        `**Duration:** ${formatDuration(totalDuration)}`,
        `**Config:**   ${configPath}`,
        `**Node:**     ${process.version}`,
        `**Platform:** ${process.platform}`,
        ``,
        `## Backend Results`,
        ``,
        `| Backend      | Result                 | Duration |`,
        `|--------------|------------------------|----------|`,
        ...tableRows,
        ``
    ];

    if (leakedPrefixes.length)
    {
        mdLines.push(`## Leaked Prefixes`, ``, ...leakedPrefixes, ``);
        mdLines.push(`These paths were not cleaned up and may incur storage costs.`, ``);
    }

    const failedResults = results.filter(r => r.result === 'fail');
    if (failedResults.length)
    {
        mdLines.push(`## Failures`, ``);
        for (const r of failedResults)
        {
            mdLines.push(`### ${r.name}`);
            mdLines.push(`- **Failed at:** ${r.failedAt || 'unknown'}`);
            mdLines.push(`- **Operations attempted:** ${(r.operations || []).join(', ')}`);
            mdLines.push(``);
        }
    }

    fs.writeFileSync(`${reportBase}.md`, mdLines.join('\n'), 'utf8');

    // ── report.json ────────────────────────────────────────────────────────

    const jsonReport = {
        status:    anyFail ? 'fail' : 'pass',
        date:      new Date().toISOString(),
        duration:  totalDuration,
        config:    configPath,
        platform:  process.platform,
        node:      process.version,
        backends:  results.map(r => ({
            name:         r.name,
            result:       r.result,
            durationMs:   r.durationMs,
            failedAt:     r.failedAt    || null,
            operations:   r.operations  || [],
            cleanupOk:    r.cleanupOk,
            leakedPrefix: r.leakedPrefix || null
        }))
    };
    fs.writeFileSync(`${reportBase}.json`, JSON.stringify(jsonReport, null, 2), 'utf8');

    // ── terminal summary ───────────────────────────────────────────────────

    const bar = '─'.repeat(52);
    console.log(`\n${bar}`);
    console.log(`  Status:   ${statusIcon} ${overallStatus}`);
    console.log(`  Duration: ${formatDuration(totalDuration)}`);
    console.log(`  Report:   ${reportBase}.md`);
    console.log(`            ${reportBase}.json`);
    if (leakedPrefixes.length)
    {
        console.log(`\n  ⚠ Leaked prefixes (manual cleanup required):`);
        for (const lp of leakedPrefixes) console.log(`    ${lp}`);
    }
    console.log(`${bar}\n`);

    process.exit(anyFail ? 1 : 0);
}

main().catch(err =>
{
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
});
