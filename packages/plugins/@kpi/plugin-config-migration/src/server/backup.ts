import * as http from 'http';
import * as https from 'https';
import type { BackupInfo, RollbackResult } from './types';

// Config passed from action handlers to use the Backup Manager API via HTTP loopback.
// Using HTTP loopback instead of app.resourceManager.getAction() because the backup
// plugin (verified on NocoBase 2.1.22: @nocobase/plugin-backups) registers its actions
// through a mechanism not exposed via resourceManager.getAction().
export interface BackupApiConfig {
  baseUrl: string; // e.g. http://192.168.145.231:13000
  token: string;   // Bearer token from the originating request
}

interface ApiResponse {
  status: number;
  body: unknown;
}

function apiRequest(baseUrl: string, token: string, path: string, method: string, payload?: unknown): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(path, baseUrl);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const bodyStr = payload ? JSON.stringify(payload) : undefined;
    const req = lib.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80'),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Create a full backup via the Backup Manager plugin HTTP API (backup:create).
 * Returns { available: false } when the Backup Manager plugin is not installed
 * (i.e. the endpoint returns 404).
 * Throws when the backup API is reachable but fails (e.g. pg_dump not installed,
 * permissions, etc.) — the pre-backup CI step must hard-fail in this case.
 */
export async function createBackup(config: BackupApiConfig): Promise<BackupInfo> {
  let res: ApiResponse;
  try {
    res = await apiRequest(config.baseUrl, config.token, '/api/backup:create', 'POST', {});
  } catch (networkErr: unknown) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    throw new Error(`Backup HTTP loopback failed (network): ${msg}. baseUrl=${config.baseUrl}`);
  }

  if (res.status === 404) {
    return { available: false };
  }

  if (res.status >= 400) {
    const body = res.body as Record<string, unknown>;
    const errMsg = (body?.errors as Array<{ message: string }>)?.[0]?.message
      ?? JSON.stringify(res.body);
    throw new Error(`Backup creation failed (HTTP ${res.status}): ${errMsg}`);
  }

  const body = res.body as Record<string, unknown>;
  const filename = body?.name as string | undefined;
  if (!filename) {
    throw new Error(
      'backup:create returned without a filename. ' +
      'Verify the Backup Manager plugin is functioning on this instance.',
    );
  }

  return {
    available: true,
    filename,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Restore from a previously created backup via the Backup Manager plugin HTTP API.
 */
export async function restoreBackup(config: BackupApiConfig, filename: string): Promise<RollbackResult> {
  const res = await apiRequest(config.baseUrl, config.token, '/api/backup:restore', 'POST', { name: filename });

  if (res.status === 404) {
    return {
      success: false,
      filename,
      restoredAt: new Date().toISOString(),
      error: 'backup:restore endpoint not found — Backup Manager plugin may not be installed',
    };
  }

  if (res.status >= 400) {
    const body = res.body as Record<string, unknown>;
    const errMsg = (body?.errors as Array<{ message: string }>)?.[0]?.message
      ?? JSON.stringify(res.body);
    return {
      success: false,
      filename,
      restoredAt: new Date().toISOString(),
      error: `Restore failed (HTTP ${res.status}): ${errMsg}`,
    };
  }

  return {
    success: true,
    filename,
    restoredAt: new Date().toISOString(),
  };
}
