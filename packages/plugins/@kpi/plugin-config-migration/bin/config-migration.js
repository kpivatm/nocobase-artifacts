#!/usr/bin/env node
/**
 * config-migration CLI — wraps the plugin-config-migration REST API for CI use.
 *
 * Usage:
 *   config-migration export   [--url <base>] [--token <api-token>] [--out <file>]
 *   config-migration diff     [--url <base>] [--token <api-token>] --source <file>
 *   config-migration backup   [--url <base>] [--token <api-token>] [--out <file>] [--print-filename]
 *   config-migration apply    [--url <base>] [--token <api-token>] --source <file> [--dry-run] [--no-backup] [--backup-out <file>] [--config <config-file>]
 *   config-migration rollback [--url <base>] [--token <api-token>] --backup-file <file>
 *
 * Options:
 *   --url         Base URL of the NocoBase instance (default: $NOCOBASE_URL or http://localhost:13000)
 *   --token       API token for authentication (default: $NOCOBASE_API_TOKEN)
 *   --out         Output file for export/backup (default: stdout for export, required for backup in CI)
 *   --source      Path to bundle JSON file (required for diff/apply)
 *   --dry-run     For apply: show what would change without writing
 *   --no-backup   For apply: skip pre-apply config backup
 *   --backup-out  For apply: save the pre-apply backup bundle to this file
 *   --config      Path to migrationConfig JSON file (for apply)
 *   --backup-file For rollback: path to backup bundle file saved by backup or apply --backup-out
 *   --print-filename  For backup: print only the filename to stdout (for CI scripts); exits 1 when unavailable
 *
 * Backup strategy: uses plugin-config-migration:export (no pg_dump / Backup Manager dependency).
 *   backup  → exports current config bundle, saves to --out file
 *   rollback → re-applies a saved bundle to restore previous state
 *
 * All commands output JSON to stdout unless redirected. Exit code 0 = success, non-zero = error.
 */

'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 2;
      } else {
        args[key] = true;
        i++;
      }
    } else {
      args['_command'] = a;
      i++;
    }
  }
  return args;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function request(options, body) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(options.url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { 'Authorization': `Bearer ${options.token}` } : {}),
        ...options.headers,
      },
    };
    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function apiPost(baseUrl, token, action, payload) {
  const apiUrl = `${baseUrl}/api/plugin-config-migration:${action}`;
  const res = await request({ url: apiUrl, method: 'POST', token }, payload);
  if (res.status >= 400) {
    const err = (res.body && res.body.error) ? res.body.error : JSON.stringify(res.body);
    throw new Error(`API error ${res.status}: ${err}`);
  }
  // NocoBase wraps successful responses in {"data": ...}; unwrap so callers get the payload directly.
  const body = res.body;
  return (body && typeof body === 'object' && 'data' in body) ? body.data : body;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdExport(baseUrl, token, outFile) {
  const bundle = await apiPost(baseUrl, token, 'export', {});
  const json = JSON.stringify(bundle, null, 2);
  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), json, 'utf8');
    process.stderr.write(`Bundle exported to ${outFile}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

function readBundle(filePath) {
  const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  // Handle files written by older CLI versions that saved the {"data": ...} wrapper.
  return (raw && typeof raw === 'object' && 'data' in raw && !Array.isArray(raw.data)) ? raw.data : raw;
}

async function cmdDiff(baseUrl, token, sourceFile) {
  if (!sourceFile) throw new Error('--source <file> is required for diff');
  const source = readBundle(sourceFile);
  const target = await apiPost(baseUrl, token, 'export', {});
  const result = await apiPost(baseUrl, token, 'diff', { source, target });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // Non-zero exit when there are diff entries, so CI scripts can gate on it
  if (result.entries && result.entries.length > 0) {
    process.exitCode = 1;
  }
}

async function cmdApply(baseUrl, token, sourceFile, dryRun, noBackup, backupOutFile, configFile) {
  if (!sourceFile) throw new Error('--source <file> is required for apply');
  const source = readBundle(sourceFile);
  let migrationConfig = {};
  if (configFile) {
    migrationConfig = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
  }
  const payload = {
    source,
    dryRun: Boolean(dryRun),
    migrationConfig,
    backup: !noBackup,
  };
  const result = await apiPost(baseUrl, token, 'apply', payload);

  // Save backup bundle if requested
  if (backupOutFile && result.backup && result.backup.bundle) {
    fs.writeFileSync(path.resolve(backupOutFile), JSON.stringify(result.backup.bundle, null, 2), 'utf8');
    process.stderr.write(`Pre-apply backup saved to ${backupOutFile}\n`);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const hasErrors = result.entries && result.entries.some((e) => e.status === 'error');
  if (hasErrors) process.exitCode = 1;
}

async function cmdBackup(baseUrl, token, outFile, printFilename) {
  const result = await apiPost(baseUrl, token, 'backup', {});

  if (printFilename) {
    // For CI scripts: print just the filename on stdout, exit 1 when unavailable or no filename.
    process.stdout.write((result.filename || '') + '\n');
    if (!result.available || !result.filename) {
      process.exitCode = 1;
    }
    return;
  }

  if (outFile && result.bundle) {
    // Save the bundle to a file for later rollback use
    fs.writeFileSync(path.resolve(outFile), JSON.stringify(result.bundle, null, 2), 'utf8');
    process.stderr.write(`Backup bundle saved to ${outFile}\n`);
    // Print summary without the bundle to stdout
    const { bundle: _bundle, ...summary } = result;
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    // Print full result including bundle
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }

  if (!result.available) {
    process.stderr.write('Warning: backup returned available=false\n');
    process.exitCode = 1;
  }
}

async function cmdRollback(baseUrl, token, backupFile) {
  if (!backupFile) throw new Error('--backup-file <path> is required for rollback (bundle JSON saved by backup or apply --backup-out)');
  const bundle = readBundle(backupFile);
  const result = await apiPost(baseUrl, token, 'rollback', { bundle });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.success) process.exitCode = 1;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args['_command'];
  const baseUrl = (args['url'] || process.env.NOCOBASE_URL || 'http://localhost:13000').replace(/\/$/, '');
  const token = args['token'] || process.env.NOCOBASE_API_TOKEN || '';

  if (!command) {
    process.stderr.write('Usage: config-migration <export|diff|backup|apply|rollback> [options]\n');
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'export':
      await cmdExport(baseUrl, token, args['out']);
      break;
    case 'diff':
      await cmdDiff(baseUrl, token, args['source']);
      break;
    case 'backup':
      await cmdBackup(baseUrl, token, args['out'], args['print-filename']);
      break;
    case 'apply':
      await cmdApply(
        baseUrl, token,
        args['source'],
        args['dry-run'],
        args['no-backup'],
        args['backup-out'],
        args['config'],
      );
      break;
    case 'rollback':
      await cmdRollback(baseUrl, token, args['backup-file']);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
});
