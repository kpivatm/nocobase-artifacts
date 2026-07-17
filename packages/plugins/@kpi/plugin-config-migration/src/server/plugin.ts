import { Plugin } from '@nocobase/server';
import { exportBundle } from './bundle';
import { diffBundles } from './diff';
import { applyBundle } from './apply';

const PLUGIN_NAME = 'plugin-config-migration';
const PLUGIN_VERSION = '0.1.0';

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

        // POST /api/plugin-config-migration:diff
        diff: async (ctx, next) => {
          const { source, target } = ctx.action.params.values ?? {};
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
        apply: async (ctx, next) => {
          const { source, dryRun, migrationConfig } = ctx.action.params.values ?? {};
          if (!source) {
            ctx.status = 400;
            ctx.body = { error: 'source bundle is required.' };
            await next();
            return;
          }
          const result = await applyBundle(ctx.db, source, migrationConfig ?? {}, dryRun ?? false);
          ctx.body = result;
          await next();
        },
      },
    });

    this.app.acl.allow(PLUGIN_NAME, 'status', 'loggedIn');
    this.app.acl.allow(PLUGIN_NAME, 'diff', 'loggedIn');
    // export dumps full schema; apply performs DDL-level writes — both are admin-only
    this.app.acl.allow(PLUGIN_NAME, 'export', 'admin');
    this.app.acl.allow(PLUGIN_NAME, 'apply', 'admin');
  }
}

export default PluginConfigMigrationServer;
