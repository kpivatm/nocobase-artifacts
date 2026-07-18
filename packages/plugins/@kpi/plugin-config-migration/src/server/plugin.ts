import { Plugin } from '@nocobase/server';
import { exportBundle } from './bundle';
import { diffBundles } from './diff';
import { applyBundle } from './apply';
import { restoreBackup } from './backup';

const PLUGIN_NAME = 'plugin-config-migration';
const PLUGIN_VERSION = '0.3.0';

export class PluginConfigMigrationServer extends Plugin {
  async load() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const plugin = this;

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
        // Response includes backup.filename when backup=true and Backup Manager is available.
        apply: async (ctx, next) => {
          const { source, dryRun, migrationConfig, backup } = ctx.action!.params.values ?? {};
          if (!source) {
            ctx.status = 400;
            ctx.body = { error: 'source bundle is required.' };
            await next();
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const app = backup !== false ? (plugin.app as any) : undefined;
          const result = await applyBundle(ctx.db, source, migrationConfig ?? {}, dryRun ?? false, app);
          ctx.body = result;
          await next();
        },

        // POST /api/plugin-config-migration:rollback
        // Body: { filename: string } — filename from a prior apply response's backup.filename
        rollback: async (ctx, next) => {
          const { filename } = ctx.action!.params.values ?? {};
          if (!filename) {
            ctx.status = 400;
            ctx.body = { error: 'filename is required (from a prior apply backup.filename).' };
            await next();
            return;
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await restoreBackup(plugin.app as any, filename);
          ctx.body = result;
          await next();
        },
      },
    });

    this.app.acl.allow(PLUGIN_NAME, 'status', 'loggedIn');
    this.app.acl.allow(PLUGIN_NAME, 'diff', 'loggedIn');
    // export, apply, rollback — DDL-level operations, admin only
    this.app.acl.registerSnippet({
      name: `pm.${PLUGIN_NAME}`,
      actions: [
        `${PLUGIN_NAME}:export`,
        `${PLUGIN_NAME}:apply`,
        `${PLUGIN_NAME}:rollback`,
      ],
    });
  }
}

export default PluginConfigMigrationServer;
