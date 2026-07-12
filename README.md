# nocobase-artifacts

NocoBase blueprint artifacts cho tất cả phân hệ trên instance kpi-poc (`192.168.145.231:13000`).

> **Lưu ý**: NocoBase lưu config trong DB, không phải file. Repo này là nơi lưu **các artifact được export ra** (collection schema, page blueprint, JS block source) để version control và deploy.

## Cấu trúc thư mục

```
modules/
  kpi/
    collections/    # JSON schema collections (export từ NocoBase)
    blueprints/     # Page/block blueprints (flow-surfaces export-blueprint)
    js-blocks/      # Source JS block custom
  shared/
    collections/    # Collections dùng chung giữa các phân hệ
scripts/
  export.sh         # Export artifact từ NocoBase instance
  apply.sh          # Apply artifact lên target instance
  rollback.sh       # Rollback bằng revision/backup
envs/
  dev.env.example   # Template biến môi trường dev
  staging.env.example
  prod.env.example
.github/workflows/
  validate.yml      # Validate blueprint format trên PR
  deploy-staging.yml # Auto-apply lên staging khi merge main
```

## Deploy Runbook

Xem chi tiết: [deploy-pipeline.md](https://github.com/kpivatm/doc/blob/master/02-platform/deployment/deploy-pipeline.md)

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
