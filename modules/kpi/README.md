# Module: KPI

Artifact cho phân hệ KPI trên NocoBase (`192.168.145.231:13000`).

Lần export cuối: 2026-07-12 từ env `dev`.

## Thứ tự apply lên instance mới

1. `collections/` — Data model (kpi_groups trước, rồi kpi_catalog, rồi các bảng phụ)
2. `blueprints/` — Page blueprints (`apply-blueprint --mode replace`)
3. `js-blocks/` — Tham chiếu để review/diff; block source đã nhúng trong blueprint
4. `workflows/` — Apply từng file `*.enabled.json` kèm nodes chain (script tự động)
5. `acl/` — Roles + permissions với action grants đầy đủ (script tự động)

Script đầy đủ: `bash scripts/apply.sh kpi staging --yes`  
CI: set `NOCOBASE_URL`, `NOCOBASE_EMAIL`, `NOCOBASE_PASSWORD` as secrets; `CI=true` bỏ qua prompt.

## Collections

| File | Title | Phụ thuộc |
|---|---|---|
| `kpi_groups.collection.json` | Nhóm KPI | Không |
| `kpi_catalog.collection.json` | Danh mục KPI | kpi_groups (FK: group) |
| `kpi_change_history.collection.json` | Lịch sử thay đổi KPI | kpi_catalog (hasMany) |
| `kpi_proposals.collection.json` | Đề xuất KPI | kpi_catalog (implicit) |

## Blueprints

| File | Trang | routeId |
|---|---|---|
| `kpi_dmc_page.blueprint.json` | Danh mục KPI | 374933304508416 |

## JS Blocks

| File | Mô tả | Kích thước |
|---|---|---|
| `kpi-catalog.block.js` | KpiViewSwitcher + BSC Quadrant View + Card Grid | ~23KB |

> File này tách ra từ blueprint để review/diff dễ hơn. Không apply riêng — apply qua blueprint.

## Workflows

20 workflows (6 enabled, 14 disabled). Xem `all-workflows.json` để biết danh sách đầy đủ.

**Filename format:** `{kpi-prefix}-{workflow-id}.{enabled|disabled}.json`  
Dùng workflow ID (numeric) để đảm bảo unique — NocoBase dùng chung `key` cho các version của cùng workflow.

Enabled (6):
- `kpi-wf01-*.enabled.json` — Thông báo đề xuất mới cho Quản trị
- `kpi-wf02-*.enabled.json` — Thông báo từ chối đề xuất
- `kpi-wf01b-*374951172243456*.enabled.json` — Thông báo CB Quản lý khi thêm KPI
- `kpi-wf02b-*.enabled.json` — Thông báo CB Quản lý khi sửa KPI
- `kpi-wf-disable-status-*.enabled.json` — Thông báo khi Tắt KPI
- `kpi-wf05-*374958382252032*.enabled.json` — Kiểm tra tổng trọng số BSC = 100%

**Lưu ý:** Một số workflow tồn tại 2 version (cùng prefix, khác ID) — các version cũ `disabled` là dev history, không apply lên fresh instance.

## ACL

4 custom roles: `sysadmin`, `manager`, `leader`, `specialist`.  
Core NocoBase roles (`admin`, `member`, `root`) đã lọc ra khỏi `roles.json`.

**Cấu trúc:**
- `roles.json` — 4 KPI custom roles
- `roles-with-permissions.json` — Full role objects from API
- `role-*-resources.json` — Legacy resource list (reference)
- `resources/role-{role}-{collection}.json` — **Action grants đầy đủ** (dùng bởi apply.sh):
  - `usingActionsConfig: true`
  - `actions`: mảng `{name, fields}` per action

## Dependency

- Core NocoBase >= 2.1
- Plugins: flow-engine, workflow, acl, action-export, action-import, auth
- Không phụ thuộc phân hệ khác (standalone module)
