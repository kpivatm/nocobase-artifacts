import { Plugin, Application } from '@nocobase/client-v2';

export class PluginConfigMigrationClient extends Plugin<any, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-config-migration',
      title: this.t('Config Migration'),
      icon: 'SyncOutlined',
      aclSnippet: 'pm.plugin-config-migration',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-config-migration',
      key: 'index',
      title: this.t('Config Migration'),
      aclSnippet: 'pm.plugin-config-migration',
      componentLoader: () => import('./pages/ConfigMigrationPage'),
    });
  }
}

export default PluginConfigMigrationClient;
