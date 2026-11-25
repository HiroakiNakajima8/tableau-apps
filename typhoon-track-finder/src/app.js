(function () {
  'use strict';

  // Typhoon Track Finder ― 「この台風に似た過去の台風」検索
  // 公開済みデータソース「Historical Tropical Cyclones」（IBTrACS）から北西太平洋の全経路をライブで取得し、
  // 選んだ台風（または地図に描いた経路）に似た過去の台風を、ブラウザ内で経路どうしを比べて探すData App。
  //
  // 似ている度合い（小さいほど似ている）
  //   経路を道のりに沿って等間隔の N 点に置き直し、対応する点どうしの距離（km）の平均をとる。
  //   ・位置と形：そのまま比べる
  //   ・形だけ　：重心をそろえてから比べる（場所が違っても同じ曲がり方なら似ているとみなす）
  //   ・区間　　：相手の経路の中から、長さが近い区間をずらしながら探し、一番近い区間で比べる（部分一致）

  var START_YEAR = 1951;            // 気象庁ベストトラックの始まり
  var END_YEAR = 2026;
  var N = 24;                       // 比較に使う点の数
  var TOP_K = 10;
  var EXTENTS = {
    auto: { label: 'Auto', box: null },             // 選んだ台風と上位の台風が収まる範囲
    japan: { label: 'Around Japan', box: [[118, 22], [152, 47]] },
    basin: { label: 'NW Pacific', box: [[100, 0], [185, 55]] }
  };
  var MODES = [['pos', 'Position & shape'], ['shape', 'Shape only'], ['part', 'Segment (partial match)']];
  var PRESETS = [
    ['HAGIBIS', 2019, 'Hagibis 2019'],
    ['FAXAI', 2019, 'Faxai 2019'],
    ['JEBI', 2018, 'Jebi 2018'],
    ['SHANSHAN', 2024, 'Shanshan 2024'],
    ['NANMADOL', 2022, 'Nanmadol 2022'],
    ['VERA', 1959, 'Vera 1959 (Isewan)'],
    ['NANCY', 1961, 'Nancy 1961 (2nd Muroto)'],
    ['MIREILLE', 1991, 'Mireille 1991 (\"Apple Typhoon\")']
  ];
  // 気象庁の強さの階級（最大風速 kt、10分間平均）
  var CATS = [
    { min: 105, ja: 'Violent', color: '#7b2d8e' },
    { min: 85, ja: 'Very strong', color: '#d7301f' },
    { min: 64, ja: 'Strong', color: '#f28e2b' },
    { min: 34, ja: 'Tropical storm', color: '#4e9bd4' },
    { min: -1, ja: 'Tropical depression', color: '#9aa3ad' }
  ];

  var root = document.getElementById('app');
  var state = {
    storms: [],
    byId: {},
    query: null,          // { kind: 'storm', storm } | { kind: 'drawn', pts }
    mode: 'pos',
    sameSeason: false,
    fromYear: START_YEAR,
    extent: 'auto',
    results: [],
    focus: null,          // 強調表示している結果の sid
    drawing: false,
    speed: 'normal',
    playing: false
  };
  var ui = {};
  var anim = null;

  // ---------- helpers ----------
  function extractData(result) { return result && Array.isArray(result.data) ? result.data : []; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function title(name) {
    if (!name || /^NOT[_ ]NAMED$/i.test(name) || name === 'UNNAMED') return 'Unnamed';
    return name.charAt(0) + name.slice(1).toLowerCase();
  }

  function catOf(kt) {
    for (var i = 0; i < CATS.length; i++) if (kt >= CATS[i].min) return CATS[i];
    return CATS[CATS.length - 1];
  }

  function fmtDate(ms) {
    var d = new Date(ms);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function fmtMD(ms) { var d = new Date(ms); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function km(v) { return Math.round(v).toLocaleString('en-US') + ' km'; }

  // ---------- time parsing（文字列の書式が混ざっていても読む） ----------
  // 「05/10/2019」のような書式は、日/月の順がデータによって違う。データ全体を見て決める（既定は日/月/年）
  var slashOrder = 'DMY';
  function detectSlashOrder(values) {
    var dmy = 0, mdy = 0;
    for (var i = 0; i < values.length && (dmy + mdy) < 50; i++) {
      var m = /^(\d{1,2})\/(\d{1,2})\/\d{4}/.exec(String(values[i] || '').trim());
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      else if (+m[2] > 12) mdy++;
    }
    slashOrder = mdy > dmy ? 'MDY' : 'DMY';
    return slashOrder;
  }

  function parseTime(v) {
    if (v === null || v === undefined || v === '') return NaN;
    if (typeof v === 'number') return v > 1e11 ? v : (v - 25569) * 86400000;
    var s = String(v).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {                     // Excel のシリアル値
      var n = +s;
      return n > 1e11 ? n : (n - 25569) * 86400000;
    }
    var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);   // D/M/YYYY または M/D/YYYY
    if (m) {
      var dd = slashOrder === 'DMY' ? +m[1] : +m[2], mm = slashOrder === 'DMY' ? +m[2] : +m[1];
      return Date.UTC(+m[3], mm - 1, dd, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    return NaN;
  }

  function num(v) {
    if (v === null || v === undefined) return NaN;
    var s = String(v).trim();
    return s === '' ? NaN : +s;
  }

  // ---------- geometry ----------
  // 近距離用の平面近似（km）。比較の内側のループで何百万回も呼ぶので、ハバーサインより軽い式を使う。
  function dkm(la1, lo1, la2, lo2) {
    var x = (lo2 - lo1) * Math.cos((la1 + la2) * 0.008726646) * 111.32;
    var y = (la2 - la1) * 111.32;
    return Math.sqrt(x * x + y * y);
  }

  function cumulative(lat, lon) {
    var c = [0];
    for (var i = 1; i < lat.length; i++) c.push(c[i - 1] + dkm(lat[i - 1], lon[i - 1], lat[i], lon[i]));
    return c;
  }

  // 道のり s の位置を返す（cum は累積距離）。hint は前回の位置（単調増加で呼ぶと速い）
  function at(tr, s, hint) {
    var c = tr.cum, n = c.length;
    if (s <= 0) return [tr.lat[0], tr.lon[0], 0];
    if (s >= c[n - 1]) return [tr.lat[n - 1], tr.lon[n - 1], n - 2];
    var i = hint || 0;
    while (i < n - 2 && c[i + 1] < s) i++;
    var seg = c[i + 1] - c[i] || 1, f = (s - c[i]) / seg;
    return [tr.lat[i] + (tr.lat[i + 1] - tr.lat[i]) * f, tr.lon[i] + (tr.lon[i + 1] - tr.lon[i]) * f, i];
  }

  function resample(tr, s0, s1, n) {
    var la = new Float64Array(n), lo = new Float64Array(n), h = 0;
    for (var i = 0; i < n; i++) {
      var p = at(tr, s0 + (s1 - s0) * i / (n - 1), h);
      la[i] = p[0]; lo[i] = p[1]; h = p[2];
    }
    return { lat: la, lon: lo };
  }

  function meanGap(a, b, dLat, dLon, cutoff) {
    var s = 0, lim = cutoff * a.lat.length;
    for (var i = 0; i < a.lat.length; i++) {
      s += dkm(a.lat[i], a.lon[i], b.lat[i] + dLat, b.lon[i] + dLon);
      if (s > lim) return Infinity;                 // これ以上は勝ち目がないので打ち切り
    }
    return s / a.lat.length;
  }

  function centroid(r) {
    var la = 0, lo = 0;
    for (var i = 0; i < r.lat.length; i++) { la += r.lat[i]; lo += r.lon[i]; }
    return [la / r.lat.length, lo / r.lat.length];
  }

  function bboxGap(a, b) {
    var dLat = Math.max(0, a.minLat - b.maxLat, b.minLat - a.maxLat);
    var dLon = Math.max(0, a.minLon - b.maxLon, b.minLon - a.maxLon);
    var lat = Math.max(Math.abs(a.minLat), Math.abs(b.minLat));
    return Math.sqrt(Math.pow(dLat * 111.32, 2) + Math.pow(dLon * 111.32 * Math.cos(lat * Math.PI / 180), 2));
  }

  // ---------- similarity ----------
  // q: { lat, lon, cum, len, full(=N点), bbox..., doy }
  function compare(q, c, mode, best) {
    var cutoff = isFinite(best) ? best : Infinity;
    if (mode === 'shape') {
      var cq = centroid(q.full), cc = centroid(c.full);
      return { gap: meanGap(q.full, c.full, cq[0] - cc[0], cq[1] - cc[1], cutoff), s0: 0, s1: c.len };
    }
    if (bboxGap(q, c) > 900) return { gap: Infinity };
    if (mode === 'pos' || c.len < q.len * 0.7) {
      return { gap: meanGap(q.full, c.full, 0, 0, cutoff), s0: 0, s1: c.len };
    }
    // 区間：相手の経路から長さの近い区間をずらしながら探す
    var bestGap = Infinity, bs0 = 0, bs1 = c.len;
    var scales = [0.8, 1, 1.25];
    var step = Math.max(q.len / 8, 25);
    for (var k = 0; k < scales.length; k++) {
      var w = Math.min(c.len, q.len * scales[k]);
      for (var s = 0; s + w <= c.len + 1e-6; s += step) {
        var seg = resample(c, s, s + w, N);
        var g = meanGap(q.full, seg, 0, 0, Math.min(cutoff, bestGap));
        if (g < bestGap) { bestGap = g; bs0 = s; bs1 = s + w; }
      }
    }
    return { gap: bestGap, s0: bs0, s1: bs1 };
  }

  function search() {
    var q = queryTrack();
    if (!q) { state.results = []; return; }
    var t0 = Date.now();
    var mode = state.mode;
    var excl = state.query.kind === 'storm' ? state.query.storm.sid : null;
    var top = [];                                   // 小さい順に TOP_K 件を保つ
    var worst = Infinity;
    for (var i = 0; i < state.storms.length; i++) {
      var c = state.storms[i];
      if (c.sid === excl || c.year < state.fromYear || c.sim.len < 150) continue;
      if (state.sameSeason && isFinite(q.doy)) {
        var dd = Math.abs(c.doy - q.doy); dd = Math.min(dd, 365 - dd);
        if (dd > 30) continue;
      }
      var r = compare(q.sim || q, c.sim, mode, top.length >= TOP_K ? worst : Infinity);
      if (!isFinite(r.gap)) continue;
      if (top.length < TOP_K || r.gap < worst) {
        top.push({ storm: c, gap: r.gap, s0: r.s0, s1: r.s1 });
        top.sort(function (a, b) { return a.gap - b.gap; });
        if (top.length > TOP_K) top.pop();
        worst = top.length >= TOP_K ? top[top.length - 1].gap : Infinity;
      }
    }
    state.results = top;
    state.searchMs = Date.now() - t0;
  }

  function queryTrack() {
    if (!state.query) return null;
    if (state.query.kind === 'storm') return state.query.storm;
    return state.query.track;
  }

  function prepareTrack(lat, lon) {
    var tr = { lat: lat, lon: lon };
    tr.cum = cumulative(lat, lon);
    tr.len = tr.cum[tr.cum.length - 1];
    tr.full = resample(tr, 0, tr.len, N);
    tr.minLat = Math.min.apply(null, lat); tr.maxLat = Math.max.apply(null, lat);
    tr.minLon = Math.min.apply(null, lon); tr.maxLon = Math.max.apply(null, lon);
    return tr;
  }

  // ---------- data ----------
  // クエリの組み立て。Tableau 側が受け付ける書き方の違いに備えて、書き方（style）を順に試す。
  // SET フィルターには exclude:false が必須（VizQL Data Service の仕様）。
  //   A：すべての列に短い別名を付け、年は値の一覧（SET）で絞る
  //   B：集計する列だけ別名を付ける（ディメンションは列名のまま）、年は SET
  //   C：B と同じで、年を範囲（QUANTITATIVE_NUMERICAL）で絞る
  //   D：B と同じで、海域（Basin）の絞り込みをやめて、アプリ側で北西太平洋だけ残す
  var META_FIELDS = [['a', 'SID'], ['n', 'Name'], ['y', 'Season (Year)']];
  var TRACK_FIELDS = [
    ['a', 'SID'], ['t', 'Iso Time'],
    ['y', 'Latitude', 'AVG'], ['x', 'Longitude', 'AVG'],
    ['w', 'Wmo Wind (Kts)', 'MAX'], ['u', 'Usa Wind (Kts)', 'MAX'],
    ['p', 'Wmo Pres (Mb)'], ['d', 'Dist2Land (Km)', 'MIN'], ['k', 'Nature']
  ];
  var STYLES = ['A', 'B', 'C', 'D'];

  function buildQuery(specs, a, b, style) {
    var fields = [], keyOf = {};
    var list = specs.slice();
    if (style === 'D') list.push(['basin', 'Basin']);
    list.forEach(function (f) {
      var q = { fieldCaption: f[1] };
      if (f[2]) q['function'] = f[2];
      var alias = style === 'A' || f[2];
      if (alias) { q.fieldAlias = f[0]; keyOf[f[0]] = f[0]; } else { keyOf[f[1]] = f[0]; }
      fields.push(q);
    });
    var filters = [];
    if (style !== 'D') filters.push({ field: { fieldCaption: 'Basin' }, filterType: 'SET', values: ['WP'], exclude: false });
    if (style === 'C') {
      filters.push({ field: { fieldCaption: 'Season (Year)' }, filterType: 'QUANTITATIVE_NUMERICAL', quantitativeFilterType: 'RANGE', min: a, max: b, includeNulls: false });
    } else {
      var ys = [];
      for (var y = a; y <= b; y++) ys.push(y);
      filters.push({ field: { fieldCaption: 'Season (Year)' }, filterType: 'SET', values: ys, exclude: false });
    }
    return { query: { fields: fields, filters: filters }, keyOf: keyOf, style: style };
  }

  function normalize(rows, built) {
    if (built.style === 'A') return rows;
    var keys = Object.keys(built.keyOf);
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (built.style === 'D' && r.Basin !== 'WP' && r.basin !== 'WP') continue;
      var o = {};
      for (var k = 0; k < keys.length; k++) o[built.keyOf[keys[k]]] = r[keys[k]];
      out.push(o);
    }
    return out;
  }

  function errText(e) {
    if (!e) return 'Unknown error';
    return e.message || e.errorCode || (typeof e === 'string' ? e : JSON.stringify(e));
  }

  // 日本の陸地をおおまかに囲む範囲（朝鮮半島・沿海州を外す）
  function inJapan(lat, lon) {
    return (lat >= 30 && lat <= 41.6 && lon >= 129.6 && lon <= 142.3) ||
      (lat > 41.3 && lat <= 45.6 && lon >= 139.7 && lon <= 145.9) ||
      (lat >= 24 && lat < 30 && lon >= 122.9 && lon <= 131.4);
  }

  function buildStorms(meta, rows) {
    var info = {};
    meta.forEach(function (m) { info[m.a] = { name: m.n, year: +m.y }; });
    var groups = {};
    var badTime = 0;
    detectSlashOrder(rows.map(function (r) { return r.t; }));
    rows.forEach(function (r) {
      var t = parseTime(r.t), la = num(r.y), lo = num(r.x);
      if (!isFinite(t)) { badTime++; return; }
      if (!isFinite(la) || !isFinite(lo)) return;
      if (lo < 0) lo += 360;                       // 日付変更線をまたぐ経路を連続させる
      (groups[r.a] || (groups[r.a] = [])).push({ t: t, la: la, lo: lo, w: num(r.w), u: num(r.u), p: num(r.p), d: num(r.d), et: r.k === 'ET' });
    });
    var storms = [];
    Object.keys(groups).forEach(function (sid) {
      var pts = groups[sid].sort(function (a, b) { return a.t - b.t; });
      var u = [];
      pts.forEach(function (p) { if (!u.length || p.t !== u[u.length - 1].t) u.push(p); });
      if (u.length < 4) return;
      var lat = u.map(function (p) { return p.la; }), lon = u.map(function (p) { return p.lo; });
      var tr = prepareTrack(lat, lon);
      // 比べるのは熱帯低気圧・台風の段階だけ（温帯低気圧になった後の長い経路で差が膨らまないように）
      var trop = u.filter(function (p) { return !p.et; });
      tr.sim = trop.length >= 4 && trop.length < u.length
        ? prepareTrack(trop.map(function (p) { return p.la; }), trop.map(function (p) { return p.lo; }))
        : tr;
      var meta = info[sid] || { name: '', year: new Date(u[0].t).getUTCFullYear() };
      var wmo = u.map(function (p) { return p.w; }).filter(isFinite);
      var usa = u.map(function (p) { return p.u; }).filter(isFinite);
      tr.wind = u.map(function (p) { return isFinite(p.w) ? p.w : (isFinite(p.u) ? p.u * 0.88 : NaN); });
      tr.maxWind = wmo.length ? Math.max.apply(null, wmo) : (usa.length ? Math.round(Math.max.apply(null, usa) * 0.88) : NaN);
      var pres = u.map(function (p) { return p.p; }).filter(function (v) { return isFinite(v) && v > 850; });
      tr.minPres = pres.length ? Math.min.apply(null, pres) : NaN;
      tr.t = u.map(function (p) { return p.t; });
      tr.japan = u.some(function (p) { return p.d === 0 && inJapan(p.la, p.lo); });
      tr.sid = sid;
      tr.name = meta.name;
      tr.year = meta.year;
      tr.start = u[0].t;
      var d0 = new Date(Date.UTC(new Date(tr.start).getUTCFullYear(), 0, 1)).getTime();
      tr.doy = (tr.start - d0) / 86400000;
      tr.cat = catOf(tr.maxWind);
      storms.push(tr);
    });
    storms.sort(function (a, b) { return a.start - b.start; });
    return { storms: storms, badTime: badTime };
  }

  // ---------- map ----------
  function autoBox() {
    var q = queryTrack();
    if (!q) return EXTENTS.basin.box;
    var tr = [q].concat(state.results.slice(0, 3).map(function (r) { return r.storm; }));
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    tr.forEach(function (t) { x0 = Math.min(x0, t.minLon); x1 = Math.max(x1, t.maxLon); y0 = Math.min(y0, t.minLat); y1 = Math.max(y1, t.maxLat); });
    x0 -= 4; x1 += 4; y0 -= 3; y1 += 3;
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;                 // 寄りすぎないよう最小の広さを確保
    if (x1 - x0 < 26) { x0 = cx - 13; x1 = cx + 13; }
    if (y1 - y0 < 18) { y0 = cy - 9; y1 = cy + 9; }
    return [[Math.max(95, x0), Math.max(-5, y0)], [Math.min(190, x1), Math.min(60, y1)]];
  }

  function setupProjection(W, H) {
    var b = EXTENTS[state.extent].box || autoBox();
    var proj = d3.geoMercator().rotate([-150, 0]).fitExtent([[6, 6], [W - 6, H - 6]],
      { type: 'MultiPoint', coordinates: [b[0], b[1], [b[0][0], b[1][1]], [b[1][0], b[0][1]]] });
    proj.clipExtent([[0, 0], [W, H]]);
    return proj;
  }

  function buildMap() {
    var W = Math.max(320, ui.mapWrap.clientWidth || 760);
    var H = Math.max(380, Math.min(640, Math.round(W * 0.78)));
    ui.W = W; ui.H = H;
    ui.mapWrap.textContent = '';
    ui.mapWrap.style.height = H + 'px';
    var dpr = window.devicePixelRatio || 1;
    var canvas = el('canvas', 'tracks-canvas');
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ui.mapWrap.appendChild(canvas);
    ui.canvas = canvas;
    ui.ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (ui.ctx) ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ui.proj = setupProjection(W, H);

    ui.svg = d3.select(ui.mapWrap).append('svg')
      .attr('class', 'overlay').attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H])
      .attr('role', 'img').attr('aria-label', 'Typhoon track map');
    ui.gMatch = ui.svg.append('g');
    ui.gPlay = ui.svg.append('g');      // 再生中の台風（似た台風の上、選んだ台風の下に描く）
    ui.gQuery = ui.svg.append('g');
    ui.gDraw = ui.svg.append('g');
    ui.yearLabel = ui.svg.append('text').attr('class', 'year-label').attr('x', 16).attr('y', H - 18);
    ui.svg.append('text').attr('class', 'attrib').attr('x', W - 6).attr('y', H - 6).attr('text-anchor', 'end')
      .text('Coastline: Natural Earth · Tracks: IBTrACS');
    ui.svg.on('pointerdown', onDrawStart).on('pointermove', onDrawMove).on('pointerup', onDrawEnd).on('pointerleave', onDrawEnd);

    drawBase();
    drawOverlay();
  }

  function drawBase(upToYear) {
    var ctx = ui.ctx;
    if (!ctx) return;
    var W = ui.W, H = ui.H, proj = ui.proj;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#eef3f7';
    ctx.fillRect(0, 0, W, H);
    var path = d3.geoPath(proj, ctx);
    ctx.beginPath(); path(d3.geoGraticule().step([10, 10])());
    ctx.strokeStyle = 'rgba(80,100,120,0.12)'; ctx.lineWidth = 1; ctx.stroke();
    if (window.__LAND_50M && window.topojson) {
      if (!ui.land) ui.land = topojson.feature(window.__LAND_50M, window.__LAND_50M.objects.land);
      ctx.beginPath(); path(ui.land);
      ctx.fillStyle = '#e4dfd5'; ctx.fill();
      ctx.strokeStyle = '#b9b1a3'; ctx.lineWidth = 0.6; ctx.stroke();
    }
    var dim = !!state.query;
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = dim ? 'rgba(60,90,130,0.05)' : 'rgba(60,90,130,0.10)';
    state.storms.forEach(function (s) {
      if (s.year < state.fromYear) return;
      if (upToYear !== undefined && s.year > upToYear) return;
      strokeTrack(ctx, s, 0, s.lat.length - 1);
    });
  }

  function strokeTrack(ctx, s, i0, i1) {
    ctx.beginPath();
    for (var i = i0; i <= i1; i++) {
      var p = ui.proj([s.lon[i], s.lat[i]]);
      if (!p) continue;
      if (i === i0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  }

  function lineOf(lat, lon) {
    var pts = [];
    for (var i = 0; i < lat.length; i++) {
      var p = ui.proj([lon[i], lat[i]]);
      if (p) pts.push(p);
    }
    return pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join('');
  }

  function subTrack(s, s0, s1) {
    var r = resample(s, s0, s1, Math.max(8, Math.round((s1 - s0) / 40)));
    return { lat: Array.prototype.slice.call(r.lat), lon: Array.prototype.slice.call(r.lon) };
  }

  function drawOverlay() {
    ui.gMatch.selectAll('*').remove();
    ui.gQuery.selectAll('*').remove();
    // 似た台風
    state.results.forEach(function (r, i) {
      var s = r.storm, on = state.focus === s.sid;
      var g = ui.gMatch.append('g').attr('class', 'match' + (on ? ' on' : '') + (state.focus && !on ? ' dim' : ''));
      g.append('path').attr('class', 'm-full').attr('d', lineOf(s.lat, s.lon));
      if (state.mode === 'part' && r.s1 - r.s0 < s.sim.len - 1) {
        var sub = subTrack(s.sim, r.s0, r.s1);
        g.append('path').attr('class', 'm-part').attr('d', lineOf(sub.lat, sub.lon));
      }
      var e = ui.proj([s.lon[s.lon.length - 1], s.lat[s.lat.length - 1]]);
      if (e) {
        g.append('circle').attr('class', 'm-end').attr('cx', e[0]).attr('cy', e[1]).attr('r', 8);
        g.append('text').attr('class', 'm-num').attr('x', e[0]).attr('y', e[1] + 3.5).attr('text-anchor', 'middle').text(i + 1);
      }
      g.append('title').text((i + 1) + '. ' + title(s.name) + ' (' + s.year + ') · mean gap ' + km(r.gap));
      g.on('mouseenter', function () { setFocus(s.sid, true); }).on('mouseleave', function () { setFocus(null, true); })
        .on('click', function (ev) { ev.stopPropagation(); setFocus(state.focus === s.sid ? null : s.sid); });
    });
    // 基準の台風／描いた経路
    var q = queryTrack();
    if (q) {
      ui.gQuery.append('path').attr('class', 'q-halo').attr('d', lineOf(q.lat, q.lon));
      if (state.query.kind === 'storm') {
        for (var i = 1; i < q.lat.length; i++) {
          var a = ui.proj([q.lon[i - 1], q.lat[i - 1]]), b = ui.proj([q.lon[i], q.lat[i]]);
          if (!a || !b) continue;
          ui.gQuery.append('line').attr('class', 'q-seg').attr('x1', a[0]).attr('y1', a[1]).attr('x2', b[0]).attr('y2', b[1])
            .attr('stroke', catOf(q.wind[i]).color);
        }
        var st = ui.proj([q.lon[0], q.lat[0]]);
        if (st) ui.gQuery.append('circle').attr('class', 'q-start').attr('cx', st[0]).attr('cy', st[1]).attr('r', 4);
      } else {
        ui.gQuery.append('path').attr('class', 'q-drawn').attr('d', lineOf(q.lat, q.lon));
      }
    }
  }

  function setFocus(sid, hoverOnly) {
    if (!hoverOnly) state.focus = sid;
    var f = hoverOnly ? (sid || state.focus) : state.focus;
    ui.gMatch.selectAll('g.match').each(function (d, i) {
      var s = state.results[i] && state.results[i].storm;
      d3.select(this).classed('on', s && s.sid === f).classed('dim', !!f && !(s && s.sid === f));
    });
    Array.prototype.forEach.call(ui.list.children, function (li, i) {
      var s = state.results[i] && state.results[i].storm;
      li.classList.toggle('on', !!s && s.sid === f);
    });
    if (!hoverOnly) renderDetail();
  }

  // ---------- drawing a path ----------
  function onDrawStart(ev) {
    if (!state.drawing) return;
    ev.preventDefault();
    ui.drawPts = [d3.pointer(ev, ui.svg.node())];
    ui.gDraw.selectAll('*').remove();
    ui.drawPath = ui.gDraw.append('path').attr('class', 'q-drawn live');
  }
  function onDrawMove(ev) {
    if (!state.drawing || !ui.drawPts) return;
    var p = d3.pointer(ev, ui.svg.node()), last = ui.drawPts[ui.drawPts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 4) return;
    ui.drawPts.push(p);
    ui.drawPath.attr('d', 'M' + ui.drawPts.map(function (q) { return q.join(','); }).join('L'));
  }
  function onDrawEnd() {
    if (!state.drawing || !ui.drawPts) return;
    var px = ui.drawPts;
    ui.drawPts = null;
    ui.gDraw.selectAll('*').remove();
    var ll = px.map(function (p) { return ui.proj.invert(p); }).filter(Boolean);
    if (ll.length < 2) return;
    var lat = ll.map(function (p) { return p[1]; });
    var lon = ll.map(function (p) { var x = p[0]; return x < 0 ? x + 360 : x; });
    var tr = prepareTrack(lat, lon);
    if (tr.len < 150) { flash('Please draw a longer track (at least 150 km)'); return; }
    tr.doy = NaN;
    state.drawing = false;
    state.query = { kind: 'drawn', track: tr };
    if (state.mode === 'pos') state.mode = 'part';
    state.focus = null;
    runSearch();
  }

  function flash(msg) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(ui.toastT);
    ui.toastT = setTimeout(function () { ui.toast.classList.remove('show'); }, 2400);
  }

  // ---------- year-by-year animation ----------
  // 再生の速さ（1年あたり／似た台風1つあたりのミリ秒）
  var SPEEDS = {
    slow: { label: 'Slow', year: 800, storm: 2400 },
    normal: { label: 'Normal', year: 450, storm: 1500 },
    fast: { label: 'Fast', year: 160, storm: 700 }
  };

  // 似た台風のうち、shown[i] が true のものだけ地図とリストに出す（null ですべて出す）
  function setMatchShown(shown) {
    if (!ui.gMatch) return;
    ui.gMatch.selectAll('g.match').each(function (d, i) {
      d3.select(this).style('display', shown && !shown[i] ? 'none' : null);
    });
    if (ui.list) {
      Array.prototype.forEach.call(ui.list.children, function (li, i) {
        if (state.results[i]) li.classList.toggle('pending', !!shown && !shown[i]);
      });
    }
  }

  // 強さの色で区切った経路を描く
  function drawCatTrack(g, s, cls) {
    for (var i = 1; i < s.lat.length; i++) {
      var a = ui.proj([s.lon[i - 1], s.lat[i - 1]]), b = ui.proj([s.lon[i], s.lat[i]]);
      if (!a || !b) continue;
      g.append('line').attr('class', cls).attr('x1', a[0]).attr('y1', a[1]).attr('x2', b[0]).attr('y2', b[1])
        .attr('stroke', catOf(s.wind[i]).color);
    }
  }

  function play() {
    if (state.playing) { stopPlay(); return; }
    state.playing = true;
    state.drawing = false; renderDrawButton();
    if (state.query && state.results.length) playMatches(); else playAll();
    renderPlayButton();
  }

  // 台風を選んでいるとき：似た台風トップ10だけを、発生の古い順に1つずつ出す
  function playMatches() {
    var order = state.results.map(function (r, i) { return { r: r, rank: i }; })
      .sort(function (a, b) { return a.r.storm.start - b.r.storm.start; });
    var shown = state.results.map(function () { return false; });
    drawBase(-1);                       // 背景の全台風は描かない（陸地だけ）
    setMatchShown(shown);
    ui.gPlay.selectAll('*').remove();
    var k = 0;
    var step = function () {
      if (!state.playing) return;
      var o = order[k];
      shown[o.rank] = true;
      setMatchShown(shown);
      ui.gPlay.selectAll('*').remove();
      drawCatTrack(ui.gPlay, o.r.storm, 'play-cat');
      setFocus(o.r.storm.sid, true);
      var s = o.r.storm;
      ui.yearLabel.text(s.year + '   ' + title(s.name) + ' (#' + (o.rank + 1) + ')   Similar typhoon ' + (k + 1) + '/' + order.length);
      k++;
      if (k >= order.length) { anim = setTimeout(stopPlay, SPEEDS[state.speed].storm + 800); return; }
      anim = setTimeout(step, SPEEDS[state.speed].storm);
    };
    anim = setTimeout(step, 400);
  }

  // 何も選んでいないとき：対象の年代の全台風を1年ずつ重ねる
  function playAll() {
    var years = [];
    for (var y = state.fromYear; y <= END_YEAR; y++) years.push(y);
    var i = 0;
    drawBase(state.fromYear - 1);
    var step = function () {
      if (!state.playing) return;
      var y = years[i];
      var now = state.storms.filter(function (s) { return s.year === y; });
      ui.gPlay.selectAll('*').remove();
      now.forEach(function (s) {
        ui.gPlay.append('path').attr('class', 'play-track').attr('stroke', s.cat.color).attr('d', lineOf(s.lat, s.lon));
      });
      if (ui.ctx) {
        ui.ctx.lineWidth = 0.8; ui.ctx.strokeStyle = 'rgba(60,90,130,0.10)';
        now.forEach(function (s) { strokeTrack(ui.ctx, s, 0, s.lat.length - 1); });
      }
      ui.yearLabel.text(y + '   ' + now.length + ' storms');
      i++;
      if (i >= years.length) { anim = setTimeout(stopPlay, 1200); return; }
      anim = setTimeout(step, SPEEDS[state.speed].year);
    };
    anim = setTimeout(step, 200);
  }

  function stopPlay() {
    state.playing = false;
    if (anim) clearTimeout(anim);
    anim = null;
    ui.gPlay.selectAll('*').remove();
    ui.yearLabel.text('');
    setMatchShown(null);
    setFocus(null, true);
    drawBase();
    renderPlayButton();
  }
  function renderPlayButton() {
    ui.playBtn.textContent = state.playing ? '■ Stop'
      : (state.query && state.results.length ? '▶ Play similar typhoons by year' : '▶ Play by year');
  }

  // ---------- layout ----------
  function build() {
    root.textContent = '';
    var head = el('header', 'head');
    head.appendChild(el('p', 'eyebrow', 'Typhoon Track Finder · Historical Tropical Cyclones (IBTrACS)'));
    ui.headline = el('h1', 'headline');
    ui.sub = el('p', 'sub');
    head.appendChild(ui.headline);
    head.appendChild(ui.sub);
    var info = state.dataInfo;
    if (info && info.asOf) {
      head.appendChild(el('p', 'data-note', 'Static snapshot of IBTrACS for this web version (data as of ' + info.asOf + ').'));
    }
    root.appendChild(head);

    root.appendChild(controls());

    var grid = el('div', 'grid');
    var left = el('div', 'left');
    ui.mapWrap = el('div', 'map');
    left.appendChild(ui.mapWrap);
    left.appendChild(legend());
    grid.appendChild(left);
    var side = el('aside', 'side');
    ui.detail = el('div', 'detail');
    side.appendChild(ui.detail);
    side.appendChild(el('h2', 'side-title', 'Most similar'));
    ui.list = el('ol', 'results');
    side.appendChild(ui.list);
    grid.appendChild(side);
    root.appendChild(grid);

    ui.toast = el('div', 'toast');
    root.appendChild(ui.toast);

    root.appendChild(el('p', 'foot',
      'Similarity = each track is resampled to ' + N + ' evenly spaced points along its path, and the distances between matching points are averaged (smaller = more similar). ' +
      '"Crossed Japan" is a rough check of whether the center passed over land near Japan (distance to land 0 km). Intensity uses the JMA scale (10-minute mean wind). ' +
      'Covers typhoons and tropical depressions in the western North Pacific since ' + START_YEAR + '. Data: IBTrACS (NOAA NCEI); coastline: Natural Earth. Created by Manbow Nakajima.'));

    buildMap();
    renderAll();
  }

  function controls() {
    var bar = el('div', 'controls');

    var g1 = el('div', 'ctl search-wrap');
    g1.appendChild(el('span', 'ctl-label', 'Pick a typhoon'));
    var input = el('input', 'search');
    input.type = 'search';
    input.placeholder = 'Name (e.g. Hagibis) or year (e.g. 2019)';
    input.setAttribute('aria-label', 'Search typhoons by name or year');
    ui.sugg = el('ul', 'sugg');
    input.addEventListener('input', function () { suggest(input.value); });
    input.addEventListener('focus', function () { suggest(input.value); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { var f = ui.sugg.querySelector('li'); if (f) f.click(); }
      if (ev.key === 'Escape') ui.sugg.textContent = '';
    });
    document.addEventListener('click', function (ev) { if (!g1.contains(ev.target)) ui.sugg.textContent = ''; });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (ui.sugg.childNodes.length) { ui.sugg.textContent = ''; return; }
      if (state.drawing && !state.query) { state.drawing = false; renderDrawButton(); return; }
      if (state.query) clearAll();
    });
    ui.searchInput = input;
    g1.appendChild(input);
    g1.appendChild(ui.sugg);
    bar.appendChild(g1);

    var pr = el('div', 'ctl');
    pr.appendChild(el('span', 'ctl-label', 'Typhoons that hit Japan hard'));
    var chips = el('div', 'toggle');
    PRESETS.forEach(function (p) {
      var s = findStorm(p[0], p[1]);
      if (!s) return;
      var b = el('button', '', p[2]);
      b.type = 'button';
      b.title = title(p[0]) + ' (' + p[1] + ')';
      b.addEventListener('click', function () { selectStorm(s); });
      chips.appendChild(b);
    });
    pr.appendChild(chips);
    bar.appendChild(pr);

    var row = el('div', 'ctl-row');
    row.appendChild(seg('Compare by', MODES, function () { return state.mode; }, function (v) { state.mode = v; runSearch(); }, 'modeSeg'));
    var opt = el('div', 'ctl');
    opt.appendChild(el('span', 'ctl-label', 'Filter'));
    var line = el('div', 'inline');
    var lab = el('label', 'check');
    var cb = el('input'); cb.type = 'checkbox';
    cb.addEventListener('change', function () { state.sameSeason = cb.checked; runSearch(); });
    lab.appendChild(cb); lab.appendChild(document.createTextNode('Same season only (±30 days)'));
    line.appendChild(lab);
    var sel = el('select');
    [1951, 1971, 1981, 1991, 2001].forEach(function (y) {
      var o = el('option', '', 'Since ' + y); o.value = String(y); sel.appendChild(o);
    });
    sel.setAttribute('aria-label', 'Years to include');
    sel.addEventListener('change', function () { if (state.playing) stopPlay(); state.fromYear = +sel.value; drawBase(); runSearch(); });
    line.appendChild(sel);
    opt.appendChild(line);
    row.appendChild(opt);
    row.appendChild(seg('Map extent', [['auto', 'Auto'], ['japan', 'Around Japan'], ['basin', 'NW Pacific']], function () { return state.extent; },
      function (v) { state.extent = v; buildMap(); }));
    var act = el('div', 'ctl');
    act.appendChild(el('span', 'ctl-label', 'More'));
    var acts = el('div', 'toggle');
    ui.drawBtn = el('button', 'accent', '✎ Draw a track to search');
    ui.drawBtn.type = 'button';
    ui.drawBtn.addEventListener('click', function () {
      if (state.playing) stopPlay();
      state.drawing = !state.drawing;
      renderDrawButton();
      if (state.drawing) flash('Drag on the map to draw a typhoon track');
    });
    acts.appendChild(ui.drawBtn);
    ui.playBtn = el('button', '', '');
    ui.playBtn.type = 'button';
    ui.playBtn.addEventListener('click', play);
    acts.appendChild(ui.playBtn);
    var sp = el('select', 'speed');
    sp.setAttribute('aria-label', 'Playback speed');
    Object.keys(SPEEDS).forEach(function (k) {
      var o = el('option', '', 'Speed: ' + SPEEDS[k].label); o.value = k;
      if (k === state.speed) o.selected = true;
      sp.appendChild(o);
    });
    sp.addEventListener('change', function () { state.speed = sp.value; });
    acts.appendChild(sp);
    ui.clearBtn = el('button', '', '✕ Clear');
    ui.clearBtn.type = 'button';
    ui.clearBtn.title = 'Clear the drawn track and results and start over (Esc also works)';
    ui.clearBtn.addEventListener('click', clearAll);
    acts.appendChild(ui.clearBtn);
    act.appendChild(acts);
    row.appendChild(act);
    bar.appendChild(row);
    renderPlayButton();
    return bar;
  }

  // 描いた経路・選んだ台風・検索結果をすべて消して、最初の状態に戻す
  function clearAll() {
    if (state.playing) stopPlay();
    state.drawing = false;
    state.query = null;
    state.results = [];
    state.focus = null;
    if (ui.drawPts) { ui.drawPts = null; ui.gDraw.selectAll('*').remove(); }
    if (ui.searchInput) ui.searchInput.value = '';
    renderDrawButton();
    if (state.extent === 'auto') { buildMap(); renderHead(); renderDetail(); renderList(); } else renderAll();
  }

  function renderDrawButton() {
    ui.drawBtn.classList.toggle('on', state.drawing);
    ui.drawBtn.textContent = state.drawing ? 'Stop drawing' : '✎ Draw a track to search';
    ui.mapWrap.classList.toggle('drawing', state.drawing);
  }

  function seg(label, opts, get, set, key) {
    var g = el('div', 'ctl');
    g.appendChild(el('span', 'ctl-label', label));
    var t = el('div', 'toggle');
    opts.forEach(function (o) {
      var b = el('button', '', o[1]);
      b.type = 'button';
      b.dataset.v = o[0];
      b.addEventListener('click', function () { set(o[0]); syncSeg(t, get()); });
      t.appendChild(b);
    });
    syncSeg(t, get());
    if (key) ui[key] = { el: t, get: get };
    g.appendChild(t);
    return g;
  }
  function syncSeg(t, v) {
    Array.prototype.forEach.call(t.children, function (b) {
      b.classList.toggle('on', b.dataset.v === v);
      b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
    });
  }

  function legend() {
    var lg = el('div', 'legend');
    CATS.slice().reverse().forEach(function (c) {
      var i = el('span', 'lg-item');
      var sw = el('span', 'sw'); sw.style.background = c.color;
      i.appendChild(sw); i.appendChild(document.createTextNode(c.ja));
      lg.appendChild(i);
    });
    var m = el('span', 'lg-item'); m.appendChild(el('span', 'ln match')); m.appendChild(document.createTextNode('Similar typhoons (number = rank, shown at track end)')); lg.appendChild(m);
    var a = el('span', 'lg-item'); a.appendChild(el('span', 'ln all')); a.appendChild(document.createTextNode('Other typhoons')); lg.appendChild(a);
    return lg;
  }

  function findStorm(name, year) {
    for (var i = 0; i < state.storms.length; i++) {
      var s = state.storms[i];
      if (s.year === year && (s.name || '').toUpperCase() === name) return s;
    }
    return null;
  }

  function suggest(text) {
    ui.sugg.textContent = '';
    var q = (text || '').trim().toUpperCase();
    if (!q) return;
    var isYear = /^\d{4}$/.test(q);
    var hits = state.storms.filter(function (s) {
      return isYear ? s.year === +q : (s.name || '').toUpperCase().indexOf(q) >= 0;
    });
    hits.sort(function (a, b) { return isYear ? a.start - b.start : b.start - a.start; });
    hits.slice(0, 14).forEach(function (s) {
      var li = el('li');
      li.appendChild(el('span', 'sg-name', title(s.name) + ' (' + s.year + ')'));
      li.appendChild(el('span', 'sg-meta', 'Formed ' + fmtMD(s.start) + ' · ' + s.cat.ja + (isFinite(s.minPres) ? ' · ' + s.minPres + ' hPa' : '')));
      li.addEventListener('click', function () { ui.sugg.textContent = ''; ui.searchInput.value = title(s.name) + ' ' + s.year; selectStorm(s); });
      ui.sugg.appendChild(li);
    });
    if (!hits.length) ui.sugg.appendChild(el('li', 'none', 'No matches'));
  }

  function selectStorm(s) {
    if (state.playing) stopPlay();
    state.drawing = false; renderDrawButton();
    state.query = { kind: 'storm', storm: s };
    if (state.mode === 'part') state.mode = 'pos';
    state.focus = null;
    runSearch();
  }

  function runSearch() {
    if (state.playing) stopPlay();
    search();
    if (ui.modeSeg) syncSeg(ui.modeSeg.el, state.mode);
    if (state.extent === 'auto' && ui.mapWrap) { buildMap(); renderHead(); renderDetail(); renderList(); return; }
    renderAll();
  }

  // ---------- render ----------
  function renderAll() {
    renderHead();
    renderDetail();
    renderList();
    drawBase();
    drawOverlay();
  }

  function renderHead() {
    if (ui.playBtn && !state.playing) renderPlayButton();
    var n = state.storms.filter(function (s) { return s.year >= state.fromYear; }).length;
    if (!state.query) {
      ui.headline.textContent = 'Find typhoons that followed a similar track among ' + n.toLocaleString('en-US') + ' storms since ' + state.fromYear;
      ui.sub.textContent = 'Pick a typhoon with the search box or buttons above, or use \"Draw a track to search\" to sketch a path on the map.';
      return;
    }
    var r = state.results;
    var who = state.query.kind === 'storm'
      ? title(state.query.storm.name) + ' (' + state.query.storm.year + ')'
      : 'your drawn track';
    if (!r.length) {
      ui.headline.textContent = 'No typhoons similar to ' + who + ' were found';
      ui.sub.textContent = 'Try loosening the filters or comparing by \"Shape only\".';
      return;
    }
    ui.headline.textContent = 'Most similar to ' + who + ': ' + title(r[0].storm.name) + ' (' + r[0].storm.year + '), mean gap ' + km(r[0].gap);
    var jp = r.filter(function (x) { return x.storm.japan; }).length;
    var base = state.storms.filter(function (s) { return s.year >= state.fromYear; });
    var baseJp = base.filter(function (s) { return s.japan; }).length / Math.max(1, base.length);
    var pres = r.map(function (x) { return x.storm.minPres; }).filter(isFinite).sort(function (a, b) { return a - b; });
    var med = pres.length ? pres[Math.floor(pres.length / 2)] : NaN;
    ui.sub.textContent = jp + ' of the ' + r.length + ' similar typhoons crossed land in Japan (' + Math.round(baseJp * 100) + '% of all storms). ' +
      (isFinite(med) ? 'Median minimum pressure: ' + med + ' hPa. ' : '') + '(Compared against ' + base.length.toLocaleString('en-US') + ' storms since ' + state.fromYear + ' in ' + (state.searchMs || 0) + ' ms)';
  }

  function stormFacts(s) {
    var days = (s.t[s.t.length - 1] - s.t[0]) / 86400000;
    return [
      ['Period', 'From ' + fmtDate(s.start) + ' (' + days.toFixed(1) + ' days)'],
      ['Max wind', isFinite(s.maxWind) ? Math.round(s.maxWind) + ' kt (' + s.cat.ja + ')' : '—'],
      ['Min pressure', isFinite(s.minPres) ? s.minPres + ' hPa' : '—'],
      ['Distance traveled', km(s.len)],
      ['Over land in Japan', s.japan ? 'Yes' : 'No']
    ];
  }

  function renderDetail() {
    ui.detail.textContent = '';
    var s = null, label = 'Reference';
    if (state.focus) {
      state.results.forEach(function (r, i) { if (r.storm.sid === state.focus) { s = r.storm; label = '#' + (i + 1); } });
    }
    if (!s && state.query && state.query.kind === 'storm') s = state.query.storm;
    if (!s) {
      if (state.query && state.query.kind === 'drawn') {
        ui.detail.appendChild(el('p', 'tag', 'Drawn track'));
        ui.detail.appendChild(el('p', 'muted', 'Length ' + km(state.query.track.len) + '. The dotted line is your drawn track; the thick colored segments are the closest sections of each similar typhoon.'));
      } else {
        ui.detail.appendChild(el('p', 'muted', 'Pick a typhoon to see its details here.'));
      }
      return;
    }
    var h = el('div', 'd-head');
    h.appendChild(el('span', 'tag' + (label === 'Reference' ? '' : ' alt'), label));
    h.appendChild(el('span', 'd-name', title(s.name) + ' (' + s.year + ')'));
    ui.detail.appendChild(h);
    var dl = el('dl', 'facts');
    stormFacts(s).forEach(function (f) { dl.appendChild(el('dt', '', f[0])); dl.appendChild(el('dd', '', f[1])); });
    ui.detail.appendChild(dl);
    if (label !== 'Reference' && state.query && state.query.kind === 'storm') {
      var b = el('button', 'ghost small', 'Search using this typhoon');
      b.type = 'button';
      b.addEventListener('click', function () { selectStorm(s); });
      ui.detail.appendChild(b);
    }
  }

  function renderList() {
    ui.list.textContent = '';
    if (!state.results.length) {
      ui.list.appendChild(el('li', 'empty', state.query ? 'No matches' : 'No search yet'));
      return;
    }
    var maxGap = state.results[state.results.length - 1].gap || 1;
    state.results.forEach(function (r, i) {
      var s = r.storm;
      var li = el('li', 'res' + (state.focus === s.sid ? ' on' : ''));
      li.tabIndex = 0;
      li.appendChild(el('span', 'rank', String(i + 1)));
      var mid = el('span', 'r-mid');
      mid.appendChild(el('span', 'r-name', title(s.name) + ' (' + s.year + ')'));
      mid.appendChild(el('span', 'r-meta', 'Formed ' + fmtMD(s.start) + ' · ' + s.cat.ja + (isFinite(s.minPres) ? ' · ' + s.minPres + ' hPa' : '') + (s.japan ? ' · Crossed Japan' : '')));
      li.appendChild(mid);
      var right = el('span', 'r-gap');
      var bar = el('span', 'gapbar');
      var fill = el('span', 'gapfill'); fill.style.width = Math.max(6, 100 - r.gap / maxGap * 70) + '%';
      bar.appendChild(fill);
      right.appendChild(el('span', 'r-km', km(r.gap)));
      right.appendChild(bar);
      li.appendChild(right);
      li.addEventListener('mouseenter', function () { setFocus(s.sid, true); });
      li.addEventListener('mouseleave', function () { setFocus(null, true); });
      li.addEventListener('click', function () { setFocus(state.focus === s.sid ? null : s.sid); });
      li.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') setFocus(state.focus === s.sid ? null : s.sid); });
      ui.list.appendChild(li);
    });
  }

  // ---------- boot (static web build: data from ./data.json) ----------
  function renderError(msg) {
    root.textContent = '';
    root.appendChild(el('p', 'error', msg));
  }

  var DATA_URL = './data.json';
  var FETCH_TIMEOUT_MS = 30000;

  function fetchJson(url, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' while loading ' + url);
      return res.json();
    }).catch(function (err) {
      if (err && err.name === 'AbortError') throw new Error('Timed out loading ' + url);
      throw err;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
      pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':00';
  }

  // data.json: { asOf, storms: [{ a: SID, n: name, y: season, t0: epoch ms, dt: [minutes from t0],
  //   la, lo, w (WMO kt), u (USA kt), p (hPa), d (dist2land km), k (1 = extratropical) }] }
  function expand(json) {
    if (!json || !Array.isArray(json.storms)) throw new Error('data.json has no storms array');
    var meta = [], rows = [];
    json.storms.forEach(function (s) {
      meta.push({ a: s.a, n: s.n, y: s.y });
      for (var i = 0; i < s.dt.length; i++) {
        rows.push({ a: s.a, t: isoOf(s.t0 + s.dt[i] * 60000), y: s.la[i], x: s.lo[i],
          w: s.w[i], u: s.u[i], p: s.p[i], d: s.d[i], k: s.k[i] ? 'ET' : '' });
      }
    });
    return { meta: meta, rows: rows, asOf: json.asOf || '' };
  }

  function boot() {
    if (!window.d3) { renderError('Could not load d3'); return; }
    if (location.protocol === 'file:') { renderError('Open this page over http(s) (e.g. python3 -m http.server), not file://'); return; }
    root.textContent = '';
    var box = el('div', 'loading');
    var msg = el('p', '', 'Loading western North Pacific typhoon tracks…');
    var bar = el('div', 'progress'); var fill = el('div', 'progress-fill'); bar.appendChild(fill);
    box.appendChild(msg); box.appendChild(bar);
    root.appendChild(box);
    fill.style.width = '30%';

    fetchJson(DATA_URL, FETCH_TIMEOUT_MS).then(function (json) {
      fill.style.width = '70%';
      msg.textContent = 'Building tracks…';
      var res = expand(json);
      var b = buildStorms(res.meta, res.rows);
      if (!b.storms.length) throw new Error('No tracks in data.json');
      state.storms = b.storms;
      state.badTime = b.badTime;
      state.failedYears = [];
      state.dataInfo = { source: 'static', asOf: res.asOf };
      build();
      var t, lastW = root.clientWidth;
      window.addEventListener('resize', function () {
        clearTimeout(t);
        t = setTimeout(function () { if (Math.abs(root.clientWidth - lastW) > 8) { lastW = root.clientWidth; buildMap(); } }, 200);
      });
    }).catch(function (err) {
      renderError('Could not load the data: ' + errText(err));
    });
  }

  function reload() { boot(true); }

  // テスト用に計算部分だけ公開（画面の動作には影響しない）
  window.__typhoon = { clearAll: function () { clearAll(); }, reload: function () { boot(true); }, buildQuery: buildQuery, normalize: normalize, parseTime: parseTime, detectSlashOrder: detectSlashOrder, prepareTrack: prepareTrack, compare: compare, buildStorms: buildStorms, inJapan: inJapan, state: state };

  boot();
})();
