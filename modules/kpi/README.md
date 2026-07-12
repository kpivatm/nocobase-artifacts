# Module: KPI

Artifact cho phân hệ KPI trên NocoBase (`192.168.145.231:13000`).

Lần export cuối: 2026-07-12 từ env `dev`.

## Thứ tự apply lên instance mới

1. `collections/` — Data model (kpi_groups trước, rồi kpi_catalog, rồi các bảng phụ)
2. `blueprints/` — Page blueprints (`apply-blueprint --mode replace`)
3. `js-blocks/` — Tham chiếu để review/diff; block source đã nhúng trong blueprint
4. `workflows/` — Apply từng file `*.enabled.json` (disable theo mặc định, enable sau khi verify)
5. `acl/` — Cấu hình roles và permissions thủ công qua NocoBase UI

Script đầy đủ: `bash scripts/apply.sh kpi dev`

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
| `kpi-catalog.block.js` | KpiViewSwitcher + BSC Quadrant View + Card Grid (KPI-26/27) | ~23KB |

> File này tách ra từ blueprint để review/diff dễ hơn. Không apply riêng — apply qua blueprint.

## Workflows

20 workflows (6 enabled, 14 disabled). Xem `all-workflows.json` để biết danh sách đầy đủ.

Enabled:
- KPI-WF01: Thông báo đề xuất mới cho Quản trị
- KPI-WF02: Thông báo từ chối đề xuất
- KPI-WF01b: Thông báo CB Quản lý khi thêm KPI
- KPI-WF02b: Thông báo CB Quản lý khi sửa KPI
- KPI-WF-DISABLE-STATUS: Thông báo khi Tắt KPI
- KPI-WF05: Kiểm tra tổng trọng số BSC = 100%

## ACL

4 custom roles: `sysadmin`, `manager`, `leader`, `specialist`.
Xem `role-*-resources.json` để biết permissions chi tiết.

## Dependency

- Core NocoBase >= 2.1
- Plugins: flow-engine, workflow, acl, action-export, action-import, auth
- Không phụ thuộc phân hệ khác (standalone module)
