#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const REPORTS_DIR = path.join(ROOT, 'reports');
const COMPOSE_FILE = path.join('docker', 'live-test', 'docker-compose.yml');
const ALL_BACKENDS = ['ftp', 'webdav', 'sftp', 'smb', 's3', 'azblob'];

// ── helpers ────────────────────────────────────────────────────────────────

function nowStamp() {
    return new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
}

function formatDuration(ms) {
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Reduce a fmeld command line to a short human label
function describeCmd(cmd) {
    const c = cmd.trimEnd();
    if (c.endsWith(' ls'))     return 'ls';
    if (c.endsWith(' rm'))     return 'rm';
    if (c.endsWith(' unlink')) return 'unlink';
    if (c.includes('-s file://')) return c.includes('-U') ? 'sync upload' : 'upload';
    if (c.includes('-d file://')) return 'download';
    if (c.endsWith(' sync'))   return 'sync';
    if (c.endsWith(' cp'))     return 'cross-backend copy';
    return 'run';
}

// ── cleanup ────────────────────────────────────────────────────────────────

async function cleanup() {
    console.log('\nCleaning up smoke test containers, images, and networks...\n');

    const proc = spawn('docker', [
        'compose', '-f', COMPOSE_FILE,
        'down',
        '--volumes',        // remove named volumes
        '--remove-orphans', // remove containers for undefined services
        '--rmi', 'local',   // remove images built by this compose file
    ], { cwd: ROOT, stdio: 'inherit' });

    const exitCode = await new Promise(resolve => proc.on('close', resolve));

    if (exitCode === 0)
        console.log('\nDone.\n');
    else
        console.error(`\nCleanup exited with code ${exitCode}\n`);

    process.exit(exitCode);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    const ts = nowStamp();
    const reportPath = path.join(REPORTS_DIR, `smoketest-${ts}.md`);

    console.log(`\nSmoke tests starting`);
    console.log(`Report: ${reportPath}\n`);

    const startTime = Date.now();
    const allLines    = [];   // every raw line from compose
    const runnerLines = [];   // lines emitted by the runner container

    // Live-progress state
    let phase = 'build';      // build → wait → test → done
    let currentBackend = null;
    let backendStart   = null;
    const backendTimes = {};  // name → ms

    // Heartbeat: prints elapsed time so the terminal never looks frozen.
    // Cleared and replaced by real output once the runner starts reporting.
    let heartbeatLabel = 'Building containers';
    let heartbeatActive = true;
    let heartbeatLineLen = 0;
    const heartbeat = setInterval(() => {
        if (!heartbeatActive) return;
        const elapsed = formatDuration(Date.now() - startTime);
        const msg = `  ${heartbeatLabel}... ${elapsed}`;
        // Pad to the previous line's length so shorter messages fully erase longer ones
        const line = msg.padEnd(heartbeatLineLen);
        heartbeatLineLen = msg.length;
        process.stdout.write(`\r${line}`);
    }, 1000);

    function stopHeartbeat() {
        if (!heartbeatActive) return;
        heartbeatActive = false;
        process.stdout.write('\r' + ' '.repeat(heartbeatLineLen) + '\r');
    }

    function flushBackend(outcome) {
        if (!currentBackend) return;
        const elapsed = Date.now() - backendStart;
        backendTimes[currentBackend] = elapsed;
        const icon = outcome === 'pass' ? '✅' : '❌';
        console.log(`    ${icon} ${formatDuration(elapsed)}`);
        currentBackend = null;
        backendStart   = null;
    }

    function onRunnerLine(content) {
        // Section: waiting for services
        if (content.startsWith('== Waiting')) {
            heartbeatLabel = 'Waiting for services';
            return;
        }

        // Section: seeding — runner is alive, switch to structured output
        if (content.startsWith('== Seeding')) {
            stopHeartbeat();
            if (phase === 'build' || phase === 'wait') { phase = 'seed'; console.log(''); }
            console.log(`  ${content.replace(/^== /, '')}`);
            return;
        }

        // Section: per-backend smoke test starting
        const backendMatch = content.match(/^== Smoke testing (\w+)/);
        if (backendMatch) {
            stopHeartbeat();
            flushBackend('pass');
            if (phase !== 'test') { phase = 'test'; console.log(''); }
            currentBackend = backendMatch[1];
            backendStart   = Date.now();
            console.log(`  ${currentBackend}`);
            return;
        }

        // Sub-sections within a backend test (unlink, rm, sync delta, cross-backend)
        if (/^== (unlink|rm|sync delta|Cross-backend):/.test(content)) {
            console.log(`    ${content.replace(/^== /, '')}`);
            return;
        }

        // All passed
        if (content.includes('All live protocol checks passed')) {
            flushBackend('pass');
            return;
        }

        // fmeld commands — show as indented operation labels
        if (content.startsWith('$ node bin/fmeld.js ')) {
            console.log(`    ${describeCmd(content)}`);
            return;
        }

        // Errors / stack traces
        if (/^(Error|AssertionError|\s+at )/.test(content)) {
            stopHeartbeat();
            console.log(`    ${content}`);
        }
    }

    function handleChunk(chunk) {
        const text = stripAnsi(chunk.toString());
        for (const raw of text.split('\n')) {
            const line = raw.trimEnd();
            if (!line) continue;
            allLines.push(line);

            // Runner container: "runner-1  | <content>"
            const runnerMatch = line.match(/^runner-\d+\s+\|\s?(.*)$/);
            if (runnerMatch) {
                const content = runnerMatch[1];
                runnerLines.push(content);
                onRunnerLine(content);
                continue;
            }

            // Compose-level output (not a service container line)
            const isServiceLine = /^[\w-]+-\d+\s+\|/.test(line);
            if (!isServiceLine) {
                // BuildKit plain-progress step: "#12 [runner 4/6] RUN npm install"
                const buildStep = line.match(/^#\d+ \[(\w+) \d+\/\d+\] (.+)/);
                if (buildStep) {
                    heartbeatLabel = `Building ${buildStep[1]}: ${buildStep[2].trim().slice(0, 50)}`;
                }

                if (/^Attaching to/.test(line)) {
                    // Build phase is done; containers are starting
                    heartbeatLabel = 'Starting services';
                } else if (/dependency failed to start/.test(line)) {
                    stopHeartbeat();
                    const svcMatch = line.match(/container live-test-(\w+)-\d+ is (\w+)/);
                    flushBackend('fail');
                    console.log(`\n  ❌ ${svcMatch ? `Service '${svcMatch[1]}' ${svcMatch[2]}` : line.trim()}`);
                } else if (/error/i.test(line)) {
                    stopHeartbeat();
                    console.log(`  ❌ ${line.trim()}`);
                }
            }
        }
    }

    const proc = spawn('docker', [
        'compose', '--progress', 'plain', '-f', COMPOSE_FILE,
        'up', '--build',
        '--abort-on-container-exit',
        '--exit-code-from', 'runner',
        '--remove-orphans',
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    const exitCode = await new Promise(resolve => proc.on('close', resolve));
    clearInterval(heartbeat);
    stopHeartbeat();

    const duration = Date.now() - startTime;
    const passed   = exitCode === 0;

    if (!passed && currentBackend) flushBackend('fail');

    // ── parse backend outcomes ─────────────────────────────────────────────

    const testedOrder = [];
    let allPassed = false;

    for (const line of runnerLines) {
        const m = line.match(/^== Smoke testing (\w+)/);
        if (m) testedOrder.push(m[1]);
        if (line.includes('All live protocol checks passed')) allPassed = true;
    }

    const results = {};
    if (allPassed) {
        for (const b of testedOrder) results[b] = 'pass';
    } else {
        for (let i = 0; i < testedOrder.length - 1; i++) results[testedOrder[i]] = 'pass';
        if (testedOrder.length > 0) results[testedOrder[testedOrder.length - 1]] = 'fail';
    }

    // ── extract error block ────────────────────────────────────────────────

    const errorLines = [];
    let capturing = false;
    for (const line of runnerLines) {
        if (!capturing && /^(Error|AssertionError)/.test(line)) capturing = true;
        if (capturing) errorLines.push(line);
    }

    // ── build markdown report ──────────────────────────────────────────────

    const statusBadge = passed ? '✅ PASSED' : '❌ FAILED';

    const tableRows = ALL_BACKENDS.map(b => {
        const r       = results[b];
        const icon    = r === 'pass' ? '✅' : r === 'fail' ? '❌' : '—';
        const label   = r === 'pass' ? 'Pass' : r === 'fail' ? 'Fail' : 'Did not run';
        const elapsed = backendTimes[b] ? formatDuration(backendTimes[b]) : '—';
        return `| ${b.padEnd(8)} | ${icon} ${label.padEnd(11)} | ${elapsed.padEnd(8)} |`;
    });

    const runnerBlock = runnerLines.join('\n');
    const fullBlock   = allLines.join('\n');

    const sections = [
        `# Smoke Test Report`,
        ``,
        `**Status:**   ${statusBadge}`,
        `**Date:**     ${new Date().toUTCString()}`,
        `**Duration:** ${formatDuration(duration)}`,
        ``,
        `## Backend Results`,
        ``,
        `| Backend  | Result      | Duration |`,
        `|----------|-------------|----------|`,
        ...tableRows,
        ``,
    ];

    if (errorLines.length) {
        sections.push(`## Errors`, ``, '```', ...errorLines, '```', ``);
    }

    sections.push(
        `## Runner Log`,
        ``,
        '```',
        runnerBlock,
        '```',
        ``,
        `## Full Output`,
        ``,
        `<details>`,
        `<summary>Click to expand</summary>`,
        ``,
        '```',
        fullBlock,
        '```',
        ``,
        `</details>`,
        ``,
    );

    fs.writeFileSync(reportPath, sections.join('\n'), 'utf8');

    // ── terminal summary ───────────────────────────────────────────────────

    const bar = '─'.repeat(48);
    console.log(`\n${bar}`);
    console.log(`  Status:   ${statusBadge}`);
    console.log(`  Duration: ${formatDuration(duration)}`);
    console.log(`  Report:   ${reportPath}`);
    console.log(`${bar}\n`);

    process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.includes('--cleanup'))
    cleanup().catch(err => { console.error(err.stack || err); process.exit(1); });
else
    main().catch(err => { console.error(err.stack || err); process.exit(1); });
