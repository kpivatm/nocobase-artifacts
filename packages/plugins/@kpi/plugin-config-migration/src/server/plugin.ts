import { Plugin } from '@nocobase/server';
import { exportBundle } from './bundle';
import { diffBundles } from './diff';
import { applyBundle } from './apply';
import { createBackup, restoreFromBundle } from './backup';
import type { Bundle } from './types';

const PLUGIN_NAME = 'plugin-config-migration';
const PLUGIN_VERSION = '0.3.0';

export class PluginConfigMigrationServer extends Plugin {
  async load() {
    this.app.resourceManager.define({
      name: PLUGIN_NAME,
      actions: {
        // GET /api/plugin-config-migration:status
        status: async (ctx, next) => {
          ctx.body = {
            status: 'ok',
            plugin: PLUGIN_NAME,
            version: PLUGIN_VERSION,
          };
          await next();
        },

        // POST /api/plugin-config-migration:export
        export: async (ctx, next) => {
          const bundle = await exportBundle(ctx.db);
          ctx.body = bundle;
          await next();
        },

        // POST /api/plugin-config-migration:backup
        // Returns the current config bundle. Store it to use with rollback if needed.
        // Response: { available: true, filename, createdAt, bundle: Bundle }
        backup: async (ctx, next) => {
          const result = await createBackup(ctx.db);
          ctx.body = result;
          await next();
        },

        // POST /api/plugin-config-migration:diff
        diff: async (ctx, next) => {
          const { source, target } = ctx.action!.params.values ?? {};
          if (!source || !target) {
            ctx.status = 400;
            ctx.body = { error: 'Both source and target bundles are required.' };
            await next();
            return;
          }
          const result = diffBundles(source, target);
          ctx.body = result;
          await next();
        },

        // POST /api/plugin-config-migration:apply
        // Body: { source: Bundle, dryRun?: boolean, migrationConfig?: MigrationConfig, backup?: boolean }
        // Response includes backup.bundle when backup=true (use it with rollback on failure).
        apply: async (ctx, next) => {
          const { source, dryRun, migrationConfig, backup } = ctx.action!.params.values ?? {};
          if (!source) {
            ctx.status = 400;
            ctx.body = { error: 'source bundle is required.' };
            await next();
            return;
          }
          const doBackup = backup !== false;
          const result = await applyBundle(ctx.db, source, migrationConfig ?? {}, dryRun ?? false, doBackup);
          ctx.body = result;
          await next();
        },

        // POST /api/plugin-config-migration:rollback
        // Body: { bundle: Bundle } — the bundle returned by a prior backup or apply response
        // Re-applies the saved bundle to restore the previous config state.
        rollback: async (ctx, next) => {
          const { bundle } = ctx.action!.params.values ?? {};
          if (!bundle) {
            ctx.status = 400;
            ctx.body = { error: 'bundle is required (from a prior backup or apply response backup.bundle).' };
            await next();
            return;
          }
          const result = await restoreFromBundle(ctx.db, bundle as Bundle);
          ctx.body = result;
          await next();
        },
      },
    });

    this.app.acl.allow(PLUGIN_NAME, 'status', 'loggedIn');
    this.app.acl.allow(PLUGIN_NAME, 'diff', 'loggedIn');
    // export, backup, apply, rollback — DDL-level operations, admin only
    this.app.acl.registerSnippet({
      name: `pm.${PLUGIN_NAME}`,
      actions: [
        `${PLUGIN_NAME}:export`,
        `${PLUGIN_NAME}:backup`,
        `${PLUGIN_NAME}:apply`,
        `${PLUGIN_NAME}:rollback`,
      ],
    });
  }
}

export default PluginConfigMigrationServer;
