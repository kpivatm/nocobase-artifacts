#!/usr/bin/env node
/**
 * config-migration CLI — wraps the plugin-config-migration REST API for CI use.
 *
 * Usage:
 *   config-migration export   [--url <base>] [--token <api-token>] [--out <file>]
 *   config-migration diff     [--url <base>] [--token <api-token>] --source <file>
 *   config-migration apply    [--url <base>] [--token <api-token>] --source <file> [--dry-run] [--no-backup] [--config <config-file>]
 *   config-migration rollback [--url <base>] [--token <api-token>] --backup-file <filename>
 *
 * Options:
 *   --url     Base URL of the NocoBase instance (default: $NOCOBASE_URL or http://localhost:13000)
 *   --token   API token for authentication (default: $NOCOBASE_API_TOKEN)
 *   --out     Output file for export command (default: stdout)
 *   --source  Path to bundle JSON file (required for diff/apply)
 *   --dry-run For apply: show what would change without writing
 *   --no-backup  For apply: skip backup-before-apply
 *   --config  Path to migrationConfig JSON file (for apply)
 *   --backup-file  For rollback: backup filename from a prior apply response
 *
 * All commands output JSON to stdout. Exit code 0 = success, non-zero = error.
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
  return res.body;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdExport(baseUrl, token, outFile) {
  const result = await apiPost(baseUrl, token, 'export', {});
  const json = JSON.stringify(result, null, 2);
  if (outFile) {
    fs.writeFileSync(path.resolve(outFile), json, 'utf8');
    process.stderr.write(`Bundle exported to ${outFile}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

async function cmdDiff(baseUrl, token, sourceFile) {
  if (!sourceFile) throw new Error('--source <file> is required for diff');
  const source = JSON.parse(fs.readFileSync(path.resolve(sourceFile), 'utf8'));
  const target = await apiPost(baseUrl, token, 'export', {});
  const result = await apiPost(baseUrl, token, 'diff', { source, target });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // Non-zero exit when there are diff entries, so CI scripts can gate on it
  if (result.entries && result.entries.length > 0) {
    process.exitCode = 1;
  }
}

async function cmdApply(baseUrl, token, sourceFile, dryRun, noBackup, configFile) {
  if (!sourceFile) throw new Error('--source <file> is required for apply');
  const source = JSON.parse(fs.readFileSync(path.resolve(sourceFile), 'utf8'));
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
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const hasErrors = result.entries && result.entries.some((e) => e.status === 'error');
  if (hasErrors) process.exitCode = 1;
}

async function cmdRollback(baseUrl, token, backupFile) {
  if (!backupFile) throw new Error('--backup-file <filename> is required for rollback');
  const result = await apiPost(baseUrl, token, 'rollback', { filename: backupFile });
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
    process.stderr.write('Usage: config-migration <export|diff|apply|rollback> [options]\n');
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
    case 'apply':
      await cmdApply(baseUrl, token, args['source'], args['dry-run'], args['no-backup'], args['config']);
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
