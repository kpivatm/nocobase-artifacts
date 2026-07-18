# nocobase-artifacts

NocoBase blueprint artifacts cho tất cả phân hệ trên instance kpi-poc (`192.168.145.231:13000`).

> **Lưu ý**: NocoBase lưu config trong DB, không phải file. Repo này là nơi lưu **các artifact được export ra** (collection schema, page blueprint, JS block source) để version control và deploy.

## Cấu trúc thư mục

```
modules/
  kpi/
    collections/    # JSON schema collections (legacy format — tham khảo)
    blueprints/     # Page/block blueprints (legacy format — tham khảo)
    js-blocks/      # Source JS block custom
  shared/
    collections/    # Collections dùng chung giữa các phân hệ
packages/plugins/@kpi/plugin-config-migration/
  bin/config-migration.js  # CLI: export / diff / apply / rollback
  src/                     # Plugin source (TypeScript)
scripts/
  export.sh         # [DEPRECATED] Dùng config-migration CLI thay thế
  apply.sh          # [DEPRECATED] Dùng CI pipeline thay thế
  rollback.sh       # Vẫn dùng được (hoặc dùng config-migration rollback)
envs/
  dev.env.example   # Template biến môi trường dev
  staging.env.example
  prod.env.example
docs/
  deploy-pipeline.md  # Deploy runbook (flow mới dùng plugin-config-migration)
.github/workflows/
  validate.yml       # Validate blueprint format trên PR
  deploy-staging.yml # Manual deploy: export from dev → diff review → apply staging
```

## Deploy Runbook

Xem chi tiết: [docs/deploy-pipeline.md](./docs/deploy-pipeline.md)

### Quick start (deploy staging)

1. GitHub Actions → **Deploy to Staging** → **Run workflow**
2. Chọn module (mặc định: `kpi`), bỏ chọn `dry_run`
3. Approve job `apply-staging` sau khi review diff log ở job `export-and-diff`

> **Lưu ý CF-2**: Bundle không được commit vào git. Bundle chỉ tồn tại dưới dạng private CI artifact (1 ngày retention).
>
> **Lưu ý CF-3**: Workflow mới ở target (action `add`) sẽ bị strip credential. Operator phải nhập lại credential trong NocoBase UI sau apply.
>
> **CF-1 (chưa verify)**: Backup-before-apply chưa được chạy thật trên instance có Backup Manager. Cần verify thủ công trước khi enable auto-apply vào prod.

## Branch convention

- `main` — Trạng thái đã apply lên staging (source of truth)
- `feature/ph3-<ISSUE>-<role>-<slug>` — Phát triển tính năng / thay đổi artifact
- `hotfix/<ISSUE>-<slug>` — Fix khẩn cấp prod

## Commit convention

```
feat(kpi): add KPI dashboard blueprint v1
fix(kpi): correct bsc_weight field type in collection
deploy(kpi): apply v1.2 to staging [skip ci]
rollback(kpi): revert to revision pre-deploy-20260712
chore(infra): add deploy-staging GitHub Actions workflow
```
