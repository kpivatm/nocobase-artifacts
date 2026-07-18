# Deploy Pipeline — plugin-config-migration

Config deploy từ Dev → Staging sử dụng plugin `plugin-config-migration`.

## Tổng quan flow

```
Dev instance ──export──▶ bundle.json ──diff──▶ review ──apply──▶ Staging
                                                            │
                                                    backup-before-apply
                                                            │
                                              auto-rollback nếu apply fail
```

## Prerequisites

Trước khi chạy pipeline lần đầu:

1. **Plugin đã cài trên cả Dev và Staging** — `plugin-config-migration` phải active trên cả hai instance.
2. **GitHub Secrets** — set vào GitHub theo hai cấp:
   - Repo-level secrets (Settings → Secrets → Actions):
     - `DEV_NOCOBASE_URL` — dev instance base URL
     - `DEV_NOCOBASE_EMAIL` — dev admin email
     - `DEV_NOCOBASE_PASSWORD` — dev admin password
   - Environment secrets (Settings → Environments → staging → Secrets):
     - `STAGING_NOCOBASE_URL` — staging instance base URL (đã set)
     - `STAGING_NOCOBASE_EMAIL` — staging admin email (đã set)
     - `STAGING_NOCOBASE_PASSWORD` — staging admin password (đã set)
3. **GitHub Environment `staging`** — configure required reviewers để tạo approval gate trước khi apply.
4. **CF-1 — Verify backup-before-apply thủ công** (điều kiện tiên quyết trước khi dùng cho prod):
   - Chạy apply một lần với `backup=true` → kiểm tra file backup tồn tại và đầy đủ.
   - Chạy rollback → xác nhận restore đúng trạng thái.
   - Nếu Backup Manager async: refactor poll readiness hoặc disable backup trên pipeline cho đến khi fix.

## Luồng deploy (developer workflow)

### Bước 1 — Export bundle từ Dev (local, tuỳ chọn)

```bash
# Tùy chọn: preview bundle và diff locally trước khi trigger CI
export NOCOBASE_URL=http://dev-instance:13000
export NOCOBASE_API_TOKEN=<dev-api-token>
node packages/plugins/@kpi/plugin-config-migration/bin/config-migration.js export --out bundle.json

# Diff bundle vừa export với staging
export NOCOBASE_URL=http://staging-instance:13000
export NOCOBASE_API_TOKEN=<staging-api-token>
node packages/plugins/@kpi/plugin-config-migration/bin/config-migration.js diff --source bundle.json
```

**Lưu ý CF-2**: Bundle có thể chứa dữ liệu nhạy cảm:
- **KHÔNG commit bundle.json vào git** (đã gitignore trong `.gitignore`).
- Treat bundle như secret. Trong CI, bundle chỉ tồn tại dưới dạng private artifact (1 ngày).
- Redaction trong export chỉ bắt known field names — credential trong field lạ không bị redact.

### Bước 2 — Trigger CI pipeline

1. Vào GitHub Actions → **Deploy to Staging** → **Run workflow**.
2. Điền module (mặc định: `kpi`).
3. Bỏ chọn `dry_run` nếu muốn apply thật (hoặc chọn `dry_run` để chỉ xem diff log).
4. Bấm **Run workflow**.

### Bước 3 — Review diff (Job 1: export-and-diff)

Job 1 tự động:
- Export bundle từ Dev.
- Upload bundle dưới dạng private artifact (1 ngày retention).
- Chạy `diff` so với Staging và in ra diff log.

**Reviewer xem diff log trong Job 1** trước khi approve Job 2.

### Bước 4 — Approve và apply (Job 2: apply-staging)

Job 2 (`apply-staging`) chờ approval từ reviewer được cấu hình trong GitHub Environment `staging`.

Sau khi approved:
- Apply bundle lên Staging với **backup-before-apply** tự động.
- Nếu apply fail → **auto-rollback** về backup vừa tạo.
- Apply result được in ra log (số entries applied/skipped/error).

### Bước 5 — Sau khi apply thành công

1. **Verify** trên Staging: `$STAGING_NOCOBASE_URL/admin`.
2. **Workflows mới (CF-3)**: Nếu có workflow mới được add vào Staging (action `add`), credential trong config của workflow nguồn bị strip khi apply. Operator phải vào NocoBase UI → Workflow → nhập lại credential cho môi trường staging.
3. **Enable workflows thủ công** sau khi verify (apply luôn import workflow ở trạng thái disabled).

## Rollback thủ công

Nếu cần rollback sau khi job đã hoàn thành:

```bash
# Backup filename lấy từ apply result log (trường backup.filename)
export NOCOBASE_URL=http://staging-instance:13000
export NOCOBASE_API_TOKEN=<staging-api-token>
node packages/plugins/@kpi/plugin-config-migration/bin/config-migration.js \
  rollback --backup-file "<backup-filename-from-apply-log>"
```

Hoặc dùng script legacy (vẫn hoạt động):
```bash
./scripts/rollback.sh <revision-id>
```

## Dry run

Để xem diff mà không apply:

```bash
# Local
node .../config-migration.js apply --source bundle.json --dry-run

# CI: tick ô "Dry run" khi trigger workflow_dispatch
```

## Scripts cũ (deprecated)

| Script | Trạng thái | Thay thế |
|--------|-----------|----------|
| `scripts/export.sh` | Deprecated | `config-migration.js export` |
| `scripts/apply.sh` | Deprecated | CI pipeline + `config-migration.js apply` |
| `scripts/rollback.sh` | Vẫn dùng được | `config-migration.js rollback` |

Xem chi tiết: [Retire old scripts](#).
