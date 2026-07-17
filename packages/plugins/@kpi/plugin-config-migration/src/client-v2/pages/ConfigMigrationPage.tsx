import React, { useState, useCallback } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InboxOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useFlowContext } from '@nocobase/flow-engine';
import { useT } from '../locale';

const { Title, Text } = Typography;
const { Dragger } = Upload;

// ─── Types (mirrored from server/types.ts) ────────────────────────────────────

type MigrationRule = 'insert' | 'insert-or-update' | 'skip';
type DiffEntryType =
  | 'collection'
  | 'field'
  | 'workflow'
  | 'flow_node'
  | 'role'
  | 'roles_resource'
  | 'ui_schema'
  | 'desktop_route';

interface DiffEntry {
  action: 'add' | 'update' | 'delete';
  type: DiffEntryType;
  key: string;
  source?: unknown;
  target?: unknown;
  warnings?: string[];
}

interface DiffResult {
  entries: DiffEntry[];
}

interface ApplyResultEntry {
  key: string;
  action: string;
  status: 'ok' | 'skipped' | 'error';
  error?: string;
  warning?: string;
}

interface ApplyResult {
  applied: number;
  skipped: number;
  dryRun: boolean;
  entries: ApplyResultEntry[];
  backup?: { filename: string };
}

interface Bundle {
  version: string;
  exportedAt: string;
  [key: string]: unknown;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DOMAIN_LABELS: Record<DiffEntryType, string> = {
  collection: 'Collections',
  field: 'Fields',
  workflow: 'Workflows',
  flow_node: 'Flow Nodes',
  role: 'Roles',
  roles_resource: 'Role Resources',
  ui_schema: 'UI Schemas',
  desktop_route: 'Routes',
};

const DOMAIN_ORDER: DiffEntryType[] = [
  'collection',
  'field',
  'workflow',
  'flow_node',
  'role',
  'roles_resource',
  'ui_schema',
  'desktop_route',
];

const RULE_OPTIONS = [
  { value: 'insert-or-update', label: 'Insert or Update' },
  { value: 'insert', label: 'Insert Only' },
  { value: 'skip', label: 'Skip' },
];

// ─── Action badge ─────────────────────────────────────────────────────────────

function ActionTag({ action }: { action: string }) {
  if (action === 'add') return <Tag color="green">+ add</Tag>;
  if (action === 'update') return <Tag color="blue">~ update</Tag>;
  if (action === 'delete') return <Tag color="red">- delete</Tag>;
  return <Tag>{action}</Tag>;
}

// ─── Status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: string }) {
  if (status === 'ok') return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
  if (status === 'skipped') return <ExclamationCircleOutlined style={{ color: '#faad14' }} />;
  return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
}

// ─── Diff Table for a single domain ──────────────────────────────────────────

function DiffDomainTable({
  entries,
  rules,
  onRuleChange,
}: {
  entries: DiffEntry[];
  rules: Record<string, MigrationRule>;
  onRuleChange: (key: string, rule: MigrationRule) => void;
}) {
  const columns = [
    {
      title: 'Action',
      dataIndex: 'action',
      width: 90,
      render: (action: string) => <ActionTag action={action} />,
    },
    {
      title: 'Key',
      dataIndex: 'key',
      render: (key: string, record: DiffEntry) => (
        <Space direction="vertical" size={0}>
          <Text code>{key}</Text>
          {record.warnings?.map((w, i) => (
            <Text key={i} type="warning" style={{ fontSize: 12 }}>
              <WarningOutlined /> {w}
            </Text>
          ))}
        </Space>
      ),
    },
    {
      title: 'Rule',
      width: 180,
      render: (_: unknown, record: DiffEntry) => (
        <Select
          size="small"
          style={{ width: 160 }}
          value={rules[record.key] ?? 'default'}
          options={[
            { value: 'default', label: '(use default)' },
            ...RULE_OPTIONS,
          ]}
          onChange={(val: string) => {
            if (val === 'default') {
              const next = { ...rules };
              delete next[record.key];
              onRuleChange(record.key, undefined as unknown as MigrationRule);
            } else {
              onRuleChange(record.key, val as MigrationRule);
            }
          }}
        />
      ),
    },
  ];

  return (
    <Table
      size="small"
      columns={columns}
      dataSource={entries}
      rowKey="key"
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
    />
  );
}

