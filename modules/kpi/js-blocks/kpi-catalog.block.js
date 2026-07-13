// KPI-26 / KPI-27 — KpiViewSwitcher + BSC Quadrant View + Card Grid View (KPI Catalog)
// Self-contained JS block. Owns the 3-way view switcher (Bảng / BSC / Cards),
// renders the BSC Quadrant view, the Card Grid view (KPI-27) and its own detail
// drawer, and shows/hides the native table block (kpi_dmc_table) for "Bảng".
// KPI-31: BSC dimensions are fetched from the `bsc_dimensions` collection; this
// array is the graceful-degradation fallback when the collection is empty.
try {
  const VIEW_KEY = 'kpi_catalog_view';
  const NATIVE_TABLE_UID = 'kpi_dmc_table';
  const ACTIVE = 'Đang hoạt động';
  const CARD_PAGE = 12; // Card view: "Load more" batch size.

  var DIMS_FALLBACK = [
    { value: 'Tài chính',        label: 'Tài chính',            color: '#1890ff', icon: '💰', code: 'finance',  order: 1 },
    { value: 'Khách hàng',       label: 'Khách hàng',           color: '#52c41a', icon: '🤝', code: 'customer', order: 2 },
    { value: 'Quy trình nội bộ', label: 'Quy trình nội bộ',     color: '#fa8c16', icon: '⚙️', code: 'process',  order: 3 },
    { value: 'Học tập & PT',     label: 'Học tập & Phát triển', color: '#722ed1', icon: '📚', code: 'learning', order: 4 },
  ];

  // Starts with fallback; replaced by DB data after loadDims() resolves.
  var DIMS = DIMS_FALLBACK.slice();

  const host = (ctx.element && (ctx.element.__el || ctx.element)) || null;

  // The RunJS sandbox forbids sessionStorage/localStorage, so persist the chosen
  // view on the cached block model instance (kept by the FlowEngine across
  // in-app navigation). Falls back to the 'bsc' default on a full remount.
  function readView() {
    try { return ctx.model ? ctx.model[VIEW_KEY] : null; } catch (e) { return null; }
  }
  function saveView(v) {
    try { if (ctx.model) ctx.model[VIEW_KEY] = v; } catch (e) {}
  }

  const state = {
    view: readView() || 'bsc',
    search: '',
    status: 'all',
    dims: DIMS.map(function (d) { return d.value; }),
    detail: null,
    loading: true,
    error: null,
    rows: [],
    cardLimit: CARD_PAGE,
  };
  if (['table', 'bsc', 'card'].indexOf(state.view) === -1) state.view = 'bsc';

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isActive(r) { return String(r.status || '').trim() === ACTIVE; }
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

  function styleTag() {
    return (
      '<style>' +
      '.kpi26 * { box-sizing: border-box; }' +
      '.kpi26 { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#1a1a1a; }' +
      '.kpi26-toolbar { background:#fff; border-radius:8px; padding:12px 16px; display:flex; align-items:center; gap:12px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.08); flex-wrap:wrap; }' +
      '.kpi26-tl { display:flex; align-items:center; gap:8px; flex:1; flex-wrap:wrap; }' +
      '.kpi26-tr { display:flex; align-items:center; gap:8px; }' +
      '.kpi26-search { border:1px solid #d9d9d9; border-radius:6px; padding:6px 12px; font-size:13px; width:230px; outline:none; color:#333; }' +
      '.kpi26-sel { border:1px solid #d9d9d9; border-radius:6px; padding:6px 10px; font-size:13px; background:#fff; color:#333; outline:none; }' +
      '.kpi26-switch { display:flex; border:1px solid #d9d9d9; border-radius:6px; overflow:hidden; }' +
      '.kpi26-vbtn { padding:6px 14px; font-size:12px; cursor:pointer; background:#fff; border:none; border-right:1px solid #d9d9d9; color:#555; display:flex; align-items:center; gap:5px; transition:all .15s; }' +
      '.kpi26-vbtn:last-child { border-right:none; }' +
      '.kpi26-vbtn.active { background:#1890ff; color:#fff; }' +
      '.kpi26-vbtn:hover:not(.active) { background:#f5f5f5; }' +
      '.kpi26-legend { display:flex; gap:14px; margin-bottom:12px; flex-wrap:wrap; align-items:center; }' +
      '.kpi26-lg { display:flex; align-items:center; gap:6px; font-size:12px; color:#555; cursor:pointer; user-select:none; padding:2px 6px; border-radius:6px; }' +
      '.kpi26-lg.off { opacity:.35; }' +
      '.kpi26-lg:hover { background:#f5f5f5; }' +
      '.kpi26-dot { width:10px; height:10px; border-radius:50%; }' +
      '.kpi26-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }' +
      '@media(max-width:900px){ .kpi26-grid{ grid-template-columns:1fr; } }' +
      '.kpi26-quad { background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.08); overflow:hidden; border-top:4px solid #ccc; }' +
      '.kpi26-qh { padding:12px 16px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #f0f0f0; }' +
      '.kpi26-qt { font-weight:600; font-size:14px; display:flex; align-items:center; gap:8px; }' +
      '.kpi26-qicon { font-size:18px; }' +
      '.kpi26-wt { font-size:12px; padding:2px 8px; border-radius:10px; font-weight:600; }' +
      '.kpi26-wok { background:#f6ffed; color:#52c41a; }' +
      '.kpi26-wwarn { background:#fff1f0; color:#ff4d4f; animation:kpi26pulse 1.5s infinite; }' +
      '@keyframes kpi26pulse { 0%,100%{opacity:1} 50%{opacity:.55} }' +
      '.kpi26-qb { padding:6px 0; max-height:280px; overflow-y:auto; }' +
      '.kpi26-row { padding:8px 16px; display:flex; align-items:center; gap:10px; border-bottom:1px solid #fafafa; cursor:pointer; transition:background .1s; }' +
      '.kpi26-row:last-child { border-bottom:none; }' +
      '.kpi26-row:hover { background:#f5f5f5; }' +
      '.kpi26-row.paused { opacity:.65; }' +
      '.kpi26-code { font-size:11px; font-weight:700; font-family:monospace; color:#1890ff; min-width:62px; }' +
      '.kpi26-name { font-size:13px; flex:1; line-height:1.3; }' +
      '.kpi26-right { display:flex; align-items:center; gap:8px; flex-shrink:0; }' +
      '.kpi26-mp { width:60px; height:5px; background:#f0f0f0; border-radius:3px; overflow:hidden; }' +
      '.kpi26-mpb { height:100%; border-radius:3px; }' +
      '.kpi26-pct { font-size:11px; color:#888; min-width:30px; text-align:right; }' +
      '.kpi26-st { font-size:10px; padding:1px 6px; border-radius:10px; }' +
      '.kpi26-st-a { background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; }' +
      '.kpi26-st-p { background:#f5f5f5; color:#999; border:1px solid #e0e0e0; }' +
      '.kpi26-qf { padding:8px 16px; border-top:1px solid #f0f0f0; font-size:11px; color:#888; display:flex; justify-content:space-between; align-items:center; }' +
      '.kpi26-viewall { color:#1890ff; cursor:pointer; }' +
      '.kpi26-empty { padding:20px 16px; font-size:12px; color:#bbb; text-align:center; }' +
      '.kpi26-ph { background:#fff; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,0.08); padding:60px 20px; text-align:center; color:#999; }' +
      '.kpi26-ph .big { font-size:34px; margin-bottom:12px; }' +
      // card grid view (KPI-27)
      '.kpi26-cards { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }' +
      '@media(max-width:1023px){ .kpi26-cards{ grid-template-columns:repeat(2,1fr); } }' +
      '@media(max-width:767px){ .kpi26-cards{ grid-template-columns:1fr; } }' +
      '.kpi26-card { background:#fff; border-radius:8px; border:1px solid #f0f0f0; border-left:4px solid #d9d9d9; box-shadow:0 1px 3px rgba(0,0,0,0.08); padding:12px 14px; cursor:pointer; transition:box-shadow .15s ease,transform .15s ease; display:flex; flex-direction:column; gap:8px; }' +
      '.kpi26-card:hover { box-shadow:0 4px 12px rgba(0,0,0,0.12); transform:translateY(-2px); }' +
      '.kpi26-card.paused { opacity:.7; }' +
      '.kpi26-chead { display:flex; align-items:center; gap:8px; }' +
      '.kpi26-ccode { font-family:monospace; font-weight:700; color:#1890ff; font-size:12px; flex-shrink:0; }' +
      '.kpi26-cunit { font-size:11px; color:#999; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
      '.kpi26-cs { font-size:10px; padding:2px 8px; border-radius:10px; font-weight:500; flex-shrink:0; }' +
      '.kpi26-cs-a { background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; }' +
      '.kpi26-cs-p { background:#fff7e6; color:#fa8c16; border:1px solid #ffd591; }' +
      '.kpi26-cname { font-size:13px; font-weight:500; color:#1a1a1a; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; min-height:35px; }' +
      '.kpi26-clabel { font-size:11px; color:#999; margin-bottom:4px; }' +
      '.kpi26-cbar { height:6px; background:#f0f0f0; border-radius:3px; overflow:hidden; }' +
      '.kpi26-cbarf { height:100%; border-radius:3px; }' +
      '.kpi26-cnums { display:flex; justify-content:space-between; font-size:11px; color:#888; margin-top:6px; }' +
      '.kpi26-cfoot { display:flex; align-items:center; justify-content:space-between; border-top:1px solid #f5f5f5; padding-top:8px; gap:8px; }' +
      '.kpi26-cdim { display:flex; align-items:center; gap:6px; font-size:11px; color:#888; overflow:hidden; }' +
      '.kpi26-cfreq { font-size:11px; color:#999; text-align:right; flex-shrink:0; }' +
      '.kpi26-more { text-align:center; margin-top:16px; }' +
      '.kpi26-morebtn { background:#fff; border:1px solid #d9d9d9; border-radius:6px; padding:8px 22px; font-size:13px; color:#555; cursor:pointer; transition:all .15s; }' +
      '.kpi26-morebtn:hover { border-color:#1890ff; color:#1890ff; }' +
      // detail drawer
      '.kpi26-ov { position:fixed; inset:0; background:rgba(0,0,0,0.35); z-index:1200; display:flex; justify-content:flex-end; }' +
      '.kpi26-panel { width:460px; max-width:92vw; background:#fff; box-shadow:-4px 0 20px rgba(0,0,0,0.15); display:flex; flex-direction:column; animation:kpi26slide .2s ease; }' +
      '@keyframes kpi26slide { from{transform:translateX(100%)} to{transform:translateX(0)} }' +
      '.kpi26-ph2 { padding:16px 20px; border-bottom:1px solid #f0f0f0; display:flex; align-items:center; justify-content:space-between; }' +
      '.kpi26-pt { font-size:16px; font-weight:600; }' +
      '.kpi26-pcl { cursor:pointer; font-size:20px; color:#999; line-height:1; border:none; background:none; }' +
      '.kpi26-pb { padding:20px; flex:1; overflow-y:auto; }' +
      '.kpi26-drow { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }' +
      '.kpi26-dl { font-size:11px; color:#999; font-weight:600; text-transform:uppercase; letter-spacing:.4px; margin-bottom:5px; }' +
      '.kpi26-dv { font-size:14px; color:#1a1a1a; word-break:break-word; }' +
      '</style>'
    );
  }

  function progColor(p) { return p >= 80 ? '#52c41a' : (p >= 50 ? '#faad14' : '#ff4d4f'); }

  // Period data (actual/target) is not modeled yet (PH1-04). Render empty bar.
  function miniProgress(r) {
    var paused = !isActive(r);
    var tip = paused ? 'KPI tạm tắt' : 'Chưa có dữ liệu kỳ';
    return (
      '<div class="kpi26-mp" title="' + esc(tip) + '"><div class="kpi26-mpb" style="width:0%;background:' +
      (paused ? '#d9d9d9' : '#e6e6e6') + '"></div></div>' +
      '<div class="kpi26-pct">—</div>'
    );
  }

  function rowHtml(r) {
    var paused = !isActive(r);
    var badge = paused
      ? '<span class="kpi26-st kpi26-st-p" title="Tạm tắt">⏸</span>'
      : '<span class="kpi26-st kpi26-st-a" title="Đang hoạt động">✓</span>';
    return (
      '<div class="kpi26-row' + (paused ? ' paused' : '') + '" data-act="detail" data-id="' + esc(r.id) + '">' +
      '<div class="kpi26-code">' + esc(r.code) + '</div>' +
      '<div class="kpi26-name">' + esc(r.name) + '</div>' +
      '<div class="kpi26-right">' + miniProgress(r) + badge + '</div>' +
      '</div>'
    );
  }

  function passFilter(r) {
    if (state.status === 'active' && !isActive(r)) return false;
    if (state.status === 'inactive' && isActive(r)) return false;
    if (state.search) {
      var q = state.search.toLowerCase();
      var hay = (String(r.code || '') + ' ' + String(r.name || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  function quadHtml(dim, items) {
    var inDim = items || state.rows.filter(function (r) { return r.bsc_dimension === dim.value; });
    var shown = inDim.filter(passFilter);
    var weight = inDim.reduce(function (s, r) { return s + (isActive(r) ? num(r.weight_default) : 0); }, 0);
    var wRounded = Math.round(weight * 100) / 100;
    var ok = wRounded === 100;
    var wtCls = ok ? 'kpi26-wok' : 'kpi26-wwarn';
    var wtTxt = (ok ? '∑ ' : '⚠ ∑ ') + wRounded + '%';
    var body = shown.length
      ? shown.map(rowHtml).join('')
      : '<div class="kpi26-empty">Không có KPI phù hợp</div>';
    return (
      '<div class="kpi26-quad" style="border-top-color:' + dim.color + '">' +
      '<div class="kpi26-qh"><div class="kpi26-qt"><span class="kpi26-qicon">' + dim.icon + '</span>' + esc(dim.label) + '</div>' +
      '<span class="kpi26-wt ' + wtCls + '">' + wtTxt + '</span></div>' +
      '<div class="kpi26-qb">' + body + '</div>' +
      '<div class="kpi26-qf"><span>' + inDim.length + ' KPI · Trọng số: ' + wRounded + '%</span>' +
      '<span class="kpi26-viewall" data-act="viewall" data-dim="' + esc(dim.value) + '">Xem tất cả →</span></div>' +
      '</div>'
    );
  }

  function bscHtml() {
    // Build grouped map: each dim key → rows; plus __unclassified__ bucket
    var grouped = {};
    DIMS.forEach(function (d) { grouped[d.value] = []; });
    var unclassified = [];
    state.rows.forEach(function (r) {
      if (Object.prototype.hasOwnProperty.call(grouped, r.bsc_dimension)) {
        grouped[r.bsc_dimension].push(r);
      } else {
        unclassified.push(r);
      }
    });

    var legend = DIMS.map(function (d) {
      var off = state.dims.indexOf(d.value) === -1;
      return '<div class="kpi26-lg' + (off ? ' off' : '') + '" data-act="dim" data-dim="' + esc(d.value) + '">' +
        '<span class="kpi26-dot" style="background:' + d.color + '"></span>' + esc(d.label) + '</div>';
    }).join('');
    var quads = DIMS.filter(function (d) { return state.dims.indexOf(d.value) !== -1; })
      .map(function (d) { return quadHtml(d, grouped[d.value]); }).join('');
    var unclassifiedHtml = '';
    if (unclassified.length > 0) {
      unclassifiedHtml = quadHtml(
        { value: '__unclassified__', label: 'Chưa phân loại', color: '#999', icon: '❓' },
        unclassified
      );
    }
    return (
      '<div class="kpi26-legend">' + legend +
      '<div style="flex:1"></div>' +
      '<div class="kpi26-lg" style="color:#ff4d4f;cursor:default">⚠ Tổng trọng số ≠ 100%</div></div>' +
      '<div class="kpi26-grid">' + quads + unclassifiedHtml + '</div>'
    );
  }

  function dimOf(v) { return DIMS.filter(function (d) { return d.value === v; })[0] || null; }

  // Card Grid View (KPI-27). Reuses passFilter (search + status) and the shared
  // detail drawer via data-act="detail". Period data (actual/target) is not
  // modeled yet (PH1-04) -> empty bar + "—".
  function cardHtml(r) {
    var paused = !isActive(r);
    var dim = dimOf(r.bsc_dimension);
    var color = dim ? dim.color : '#d9d9d9';
    var badge = paused
      ? '<span class="kpi26-cs kpi26-cs-p">Tạm dừng</span>'
      : '<span class="kpi26-cs kpi26-cs-a">Hoạt động</span>';
    var dimLabel = dim ? dim.label : 'Chưa phân loại';
    var freq = r.frequency ? esc(r.frequency) : '—';
    return (
      '<div class="kpi26-card' + (paused ? ' paused' : '') + '" style="border-left-color:' + color + '" data-act="detail" data-id="' + esc(r.id) + '">' +
      '<div class="kpi26-chead">' +
      '<span class="kpi26-ccode">' + esc(r.code) + '</span>' +
      '<span class="kpi26-cunit">' + (r.unit ? esc(r.unit) : '') + '</span>' +
      badge +
      '</div>' +
      '<div class="kpi26-cname" title="' + esc(r.name) + '">' + esc(r.name) + '</div>' +
      '<div>' +
      '<div class="kpi26-clabel">Tiến độ thực hiện</div>' +
      '<div class="kpi26-cbar" title="Chưa có dữ liệu kỳ"><div class="kpi26-cbarf" style="width:0%;background:' +
      (paused ? '#d9d9d9' : '#e6e6e6') + '"></div></div>' +
      '<div class="kpi26-cnums"><span>TT: —</span><span>MT: — · —</span></div>' +
      '</div>' +
      '<div class="kpi26-cfoot">' +
      '<span class="kpi26-cdim"><span class="kpi26-dot" style="width:7px;height:7px;background:' + color + '"></span>' + esc(dimLabel) + '</span>' +
      '<span class="kpi26-cfreq">' + freq + '</span>' +
      '</div>' +
      '</div>'
    );
  }

  function cardGridHtml() {
    var shown = state.rows.filter(passFilter);
    if (!shown.length) {
      return '<div class="kpi26-ph"><div class="big">🃏</div>' +
        '<div style="font-size:15px;color:#888">Không có KPI phù hợp với bộ lọc hiện tại</div></div>';
    }
    var limit = state.cardLimit;
    var cards = shown.slice(0, limit).map(cardHtml).join('');
    var more = '';
    if (shown.length > limit) {
      more = '<div class="kpi26-more"><button class="kpi26-morebtn" data-act="loadmore">' +
        'Xem thêm ' + (shown.length - limit) + ' KPI</button></div>';
    }
    return '<div class="kpi26-cards">' + cards + '</div>' + more;
  }

  function detailHtml() {
    if (!state.detail) return '';
    var r = state.detail;
    var dim = DIMS.filter(function (d) { return d.value === r.bsc_dimension; })[0];
    function cell(label, val) {
      return '<div><div class="kpi26-dl">' + esc(label) + '</div><div class="kpi26-dv">' + esc(val || '—') + '</div></div>';
    }
    var body =
      '<div style="margin-bottom:16px"><div class="kpi26-dl">Tên chỉ tiêu</div><div class="kpi26-dv" style="font-size:15px;font-weight:600">' + esc(r.name) + '</div></div>' +
      '<div class="kpi26-drow">' + cell('Khía cạnh BSC', dim ? (dim.icon + ' ' + dim.label) : r.bsc_dimension) + cell('Trạng thái', r.status) + '</div>' +
      '<div class="kpi26-drow">' + cell('Loại KPI', r.kpi_type) + cell('Hướng tốt', r.direction) + '</div>' +
      '<div class="kpi26-drow">' + cell('Đơn vị đo', r.unit) + cell('Tần suất', r.frequency) + '</div>' +
      '<div class="kpi26-drow">' + cell('Trọng số (%)', num(r.weight_default)) + cell('Tính vào điểm', r.count_in_score ? 'Có' : 'Không') + '</div>' +
      '<div class="kpi26-drow">' + cell('Ngưỡng xanh', r.threshold_green) + cell('Ngưỡng vàng', r.threshold_yellow) + '</div>' +
      '<div class="kpi26-drow">' + cell('Ngưỡng đỏ', r.threshold_red) + cell('Kỳ dữ liệu', 'Chưa có dữ liệu kỳ') + '</div>' +
      '<div style="margin-bottom:8px"><div class="kpi26-dl">Định nghĩa</div><div class="kpi26-dv">' + esc(r.definition || '—') + '</div></div>';
    return (
      '<div class="kpi26-ov" data-act="ovclose">' +
      '<div class="kpi26-panel" data-act="stop">' +
      '<div class="kpi26-ph2"><div class="kpi26-pt">' + esc(r.code) + '</div>' +
      '<button class="kpi26-pcl" data-act="close">×</button></div>' +
      '<div class="kpi26-pb">' + body + '</div></div></div>'
    );
  }

  function toolbarHtml() {
    function vbtn(v, label) {
      return '<button class="kpi26-vbtn' + (state.view === v ? ' active' : '') + '" data-act="view" data-view="' + v + '">' + label + '</button>';
    }
    return (
      '<div class="kpi26-toolbar">' +
      '<div class="kpi26-tl">' +
      '<input class="kpi26-search" data-act="search" placeholder="🔍  Tìm KPI theo mã, tên..." value="' + esc(state.search) + '">' +
      '<select class="kpi26-sel" data-act="status">' +
      '<option value="all"' + (state.status === 'all' ? ' selected' : '') + '>Tất cả trạng thái</option>' +
      '<option value="active"' + (state.status === 'active' ? ' selected' : '') + '>Đang hoạt động</option>' +
      '<option value="inactive"' + (state.status === 'inactive' ? ' selected' : '') + '>Tạm tắt</option>' +
      '</select></div>' +
      '<div class="kpi26-tr"><div class="kpi26-switch">' +
      vbtn('table', '📋 Bảng') + vbtn('bsc', '⊞ BSC') + vbtn('card', '🃏 Cards') +
      '</div></div></div>'
    );
  }

  function contentHtml() {
    if (state.loading) return '<div class="kpi26-ph"><div class="big">⏳</div>Đang tải dữ liệu KPI...</div>';
    if (state.error) return '<div class="kpi26-ph"><div class="big">⚠️</div>Lỗi tải dữ liệu: ' + esc(state.error) + '</div>';
    if (state.view === 'bsc') return bscHtml();
    if (state.view === 'card') return cardGridHtml();
    return ''; // table view -> native table shown below
  }

  // Locate the native table block card WITHOUT touching the `document` global:
  // walk up from our own host element and search each ancestor's subtree.
  function nativeTableCard() {
    var p = host;
    while (p) {
      if (p.querySelector) {
        var byId = p.querySelector('[id="model-' + NATIVE_TABLE_UID + '"]');
        if (byId) return byId;
        var tw = p.querySelector('.ant-table-wrapper');
        if (tw && tw.closest) return tw.closest('[id^="model-"]') || tw.closest('.ant-card') || tw;
      }
      p = p.parentElement;
    }
    return null;
  }
  function setNativeTableVisible(v) {
    var el = nativeTableCard();
    if (el) el.style.display = v ? '' : 'none';
  }

  function render() {
    if (!host) return;
    ctx.render('<div class="kpi26">' + styleTag() + toolbarHtml() + contentHtml() + detailHtml() + '</div>');
    setNativeTableVisible(state.view === 'table');
  }

  function setView(v) {
    state.view = v;
    if (v === 'card') state.cardLimit = CARD_PAGE;
    saveView(v);
    render();
  }

  // Delegated events (bound once on the persistent host element).
  if (host && !host.__kpi26bound) {
    host.__kpi26bound = true;
    host.addEventListener('click', function (e) {
      var t = e.target.closest('[data-act]');
      if (!t) return;
      var act = t.getAttribute('data-act');
      if (act === 'view') { setView(t.getAttribute('data-view')); return; }
      if (act === 'loadmore') { state.cardLimit += CARD_PAGE; render(); return; }
      if (act === 'dim') {
        var dv = t.getAttribute('data-dim');
        var i = state.dims.indexOf(dv);
        if (i === -1) state.dims.push(dv); else if (state.dims.length > 1) state.dims.splice(i, 1);
        render();
        return;
      }
      if (act === 'detail') {
        var id = t.getAttribute('data-id');
        state.detail = state.rows.filter(function (r) { return String(r.id) === String(id); })[0] || null;
        render();
        return;
      }
      if (act === 'viewall') {
        var dim = t.getAttribute('data-dim');
        if (ctx.message) ctx.message.info('Chuyển sang bảng — khía cạnh: ' + dim);
        setView('table');
        return;
      }
      if (act === 'close' || act === 'ovclose') { state.detail = null; render(); return; }
      if (act === 'stop') { e.stopPropagation(); return; }
    });
    host.addEventListener('input', function (e) {
      var t = e.target.closest('[data-act="search"]');
      if (t) { state.search = t.value; state.cardLimit = CARD_PAGE; render(); setTimeout(function () { var s = host.querySelector('[data-act="search"]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }, 0); }
    });
    host.addEventListener('change', function (e) {
      var t = e.target.closest('[data-act="status"]');
      if (t) { state.status = t.value; state.cardLimit = CARD_PAGE; render(); }
    });
    host.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.detail) { state.detail = null; render(); }
    });
  }

  render();

  // Fetch bsc_dimensions from DB; fall back to DIMS_FALLBACK if empty or error.
  // Runs before loadData so that grouping logic uses live dimension config.
  function loadDims() {
    var res = ctx.makeResource('MultiRecordResource');
    if (res.setResourceName) res.setResourceName('bsc_dimensions');
    if (res.setDataSourceKey) res.setDataSourceKey('main');
    if (res.setPageSize) res.setPageSize(20);
    if (res.setSort) res.setSort([{ field: 'order', order: 'asc' }]);
    return res.refresh().then(function () {
      var raw = res.getData ? res.getData() : [];
      var records = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
      if (records.length > 0) {
        DIMS = records.map(function (d) {
          return {
            value: d.name,   // must match kpi_catalog.bsc_dimension stored value
            label: d.name,
            color: d.color || '#d9d9d9',
            icon:  d.icon  || '•',
            code:  d.code,
            order: d.order,
          };
        });
      }
      // Re-sync toggle state: add any new dims, remove stale ones
      var dimValues = DIMS.map(function (d) { return d.value; });
      state.dims = state.dims
        .filter(function (v) { return dimValues.indexOf(v) !== -1; })
        .concat(dimValues.filter(function (v) { return state.dims.indexOf(v) === -1; }));
    }).catch(function () {
      // Non-fatal: keep DIMS_FALLBACK already set
    });
  }

  // Data via the NocoBase resource API (required by RunJS authoring rules).
  function loadData() {
    var res = ctx.makeResource('MultiRecordResource');
    if (res.setResourceName) res.setResourceName('kpi_catalog');
    if (res.setDataSourceKey) res.setDataSourceKey('main');
    if (res.setPageSize) res.setPageSize(300);
    if (res.setSort) res.setSort(['code']);
    if (res.setFields) res.setFields(['id', 'code', 'name', 'bsc_dimension', 'weight_default',
      'status', 'unit', 'frequency', 'kpi_type', 'direction', 'definition', 'count_in_score',
      'threshold_green', 'threshold_yellow', 'threshold_red']);
    return res.refresh().then(function () {
      var data = res.getData ? res.getData() : [];
      state.rows = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      state.loading = false;
      render();
    });
  }
  Promise.resolve().then(loadDims).then(loadData).catch(function (err) {
    state.loading = false;
    state.error = (err && err.message) || 'unknown';
    render();
  });
} catch (e) {
  if (ctx && ctx.render) ctx.render('<div style="padding:20px;color:#ff4d4f">KPI-26 block error: ' + String(e && e.message) + '</div>');
}
