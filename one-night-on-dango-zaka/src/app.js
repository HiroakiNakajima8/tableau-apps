/* One Night on Dango-zaka - Chichibu Night Festival (web app)
   Canvas renderer: real-time float motion, live fireworks, twinkling stars,
   timeline scrubbing, auto slow-motion on the slope, click a float to zoom in. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ constants
  var WORLD_W = 1600, Y0 = -10, Y1 = 900, WORLD_H = Y1 - Y0;
  var END_MIN = 430;                       // 18:00 -> 01:10
  var START_AT = 140;                      // open at 20:20
  var FLOAT_COL = { NAKACHIKA: "#c0485a", SHIMOGO: "#a0524f", MIYAJI: "#e0414b", KAMIMACHI: "#4f86e0", NAKAMACHI: "#2fb3b3", MOTOMACHI: "#f08a2c" };
  var FW_COL = { Gold: "#FFC35A", Red: "#FF4A3D", Green: "#5CFF8A", Blue: "#62A8FF", Silver: "#F4F7FF", Purple: "#C77DFF", Orange: "#FF9A3C" };
  var FW_PARTS = [[90, 140, "Fireworks Part 1 - 100 shakudama shells and star mines"],
                  [140, 180, "Fireworks Part 2 - the pyrotechnicians' competition"],
                  [180, 230, "Fireworks Part 3 - rainbow star mines"],
                  [230, 240, "Finale - the Golden Waterfall"]];

  // ------------------------------------------------------------------ state
  var D = null, canvas, ctx, view, dpr = 1, cssW = 0, cssH = 0, s0 = 1;
  var tMin = START_AT, playing = true, speedMode = "auto", curSpeed = 40;
  var cam = { x: WORLD_W / 2, y: (Y0 + Y1) / 2, z: 1 }, camT = { x: WORLD_W / 2, y: (Y0 + Y1) / 2, z: 1 };
  var selected = null, hovered = null, drawnFloats = [];
  var floats = [], floatById = {}, info = {}, staticBack = [], staticFront = [], tpl = {}, smokeRuns = [];
  var bursts = [], spawnAcc = {}, lastWall = 0, wall = 0;
  var spriteCache = {};
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------------ helpers
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function hm(s) { var p = s.split(":"); var m = (+p[0]) * 60 + (+p[1]) - 1080; return m < -60 ? m + 1440 : m; }   // "20:25" -> minutes from 18:00
  function isoMin(s) { var d = s.split(" ")[1] || s.split("T")[1]; return hm(d.slice(0, 5)); }
  function fmtClock(m) { var t = Math.round(m * 60), h = (18 + Math.floor(t / 3600)) % 24, mi = Math.floor(t / 60) % 60, se = t % 60;
    return { hm: (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi, s: (se < 10 ? "0" : "") + se }; }
  function proj(az, alt) { return [800 + (az - 140) * 14.5, 300 + alt * 14.5]; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function hexRgb(h) { h = h.replace("#", ""); return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]; }
  function mixHex(a, b, t) { var A = hexRgb(a), B = hexRgb(b); return "rgb(" + [0, 1, 2].map(function (i) { return Math.round(A[i] + (B[i] - A[i]) * t); }).join(",") + ")"; }
  function rgba(h, a) { var c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }

  function glowSprite(hex) {
    if (spriteCache[hex]) return spriteCache[hex];
    var c = document.createElement("canvas"); c.width = c.height = 64;
    var g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(hex, 1)); gr.addColorStop(0.25, rgba(hex, 0.45)); gr.addColorStop(1, rgba(hex, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return (spriteCache[hex] = c);
  }

  // ------------------------------------------------------------------ data loading
  function loadData() {
    if (window.DANGO_DATA) return Promise.resolve(window.DANGO_DATA);   // Tableau Studio package: data bundled as src/data.js
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    return fetch("./data.json", ctrl ? { signal: ctrl.signal } : {}).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error("data.json: HTTP " + res.status);
      return res.json();
    });
  }

  function buildPath(polys) {   // polys: list of flat coordinate arrays
    var p = new Path2D();
    for (var i = 0; i < polys.length; i++) {
      var a = polys[i]; p.moveTo(a[0], a[1]);
      for (var j = 2; j < a.length; j += 2) p.lineTo(a[j], a[j + 1]);
      p.closePath();
    }
    return p;
  }
  function staticRuns(list) {   // consecutive polygons of the same colour -> one Path2D
    var runs = [], cur = null;
    list.forEach(function (it) {
      if (!cur || cur.c !== it[0]) { cur = { c: it[0], polys: [] }; runs.push(cur); }
      cur.polys.push(it[1]);
    });
    return runs.map(function (r) { return { fill: D.palette[r.c], path: buildPath(r.polys) }; });
  }

  function prepare() {
    staticBack = staticRuns(D.back);
    staticFront = staticRuns(D.front);
    Object.keys(D.floatTemplates).forEach(function (k) {
      var t = D.floatTemplates[k];
      tpl[k] = { runs: t.runs.map(function (r) { return { fill: D.palette[r[0]], path: buildPath(r[1]) }; }), lights: t.lights, bbox: t.bbox };
    });
    smokeRuns = D.smoke.map(function (r) { return { fill: D.palette[r[0]], path: buildPath(r[1]) }; });
    D.floatInfo.forEach(function (r) { info[r.Float_ID] = r; });
    floats = D.floats.map(function (f) {
      var o = { id: f.id, order: f.order, short: f.short, type: f.type, scale: f.scale, climb: hm(f.climb), descend: hm(f.descend) };
      floatById[f.id] = o; return o;
    });
    D.events.forEach(function (e) { e.s = isoMin(e.Start); e.e = isoMin(e.End); });
  }

  // ------------------------------------------------------------------ float motion (same rules as the Tableau version)
  var FOOT, TOP, SLOPE, SLOTS;
  function pose(f, t) {
    var m = t - f.climb, md = t - f.descend, s = SLOTS[f.id], u;
    if (m < -12) return null;
    if (m < 0) { u = clamp((m + 12) / 12, 0, 1); return [lerp(-180, FOOT[0], u), FOOT[1], 0, true, 1]; }
    if (m < 6) { u = clamp(m / 6, 0, 1); return [lerp(FOOT[0], TOP[0], u), lerp(FOOT[1], TOP[1], u), SLOPE, true, 1]; }
    if (md < 0) { u = clamp((m - 6) / 6, 0, 1); return [lerp(TOP[0], s[0], u), lerp(TOP[1], s[1], u), 0, m < 12, lerp(1, s[2], u)]; }
    if (md < 4) { u = clamp(md / 4, 0, 1); return [lerp(s[0], TOP[0], u), lerp(s[1], TOP[1] - 12, u), Math.PI, true, lerp(s[2], 1, u)]; }
    if (md < 10) { u = clamp((md - 4) / 6, 0, 1); return [lerp(TOP[0], FOOT[0], u), lerp(TOP[1] - 12, FOOT[1] - 12, u), SLOPE + Math.PI, true, 1]; }
    if (md < 18) { u = clamp((md - 10) / 8, 0, 1); return [lerp(FOOT[0], -220, u), FOOT[1] - 12, Math.PI, true, 1]; }
    return null;
  }
  function onSlope(f, t) { var m = t - f.climb, md = t - f.descend; return (m >= -0.5 && m < 6.2) || (md >= 3.5 && md < 10.2); }

  function floatPlacement(f, t) {
    var p = pose(f, t); if (!p) return null;
    var flip = p[2] >= Math.PI / 2, a = flip ? p[2] - Math.PI : p[2], sc = (flip ? -1 : 1) * p[4];
    return { f: f, x: p[0], y: p[1], a: a, sc: sc, moving: p[3], ds: p[4],
             tid: "FLOAT_" + f.id + "_" + (p[3] ? "MOVE" : "PARK") };
  }

  // ------------------------------------------------------------------ time, speed, captions
  function part(t) { for (var i = 0; i < FW_PARTS.length; i++) if (t >= FW_PARTS[i][0] && t < FW_PARTS[i][1]) return i + 1; return 0; }
  function autoSpeed(t) {
    for (var i = 0; i < floats.length; i++) if (onSlope(floats[i], t)) return 8;
    for (i = 0; i < floats.length; i++) { var m = t - floats[i].climb; if (m >= -3 && m < -0.5) return 20; }
    if (t > 252 && t < 378) return 240;      // Saijosai ritual: the floats rest
    return 40;
  }
  function caption(t) {
    for (var i = 0; i < floats.length; i++) {
      var f = floats[i], m = t - f.climb, md = t - f.descend;
      if (m >= 0 && m < 6) return "<b>" + info[f.id].Name_EN + "</b> climbs Dango-zaka";
      if (md >= 4 && md < 10) return "<b>" + info[f.id].Name_EN + "</b> descends Dango-zaka";
    }
    var p = part(t);
    if (p) return FW_PARTS[p - 1][2];
    if (t < 60) return "The shrine procession sets off from Chichibu Shrine";
    if (t < 90) return "Six floats leave the shrine - always in the same order";
    if (t < 375) return "Saijosai ritual at the Otabisho - the six floats rest side by side";
    return "After midnight the floats descend Dango-zaka and head home";
  }

  // ------------------------------------------------------------------ fireworks (particle physics, wall-clock)
  var FIB = {};
  function fib(n) {
    if (FIB[n]) return FIB[n];
    var a = [];
    for (var i = 0; i < n; i++) { var z = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - z * z), th = Math.PI * (3 - Math.sqrt(5)) * i; a.push([r * Math.cos(th), r * Math.sin(th)]); }
    return (FIB[n] = a);
  }
  var KIND = {
    KIKU: { R: 100, g: 38, n: 64, tail: 0.55, w: 1.5, life: 3.2 },
    BOTAN: { R: 90, g: 30, n: 72, tail: 0.05, w: 1, life: 2.6 },
    KAMURO: { R: 110, g: 60, n: 56, tail: 1.6, w: 1.9, life: 4.6 },
    MINE: { R: 34, g: 30, n: 26, tail: 0.35, w: 1.2, life: 1.8 }
  };
  function addBurst(kind, color, color2, x, y, scale, delay, rise) {
    var K = KIND[kind], k = 1.7, v0 = K.R * k / (1 - Math.exp(-k * 1.6));
    var ps = fib(K.n).map(function (d) { var j = 1 + rnd(-0.06, 0.06); return [d[0] * v0 * j, d[1] * v0 * j]; });
    var ps2 = (kind === "KIKU" && color2) ? fib(28).map(function (d) { return [d[0] * v0 * 0.45, d[1] * v0 * 0.45]; }) : null;
    bursts.push({ kind: kind, K: K, k: k, c: FW_COL[color], c2: color2 ? FW_COL[color2] : null, x: x, y: y, sc: scale,
                  t0: wall + delay + rise, rise: rise, launch: wall + delay, ps: ps, ps2: ps2,
                  lx: x + rnd(-14, 14), ly: proj(0, 2.2)[1] });
  }
  function fwXY(lo, hi) { return proj(rnd(100, 133), rnd(lo, hi)); }
  var COLS = Object.keys(FW_COL);
  function spawn(dt, p) {
    function every(key, sec, fn) { spawnAcc[key] = (spawnAcc[key] || 0) + dt; while (spawnAcc[key] >= sec) { spawnAcc[key] -= sec * rnd(0.7, 1.3); fn(); } }
    if (p === 1) {
      every("p1k", 0.95, function () { var q = fwXY(14, 24); addBurst("KIKU", pick(["Gold", "Silver", "Gold", "Red"]), pick(["Green", "Red", "Silver"]), q[0], q[1], rnd(0.9, 1.15), 0, 0.9); });
      every("p1m", 2.6, function () { for (var b = 0; b < 5; b++) { var q = fwXY(7, 12); addBurst("MINE", pick(["Gold", "Silver"]), null, q[0], q[1], rnd(0.8, 1.2), b * 0.08, 0.3); } });
    } else if (p === 2) {
      every("p2k", 0.75, function () { var kind = pick(["KIKU", "BOTAN", "KIKU"]), q = fwXY(12, 24); addBurst(kind, pick(COLS), kind === "KIKU" ? pick(COLS) : null, q[0], q[1], rnd(0.8, 1.2), 0, 0.9); });
    } else if (p === 3) {
      every("p3r", 2.3, function () { var row = ["Red", "Orange", "Gold", "Green", "Blue", "Purple", "Silver", "Red", "Green"];
        for (var b = 0; b < 9; b++) { var q = proj(101 + b * 3.6 + rnd(-1, 1), rnd(8, 14)); addBurst("MINE", row[b], null, q[0], q[1], rnd(1.0, 1.5), b * 0.07, 0.35); } });
      every("p3k", 1.4, function () { var q = fwXY(17, 24); addBurst("KIKU", pick(COLS), pick(COLS), q[0], q[1], 1.1, 0, 0.9); });
    } else if (p === 4) {
      every("p4", 1.3, function () { for (var b = 0; b < 8; b++) { var q = proj(99 + b * 4.6, rnd(16, 21)); addBurst("KAMURO", "Gold", null, q[0], q[1], rnd(0.9, 1.15), b * 0.06, 0.9); } });
    }
  }
  function traj(b, vx, vy, t) { var k = b.k, e = (1 - Math.exp(-k * t)) / k; return [vx * e, vy * e - (b.K.g / k) * (t - e)]; }

  function drawFireworks() {
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    var alive = [];
    for (var i = 0; i < bursts.length; i++) {
      var b = bursts[i], age = wall - b.t0;
      if (age > b.K.life) continue;
      alive.push(b);
      if (wall < b.launch) continue;
      if (age < 0) {                 // rising shell
        var u = 1 - (-age) / b.rise, rx = lerp(b.lx, b.x, u), ry = lerp(b.ly, b.y, Math.sqrt(u));
        ctx.strokeStyle = "rgba(255,217,160,0.55)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(rx, ry - 26); ctx.lineTo(rx, ry); ctx.stroke();
        ctx.fillStyle = "rgba(255,236,200,0.9)"; ctx.beginPath(); ctx.arc(rx, ry, 1.6, 0, 6.283); ctx.fill();
        continue;
      }
      var life = b.K.life, fade = age < life * 0.55 ? 1 : 1 - (age - life * 0.55) / (life * 0.45);
      if (age < 0.5) {               // flash lighting the sky
        var fl = (0.5 - age) / 0.5, R = b.K.R * b.sc * 2.4;
        ctx.globalAlpha = 0.35 * fl; ctx.drawImage(glowSprite(b.c), b.x - R, b.y - R, 2 * R, 2 * R);
      }
      ctx.save(); ctx.translate(b.x, b.y); ctx.scale(b.sc, b.sc);
      drawSparks(b, b.ps, age, b.c, fade, b.K.tail * (1 + age * 0.25), b.K.w);
      if (b.ps2 && age < life * 0.8) drawSparks(b, b.ps2, age, b.c2, fade, 0.3, 1.2);
      ctx.restore();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    bursts = alive;
  }
  function drawSparks(b, ps, age, col, fade, tail, w) {
    var head = mixHex(col, "#FFFFFF", Math.max(0, 0.55 - age * 0.4)), dots = b.kind === "BOTAN";
    var ember = age > b.K.life * 0.5;
    ctx.strokeStyle = col; ctx.fillStyle = head;
    ctx.globalAlpha = 0.85 * fade * (ember ? 0.75 : 1);
    ctx.lineWidth = w;
    if (!dots) {
      ctx.beginPath();
      for (var i = 0; i < ps.length; i++) {
        var vx = ps[i][0], vy = ps[i][1];
        for (var s = 0; s <= 5; s++) {
          var tt = Math.max(0, age - tail) + (Math.min(age, tail)) * s / 5, q = traj(b, vx, vy, tt);
          if (s === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]);
        }
      }
      ctx.stroke();
    }
    if (age < b.K.life * 0.75) {
      ctx.globalAlpha = fade;
      ctx.beginPath();
      var r = dots ? 2.6 * fade + 0.6 : 1.7 * fade + 0.3;
      for (i = 0; i < ps.length; i++) { var h = traj(b, ps[i][0], ps[i][1], age); ctx.moveTo(h[0] + r, h[1]); ctx.arc(h[0], h[1], r, 0, 6.283); }
      ctx.fill();
    }
  }

  // ------------------------------------------------------------------ drawing
  function worldTransform() {
    var k = s0 * cam.z * dpr;
    ctx.setTransform(k, 0, 0, -k, dpr * (cssW / 2) - cam.x * k, dpr * (cssH / 2) + cam.y * k);
  }
  function toScreen(x, y) { var k = s0 * cam.z; return [cssW / 2 + (x - cam.x) * k, cssH / 2 - (y - cam.y) * k]; }
  function toWorld(sx, sy) { var k = s0 * cam.z; return [cam.x + (sx - cssW / 2) / k, cam.y - (sy - cssH / 2) / k]; }

  function drawRuns(runs) { for (var i = 0; i < runs.length; i++) { ctx.fillStyle = runs[i].fill; ctx.fill(runs[i].path); } }

  function drawStars(t) {
    var L = D.stars.list, st = t / D.stars.stepMin, i0 = Math.floor(st), f = st - i0, labels = [];
    for (var i = 0; i < L.length; i++) {
      var s = L[i], a = s.p[i0], b = s.p[i0 + 1];
      if (!a && !b) continue;
      if (!a) a = b; if (!b) b = a;
      var x = lerp(a[0], b[0], f), y = lerp(a[1], b[1], f), m = lerp(a[3], b[3], f);
      var bright = clamp((5.4 - m) / 5.9, 0, 1), rr = 0.8 + 2.8 * Math.pow(bright, 1.5);
      var tw = 0.72 + 0.28 * Math.sin(wall * (1.3 + (i % 7) * 0.37) + i * 2.1);
      var alpha = (0.3 + 0.7 * bright) * (bright > 0.6 ? 0.85 + 0.15 * tw : tw);
      if (m < 1.8) { ctx.globalAlpha = 0.35 * tw; var R = rr * 4.5; ctx.drawImage(glowSprite(s.c), x - R, y - R, 2 * R, 2 * R);
        ctx.globalAlpha = 0.5 * tw; ctx.fillStyle = s.c; ctx.fillRect(x - rr * 2.6, y - 0.12, rr * 5.2, 0.24); ctx.fillRect(x - 0.12, y - rr * 2.6, 0.24, rr * 5.2); }
      ctx.globalAlpha = alpha; ctx.fillStyle = s.c;
      ctx.beginPath(); ctx.arc(x, y, rr * 0.75, 0, 6.283); ctx.fill();
      if (s.n) labels.push([x, y, s.n]);
    }
    ctx.globalAlpha = 1;
    return labels;
  }

  function drawSmoke(t) {
    var since = t - 90;
    if (since <= 0 || since >= 260) return;
    var s = Math.min(1, since / 60) * Math.max(0, 1 - Math.max(0, since - 160) / 100);
    if (s < 0.05) return;
    var c = proj(118, 8), sc = 0.4 + 0.8 * s;
    ctx.save(); ctx.translate(c[0] + Math.sin(wall * 0.05) * 25, c[1]); ctx.scale(sc, sc);
    ctx.globalAlpha = 0.9; drawRuns(smokeRuns); ctx.restore(); ctx.globalAlpha = 1;
  }

  function drawFloats(t) {
    var list = [];
    floats.forEach(function (f) { var p = floatPlacement(f, t); if (p) list.push(p); });
    list.sort(function (a, b) { return (a.moving - b.moving) || (b.y - a.y) || (a.f.order - b.f.order); });
    drawnFloats = list;
    list.forEach(function (p) {
      var T = tpl[p.tid];
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.scale(p.sc, Math.abs(p.sc));
      drawRuns(T.runs);
      // lantern light: additive glow, gentle flicker; the far back row glows less
      var far = Math.abs(p.sc) < 0.8, base = far ? 0.10 : 0.24, L = T.lights, spr = glowSprite("#FFB860");
      ctx.globalCompositeOperation = "lighter";
      for (var i = 0; i < L.length; i += 3) {
        var fl = 0.8 + 0.2 * Math.sin(wall * 7.3 + i * 1.7) * Math.sin(wall * 3.1 + i);
        var R = L[i + 2] * 4.2; ctx.globalAlpha = base * fl;
        ctx.drawImage(spr, L[i] - R, L[i + 1] - R, 2 * R, 2 * R);
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
      ctx.restore();
    });
  }

  function textScreen(txt, x, y, font, col, align, shadow) {
    var q = toScreen(x, y);
    ctx.font = font; ctx.fillStyle = col; ctx.textAlign = align || "center"; ctx.textBaseline = "middle";
    if (shadow) { ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 6; }
    ctx.fillText(txt, q[0], q[1]); ctx.shadowBlur = 0;
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#05060f"; ctx.fillRect(0, 0, cssW, cssH);
    worldTransform();
    drawRuns(staticBack);
    var starLabels = drawStars(tMin);
    drawSmoke(tMin);
    drawFireworks();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var fs = Math.max(9, 11 * s0 * Math.sqrt(cam.z));
    starLabels.forEach(function (l) { textScreen(l[2], l[0] + 10, l[1] - 12, fs + "px sans-serif", "rgba(170,176,214,.75)", "left"); });
    worldTransform();
    drawRuns(staticFront);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    D.labels.forEach(function (l) { textScreen(l[2], l[0], l[1], fs + "px sans-serif", "#8e93b8"); });   // behind the floats
    worldTransform();
    drawFloats(tMin);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawnFloats.forEach(function (p) {
      var ly = p.y + (p.f.type === "Kasaboko" ? 300 : 225) * p.f.scale * p.ds;
      var on = selected === p.f || hovered === p.f;
      textScreen(p.f.short, p.x, ly, (on ? "600 " : "") + Math.max(10, 13 * s0 * Math.sqrt(cam.z)) + "px sans-serif", on ? "#fff" : "#ffe3a3", "center", true);
    });
  }

  // ------------------------------------------------------------------ camera
  function updateCamera(dt) {
    if (selected) {
      var p = drawnFloats.filter(function (q) { return q.f === selected; })[0];
      if (p) { var h = tpl[p.tid].bbox[3] * Math.abs(p.sc); camT.z = 1.75; camT.x = p.x; camT.y = p.y + h * 0.5; }
      else { camT.z = 1; camT.x = WORLD_W / 2; camT.y = (Y0 + Y1) / 2; }
    } else { camT.z = 1; camT.x = WORLD_W / 2; camT.y = (Y0 + Y1) / 2; }
    var k = 1 - Math.exp(-dt * 3.2);
    cam.z = lerp(cam.z, camT.z, k);
    // shift the target left a little so the card on the right does not cover the float
    var tx = camT.x + (selected && camT.z > 1.5 ? 0.18 * WORLD_W / camT.z : 0);
    cam.x = lerp(cam.x, tx, k); cam.y = lerp(cam.y, camT.y, k);
    var hw = WORLD_W / 2 / cam.z, hh = WORLD_H / 2 / cam.z;
    cam.x = clamp(cam.x, hw, WORLD_W - hw); cam.y = clamp(cam.y, Y0 + hh, Y1 - hh);
  }

  // ------------------------------------------------------------------ UI
  function setTime(m) { tMin = clamp(m, 0, END_MIN); }
  function updateHud() {
    var c = fmtClock(tMin);
    $("clock").innerHTML = c.hm + "<small>:" + c.s + "</small>";
    $("caption").innerHTML = caption(tMin);
    var b = $("speedBadge"), sp = Math.round(curSpeed);
    var slow = speedMode === "auto" && curSpeed < 12;
    b.className = slow ? "slow" : "";
    b.textContent = !playing ? "Paused" : speedMode === "auto" ? (slow ? "Slow motion on the slope  ×" + sp : "Auto  ×" + sp) : "×" + sp;
    var pct = tMin / END_MIN * 100;
    $("tlHead").style.left = pct + "%";
    if (selected) cardStatus();
  }

  function buildTimeline() {
    var tr = $("tlTrack"), html = "";
    function pc(m) { return (m / END_MIN * 100).toFixed(3) + "%"; }
    var lanes = { Climb: 22, Procession: 40, Ritual: 40, Fireworks: 54 };
    var colors = { Procession: "#C9A227", Ritual: "#8C7AE6", Fireworks: "#FF6F61" };
    html += '<div class="tl-lane" style="top:22px"><span class="tl-lname">Floats</span></div>';
    html += '<div class="tl-lane" style="top:39px"><span class="tl-lname">Shrine</span></div>';
    html += '<div class="tl-lane" style="top:53px"><span class="tl-lname">Fireworks</span></div>';
    D.events.forEach(function (e, i) {
      if (e.Category === "Climb" || e.Category === "Descend") {
        var f = floatById[e.Float_ID], col = FLOAT_COL[e.Float_ID];
        html += '<div class="tl-mark' + (e.Category === "Descend" ? " desc" : "") + '" style="left:' + pc(e.s) + ';top:' + lanes.Climb + 'px;background:' + col + '"></div>';
        if (e.Category === "Climb") html += '<div class="tl-mlabel" style="left:' + pc(e.s) + ';top:' + (f.order % 2 ? 0 : 10) + 'px">' + f.short + "</div>";
      } else {
        var a = e.s, b = Math.max(e.e, e.s + 3);
        html += '<div class="tl-seg" style="left:' + pc(a) + ";width:" + ((b - a) / END_MIN * 100).toFixed(3) + "%;top:" + lanes[e.Category] + "px;height:10px;background:" + colors[e.Category] + (e.Category === "Fireworks" ? ";opacity:" + (0.55 + 0.12 * (i % 4)) : "") + '"></div>';
      }
    });
    html += '<div class="tl-axis"></div>';
    for (var h = 0; h <= 7; h++) { var m = h * 60; html += '<div class="tl-tick" style="left:' + pc(m) + '"></div><div class="tl-tlabel" style="left:' + pc(m) + '">' + fmtClock(m).hm + "</div>"; }
    tr.innerHTML = html;

    var tl = $("timeline"), tip = $("tlTip"), dragging = false;
    function mAt(ev) { var r = tl.getBoundingClientRect(); return clamp((ev.clientX - r.left) / r.width, 0, 1) * END_MIN; }
    function evAt(m) {
      var best = null;
      D.events.forEach(function (e) { var b = Math.max(e.e, e.s + 6); if (m >= e.s - 2 && m <= b) { if (!best || (e.Category === "Climb" || e.Category === "Descend")) best = e; } });
      return best;
    }
    tl.addEventListener("pointerdown", function (ev) { dragging = true; tl.setPointerCapture(ev.pointerId); setTime(mAt(ev)); bursts = []; });
    tl.addEventListener("pointermove", function (ev) {
      var m = mAt(ev), e = evAt(m);
      tip.textContent = fmtClock(m).hm + (e ? "  ·  " + e.Event_EN : "");
      tip.style.left = (m / END_MIN * 100) + "%"; tip.classList.add("on");
      if (dragging) setTime(m);
    });
    tl.addEventListener("pointerup", function () { dragging = false; });
    tl.addEventListener("pointerleave", function () { tip.classList.remove("on"); });
  }

  function buildControls() {
    $("play").addEventListener("click", togglePlay);
    Array.prototype.forEach.call(document.querySelectorAll("#speeds button"), function (b) {
      b.addEventListener("click", function () {
        speedMode = b.getAttribute("data-s");
        Array.prototype.forEach.call(document.querySelectorAll("#speeds button"), function (x) { x.classList.toggle("on", x === b); });
        if (!playing) togglePlay();
      });
    });
    $("nextClimb").addEventListener("click", function () {
      var next = floats.map(function (f) { return f.climb - 1.5; }).filter(function (m) { return m > tMin + 0.5; })[0];
      if (next === undefined) next = floats[0].climb - 1.5;
      setTime(next); bursts = [];
      if (!playing) togglePlay();
    });
    var chips = $("chips");
    floats.forEach(function (f) {
      var b = document.createElement("button");
      b.innerHTML = '<i style="background:' + FLOAT_COL[f.id] + '"></i>' + f.short;
      b.setAttribute("data-id", f.id);
      b.addEventListener("click", function () { select(selected === f ? null : f); });
      chips.appendChild(b);
    });
    $("cardClose").addEventListener("click", function () { select(null); });
    $("cardClimb").addEventListener("click", function () { if (selected) { setTime(selected.climb - 1); bursts = []; if (!playing) togglePlay(); } });
    $("cardDescend").addEventListener("click", function () { if (selected) { setTime(selected.descend + 3); bursts = []; if (!playing) togglePlay(); } });

    canvas.addEventListener("pointermove", function (ev) { hovered = hitFloat(ev); canvas.style.cursor = hovered ? "pointer" : "default"; });
    canvas.addEventListener("pointerleave", function () { hovered = null; });
    canvas.addEventListener("click", function (ev) { var f = hitFloat(ev); select(f || null); });
    window.addEventListener("keydown", function (ev) {
      if (ev.code === "Space") { ev.preventDefault(); togglePlay(); }
      else if (ev.key === "Escape") select(null);
      else if (ev.key === "ArrowRight") setTime(tMin + (ev.shiftKey ? 10 : 1));
      else if (ev.key === "ArrowLeft") setTime(tMin - (ev.shiftKey ? 10 : 1));
    });
  }
  function togglePlay() { playing = !playing; $("play").innerHTML = playing ? "&#10074;&#10074;" : "&#9654;"; }

  function hitFloat(ev) {
    var r = canvas.getBoundingClientRect(), w = toWorld(ev.clientX - r.left, ev.clientY - r.top);
    for (var i = drawnFloats.length - 1; i >= 0; i--) {
      var p = drawnFloats[i], dx = w[0] - p.x, dy = w[1] - p.y, c = Math.cos(p.a), s = Math.sin(p.a);
      var lx = (dx * c + dy * s) / p.sc, ly = (-dx * s + dy * c) / Math.abs(p.sc), bb = tpl[p.tid].bbox, hw = p.f.scale * 100;
      if (lx >= -hw && lx <= hw && ly >= bb[1] - 10 && ly <= bb[3] + 10) return p.f;
    }
    return null;
  }

  function select(f) {
    selected = f;
    Array.prototype.forEach.call(document.querySelectorAll("#chips button"), function (b) { b.classList.toggle("sel", !!f && b.getAttribute("data-id") === f.id); });
    var card = $("card");
    view.classList.toggle("zoomed", !!f);
    if (!f) { card.classList.remove("open"); card.setAttribute("aria-hidden", "true"); return; }
    var r = info[f.id];
    $("cardKicker").textContent = "No. " + f.order + " in the procession · " + r.Type;
    $("cardName").textContent = r.Name_EN;
    var facts = [["Town", r.Town], ["Pulled", r.Days_Pulled], ["Height", r.Height_with_parasol_m ? r.Height_with_parasol_m + " m with parasol" : ""],
                 ["Climbs", r.Climb_Time_Est + " (est.)"], ["Descends", r.Descend_Time_Est + " (est.)"], ["Kabuki 2026", r.Kabuki_Duty_2026 === "Yes" ? "Duty town" : ""]];
    $("cardFacts").innerHTML = facts.filter(function (x) { return x[1]; }).map(function (x) { return "<dt>" + x[0] + "</dt><dd>" + x[1] + "</dd>"; }).join("");
    $("cardDesc").textContent = r.Description_EN;
    $("cardHigh").textContent = r.Highlight_EN;
    $("cardClimb").textContent = "▶ Watch the climb (" + r.Climb_Time_Est + ")";
    $("cardDescend").textContent = "▶ Watch the descent (" + r.Descend_Time_Est + ")";
    cardStatus();
    card.classList.add("open"); card.setAttribute("aria-hidden", "false");
  }
  function cardStatus() {
    var f = selected, m = tMin - f.climb, md = tMin - f.descend, s;
    if (m < -12) s = "Not on stage yet - on its way from the shrine";
    else if (m < 0) s = "Approaching the foot of Dango-zaka";
    else if (m < 6) s = "Climbing Dango-zaka now";
    else if (md < 0) s = "Resting at the Otabisho";
    else if (md < 10) s = "Descending Dango-zaka";
    else if (md < 18) s = "Heading home";
    else s = "Back in its town";
    $("cardStatus").textContent = s;
  }

  // ------------------------------------------------------------------ layout + loop
  function layout() {
    var st = $("stage"), W = st.clientWidth, H = st.clientHeight, asp = WORLD_W / WORLD_H;
    var w = W, h = W / asp; if (h > H) { h = H; w = H * asp; }
    view.style.width = w + "px"; view.style.height = h + "px";
    view.style.left = (W - w) / 2 + "px"; view.style.top = (H - h) / 2 + "px";
    view.style.setProperty("--u", (w / 1600).toFixed(4));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = w; cssH = h; s0 = w / WORLD_W;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }

  function frame(now) {
    now /= 1000;
    var dt = lastWall ? Math.min(0.1, now - lastWall) : 0.016; lastWall = now; wall += dt;
    var target = speedMode === "auto" ? autoSpeed(tMin) : +speedMode;
    curSpeed = lerp(curSpeed, target, 1 - Math.exp(-dt * 2.5));
    if (playing) {
      tMin += dt * curSpeed / 60;
      if (tMin >= END_MIN) { tMin = END_MIN; playing = false; $("play").innerHTML = "&#9654;"; }
    }
    var p = part(tMin);
    if (p) spawn(dt, p);
    updateCamera(dt);
    render();
    updateHud();
    requestAnimationFrame(frame);
  }

  function initTableau() {   // inside Tableau Studio / Desktop the Extensions API is present; on GitHub Pages it is not
    try {
      if (window.tableau && tableau.extensions && tableau.extensions.initializeAsync) return tableau.extensions.initializeAsync().catch(function () {});
    } catch (e) {}
    return Promise.resolve();
  }

  function start() {
    initTableau();
    canvas = $("scene"); ctx = canvas.getContext("2d"); view = $("view");
    layout(); window.addEventListener("resize", layout);
    loadData().then(function (data) {
      D = data;
      FOOT = D.geo.foot; TOP = D.geo.top; SLOTS = D.geo.slots; SLOPE = Math.atan2(TOP[1] - FOOT[1], TOP[0] - FOOT[0]);
      prepare(); buildTimeline(); buildControls();
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) { playing = false; $("play").innerHTML = "&#9654;"; }
      var q = new URLSearchParams(location.search);
      if (q.get("t")) setTime(hm(q.get("t")));
      $("loading").classList.add("hide");
      requestAnimationFrame(frame);
    }).catch(function (err) {
      var l = $("loading"); l.classList.add("err");
      l.textContent = "Could not load the festival data (" + (err && err.message ? err.message : err) + "). Please reload the page.";
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