// ─── Apply Results Table ──────────────────────────────────────────────────────

function ApplyResultsTable({ result }: { result: ApplyResult }) {
  const columns = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 80,
      render: (status: string) => <StatusIcon status={status} />,
    },
    {
      title: 'Key',
      dataIndex: 'key',
      render: (key: string) => <Text code>{key}</Text>,
    },
    {
      title: 'Action',
      dataIndex: 'action',
      width: 90,
      render: (action: string) => <ActionTag action={action} />,
    },
    {
      title: 'Detail',
      render: (_: unknown, record: ApplyResultEntry) => {
        if (record.error) return <Text type="danger">{record.error}</Text>;
        if (record.warning) return <Text type="warning">{record.warning}</Text>;
        return null;
      },
    },
  ];

  return (
    <Table
      size="small"
      columns={columns}
      dataSource={result.entries}
      rowKey="key"
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
    />
  );
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export default function ConfigMigrationPage() {
  const ctx = useFlowContext();
  const t = useT();

  const [uploadedBundle, setUploadedBundle] = useState<Bundle | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [diffLoading, setDiffLoading] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const [defaultRule, setDefaultRule] = useState<MigrationRule>('insert-or-update');
  const [entryRules, setEntryRules] = useState<Record<string, MigrationRule>>({});

  const [applyLoading, setApplyLoading] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [backupFilename, setBackupFilename] = useState<string | null>(null);

  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<unknown>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

  // ── Upload handler ──────────────────────────────────────────────────────────

  const handleFileRead = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const parsed = JSON.parse(text) as Bundle;
        if (!parsed.version || !parsed.exportedAt) {
          throw new Error('Invalid bundle format: missing version or exportedAt');
        }
        setUploadedBundle(parsed);
        setUploadError(null);
        setDiffResult(null);
        setApplyResult(null);
        setBackupFilename(null);
        setRollbackResult(null);
        setEntryRules({});
      } catch (err: unknown) {
        setUploadError((err as Error).message ?? 'Invalid JSON');
        setUploadedBundle(null);
      }
    };
    reader.readAsText(file);
    return false;
  }, []);

  // ── Diff handler ────────────────────────────────────────────────────────────

  const handlePreviewDiff = useCallback(async () => {
    if (!uploadedBundle) return;
    setDiffLoading(true);
    setDiffError(null);
    setDiffResult(null);
    try {
      // First export current state as target
      const exportResp = await ctx.api.request({
        url: 'plugin-config-migration:export',
        method: 'post',
      });
      const currentBundle = exportResp?.data?.data ?? exportResp?.data;

      // Then diff uploaded (source) vs current (target)
      const diffResp = await ctx.api.request({
        url: 'plugin-config-migration:diff',
        method: 'post',
        data: { source: uploadedBundle, target: currentBundle },
      });
      const result: DiffResult = diffResp?.data?.data ?? diffResp?.data;
      setDiffResult(result);
    } catch (err: unknown) {
      setDiffError((err as Error).message ?? 'Diff failed');
    } finally {
      setDiffLoading(false);
    }
  }, [ctx.api, uploadedBundle]);

  // ── Apply handler ───────────────────────────────────────────────────────────

  const handleApply = useCallback(
    async (dryRun: boolean) => {
      if (!uploadedBundle) return;
      Modal.confirm({
        title: dryRun ? t('Dry Run') : t('Apply Changes'),
        icon: <ExclamationCircleOutlined />,
        content: dryRun
          ? t('Run a simulation — no changes will be written to the database.')
          : t('This will apply changes to the database. This action cannot be automatically undone. Continue?'),
        okText: dryRun ? t('Run Dry Run') : t('Apply'),
        okType: dryRun ? 'default' : 'danger',
        cancelText: t('Cancel'),
        onOk: async () => {
          setApplyLoading(true);
          setApplyError(null);
          setApplyResult(null);
          try {
            const migrationConfig = {
              defaultRule,
              rules: Object.keys(entryRules).length > 0 ? entryRules : undefined,
            };
            const resp = await ctx.api.request({
              url: 'plugin-config-migration:apply',
              method: 'post',
              data: { source: uploadedBundle, dryRun, migrationConfig },
            });
            const result: ApplyResult = resp?.data?.data ?? resp?.data;
            setApplyResult(result);
            if (!dryRun && result.backup?.filename) {
              setBackupFilename(result.backup.filename);
            }
            if (dryRun) {
              message.info(t('Dry run complete: {{applied}} would be applied, {{skipped}} would be skipped', {
                applied: result.applied,
                skipped: result.skipped,
              }));
            } else {
              message.success(t('Apply complete: {{applied}} applied, {{skipped}} skipped', {
                applied: result.applied,
                skipped: result.skipped,
              }));
            }
          } catch (err: unknown) {
            const msg = (err as Error).message ?? 'Apply failed';
            setApplyError(msg);
            message.error(msg);
          } finally {
            setApplyLoading(false);
          }
        },
      });
    },
    [ctx.api, uploadedBundle, defaultRule, entryRules, t],
  );

  // ── Rollback handler ────────────────────────────────────────────────────────

  const handleRollback = useCallback(async () => {
    Modal.confirm({
      title: t('Rollback'),
      icon: <ExclamationCircleOutlined />,
      content: t('This will restore the database to the state before the last apply. Continue?'),
      okText: t('Rollback'),
      okType: 'danger',
      cancelText: t('Cancel'),
      onOk: async () => {
        setRollbackLoading(true);
        setRollbackError(null);
        setRollbackResult(null);
        try {
          const resp = await ctx.api.request({
            url: 'plugin-config-migration:rollback',
            method: 'post',
            data: { filename: backupFilename },
          });
          const result = resp?.data?.data ?? resp?.data;
          setRollbackResult(result);
          setBackupFilename(null);
          message.success(t('Rollback complete'));
        } catch (err: unknown) {
          const msg = (err as Error).message ?? 'Rollback failed';
          setRollbackError(msg);
          message.error(msg);
        } finally {
          setRollbackLoading(false);
        }
      },
    });
  }, [ctx.api, backupFilename, t]);

  // ── Diff tab items ──────────────────────────────────────────────────────────

  const handleEntryRuleChange = useCallback((key: string, rule: MigrationRule | undefined) => {
    setEntryRules((prev) => {
      const next = { ...prev };
      if (rule === undefined) {
        delete next[key];
      } else {
        next[key] = rule;
      }
      return next;
    });
  }, []);

  const diffByDomain: Partial<Record<DiffEntryType, DiffEntry[]>> = {};
  if (diffResult) {
    for (const entry of diffResult.entries) {
      if (!diffByDomain[entry.type]) diffByDomain[entry.type] = [];
      diffByDomain[entry.type]!.push(entry);
    }
  }

  const tabItems = DOMAIN_ORDER.filter((d) => diffByDomain[d]?.length).map((domain) => {
    const entries = diffByDomain[domain]!;
    const addCount = entries.filter((e) => e.action === 'add').length;
    const updateCount = entries.filter((e) => e.action === 'update').length;
    const deleteCount = entries.filter((e) => e.action === 'delete').length;

    return {
      key: domain,
      label: (
        <Space size={4}>
          {DOMAIN_LABELS[domain]}
          {addCount > 0 && <Badge count={addCount} style={{ backgroundColor: '#52c41a' }} />}
          {updateCount > 0 && <Badge count={updateCount} />}
          {deleteCount > 0 && <Badge count={deleteCount} style={{ backgroundColor: '#ff4d4f' }} />}
        </Space>
      ),
      children: (
        <DiffDomainTable
          entries={entries}
          rules={entryRules}
          onRuleChange={handleEntryRuleChange}
        />
      ),
    };
  });

  const totalChanges = diffResult?.entries.length ?? 0;

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <Title level={4} style={{ marginBottom: 24 }}>
        {t('Config Migration')}
      </Title>

      {/* ── Step 1: Upload ── */}
      <Card title={t('Step 1 — Upload Bundle')} style={{ marginBottom: 16 }}>
        <Dragger
          accept=".json"
          showUploadList={false}
          beforeUpload={(file) => {
            handleFileRead(file);
            return false;
          }}
          style={{ marginBottom: uploadedBundle ? 12 : 0 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('Click or drag a bundle JSON file here')}</p>
          <p className="ant-upload-hint">{t('The bundle was previously exported from another NocoBase instance')}</p>
        </Dragger>

        {uploadError && (
          <Alert type="error" message={uploadError} style={{ marginTop: 12 }} showIcon />
        )}

        {uploadedBundle && (
          <Alert
            type="success"
            showIcon
            style={{ marginTop: 12 }}
            message={
              <Space>
                <Text strong>{t('Bundle loaded')}</Text>
                <Text type="secondary">v{uploadedBundle.version}</Text>
                <Text type="secondary">{t('exported at')} {uploadedBundle.exportedAt}</Text>
              </Space>
            }
          />
        )}
      </Card>

      {/* ── Step 2: Diff Preview ── */}
      {uploadedBundle && (
        <Card
          title={t('Step 2 — Preview Diff')}
          style={{ marginBottom: 16 }}
          extra={
            <Button
              type="primary"
              icon={<SyncOutlined />}
              loading={diffLoading}
              onClick={handlePreviewDiff}
            >
              {t('Preview Diff')}
            </Button>
          }
        >
          {diffLoading && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin tip={t('Computing diff…')} />
            </div>
          )}

          {diffError && (
            <Alert type="error" message={diffError} showIcon />
          )}

          {diffResult && !diffLoading && (
            <>
              {totalChanges === 0 ? (
                <Alert
                  type="success"
                  showIcon
                  message={t('No differences found — the target is already in sync with this bundle.')}
                />
              ) : (
                <>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message={t('{{total}} changes detected. Review below and adjust per-entry rules before applying.', {
                      total: totalChanges,
                    })}
                  />
                  <Tabs items={tabItems} />
                </>
              )}
            </>
          )}
        </Card>
      )}

      {/* ── Step 3: Apply / Rollback ── */}
      {diffResult && (
        <Card title={t('Step 3 — Apply or Rollback')} style={{ marginBottom: 16 }}>
          <Row gutter={[16, 16]} align="middle">
            <Col flex="none">
              <Text>{t('Default rule')}:</Text>
            </Col>
            <Col flex="200px">
              <Select
                style={{ width: '100%' }}
                value={defaultRule}
                options={RULE_OPTIONS}
                onChange={(v: MigrationRule) => setDefaultRule(v)}
              />
            </Col>
            <Col flex="none">
              <Space>
                <Button
                  loading={applyLoading}
                  onClick={() => handleApply(true)}
                  disabled={totalChanges === 0}
                >
                  {t('Dry Run')}
                </Button>
                <Button
                  type="primary"
                  danger
                  loading={applyLoading}
                  onClick={() => handleApply(false)}
                  disabled={totalChanges === 0}
                >
                  {t('Apply')}
                </Button>
                <Divider type="vertical" />
                <Button
                  danger
                  loading={rollbackLoading}
                  onClick={handleRollback}
                  icon={<SyncOutlined />}
                  disabled={!backupFilename}
                  title={backupFilename ? undefined : t('Apply a bundle first to create a rollback backup')}
                >
                  {t('Rollback')}
                </Button>
              </Space>
            </Col>
          </Row>

          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 16 }}
            message={t('Apply writes changes to the database inside a transaction. On error the full transaction is rolled back. Rollback requires a backup created by the backend before the last apply.')}
          />
        </Card>
      )}

      {/* ── Apply Results ── */}
      {applyError && (
        <Alert type="error" message={applyError} showIcon style={{ marginBottom: 16 }} />
      )}

      {applyResult && (
        <Card
          title={
            <Space>
              {applyResult.dryRun
                ? t('Dry Run Results')
                : t('Apply Results')}
              <Tag color="green">{applyResult.applied} {t('applied')}</Tag>
              <Tag color="orange">{applyResult.skipped} {t('skipped')}</Tag>
              {applyResult.dryRun && <Tag color="blue">{t('DRY RUN — no changes written')}</Tag>}
            </Space>
          }
          style={{ marginBottom: 16 }}
        >
          {backupFilename && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                <Space>
                  <Text>{t('Backup created before apply:')}</Text>
                  <Text code>{backupFilename}</Text>
                  <Text type="secondary">{t('Use Rollback to restore if needed.')}</Text>
                </Space>
              }
            />
          )}
          <ApplyResultsTable result={applyResult} />
        </Card>
      )}

      {/* ── Rollback Results ── */}
      {rollbackError && (
        <Alert type="error" message={rollbackError} showIcon style={{ marginBottom: 16 }} />
      )}

      {rollbackResult && (
        <Alert
          type="success"
          showIcon
          message={t('Rollback complete')}
          style={{ marginBottom: 16 }}
        />
      )}
    </div>
  );
}
