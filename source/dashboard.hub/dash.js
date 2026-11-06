/* Dashboard Hub for Unraid */
(function () {
  'use strict';
  var API = '/plugins/dashboard.hub/include/api.php';
  var CH = '/plugins/container.hub/include/api.php';
  var root = document.getElementById('dh');
  if (!root) return;

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dh-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dh-' + k, JSON.stringify(v)); } catch (e) {} }
  };
  var HIST = 60;
  var S = {
    live: null, prev: null, cpu: null, cores: [], net: {}, hist: { cpu: [], mem: [], rx: [], tx: [], gpu: [], gpuw: [] },
    storage: null, system: null, cts: null, stats: null, services: null, checks: {}, svcAuto: false, edit: null,
    energy: null, priceEdit: false
  };

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function csrf() { return typeof csrf_token !== 'undefined' ? csrf_token : ''; }
  function api(action, params) { return $.ajax({ url: API, data: $.extend({ action: action }, params || {}), dataType: 'json', cache: false, timeout: 20000 }); }
  function apiPost(action, params) { return $.ajax({ url: API, method: 'POST', data: $.extend({ action: action, csrf_token: csrf() }, params || {}), dataType: 'json' }); }
  function err(x) { return (x && x.responseJSON && x.responseJSON.error) || (x && x.statusText) || 'Error'; }
  function push(a, v) { a.push(v); if (a.length > HIST) a.shift(); }
  function bytes(b, d) {
    if (b == null || isNaN(b)) return '–';
    var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0;
    while (Math.abs(b) >= 1000 && i < u.length - 1) { b /= 1000; i++; }
    return (i === 0 ? Math.round(b) : b.toFixed(d == null ? (b < 10 ? 1 : 0) : d)) + ' ' + u[i];
  }
  // memory (RAM, VRAM) is counted in powers of 1024 – 24576 MiB is a 24 GB card
  function mem(b, d) {
    if (b == null || isNaN(b)) return '–';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (i === 0 ? Math.round(b) : b.toFixed(d == null ? (b < 10 ? 1 : 0) : d)) + ' ' + u[i];
  }
  function rate(bps) {
    var bits = (bps || 0) * 8, u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'], i = 0;
    while (bits >= 1000 && i < u.length - 1) { bits /= 1000; i++; }
    return (i === 0 ? Math.round(bits) : bits.toFixed(bits < 10 ? 1 : 0)) + ' ' + u[i];
  }
  function pct(v) { return v == null || isNaN(v) ? '–' : Math.round(v) + '%'; }
  function dur(s) {
    s = Math.max(0, Math.round(s));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm';
  }
  function ago(ts) { return ts ? dur(Date.now() / 1000 - ts) + ' ago' : '–'; }
  function lvl(v, warn, crit) { return v == null ? '' : v >= crit ? 'bad' : v >= warn ? 'warn' : 'ok'; }
  function bar(p, cls, label) {
    p = Math.max(0, Math.min(100, p || 0));
    return '<div class="dh-bar ' + (cls || '') + '" role="img" aria-label="' + esc(label || Math.round(p) + '%') + '"><i style="width:' + p.toFixed(1) + '%"></i></div>';
  }
  function spark(data, max, cls, h) {
    h = h || 44;
    if (!data.length) return '<svg class="dh-spark" viewBox="0 0 100 ' + h + '" preserveAspectRatio="none" aria-hidden="true"></svg>';
    max = max || Math.max.apply(null, data.concat([1]));
    // spread the samples over the full width until the history is filled
    var n = Math.max(1, data.length - 1), pts = data.map(function (v, i) {
      var x = data.length < 2 ? 100 : i / n * 100, y = h - 2 - Math.min(1, v / max) * (h - 4);
      return x.toFixed(2) + ',' + y.toFixed(2);
    });
    var first = pts[0].split(',')[0];
    return '<svg class="dh-spark ' + (cls || '') + '" viewBox="0 0 100 ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path class="a" d="M' + first + ',' + h + ' L' + pts.join(' L') + ' L100,' + h + ' Z"/>' +
      '<path class="l" d="M' + pts.join(' L') + '" vector-effect="non-scaling-stroke"/></svg>';
  }
  function money(v, cur) {
    if (v == null || isNaN(v)) return '–';
    var code = { '€': 'EUR', '$': 'USD', '£': 'GBP', 'CHF': 'CHF' }[cur || '€'] || 'EUR';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: v < 10 ? 2 : 0 }).format(v); }
    catch (e) { return v.toFixed(2) + ' ' + (cur || '€'); }
  }
  function kwh(wh) { return wh == null ? '–' : (wh >= 10000 ? (wh / 1000).toFixed(0) : (wh / 1000).toFixed(wh >= 1000 ? 1 : 2)) + ' kWh'; }
  function chip(k, t) { return '<span class="dh-chip ' + (k || '') + '">' + t + '</span>'; }
  function temp(t, warn, crit) {
    if (t == null) return '';
    return chip(lvl(t, warn || 75, crit || 90), I.temp + Math.round(t) + '°C');
  }
  function card(id, title, icon, right, body) {
    return '<div class="dh-ch"><h3>' + icon + '<span>' + esc(title) + '</span></h3><span class="dh-grow"></span>' + (right || '') + '</div>' + body;
  }
  function initials(n) {
    var p = String(n).replace(/^binhex-/i, '').split(/[-_. ]+/).filter(Boolean);
    return (p.length > 1 ? p[0][0] + p[1][0] : String(n).replace(/[^A-Za-z0-9]/g, '').slice(0, 2)).toUpperCase();
  }
  var PAL = ['#2563eb', '#7c3aed', '#0f766e', '#b45309', '#be185d', '#15803d', '#b91c1c', '#0e7490', '#4338ca', '#a16207'];
  function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function avatar(name, icon) {
    // the initials sit underneath; a logo that fails to load simply disappears
    return '<span class="dh-av"><span class="dh-ini" style="background:' + PAL[hash(name) % PAL.length] + '">' + esc(initials(name)) + '</span>' +
      (icon ? '<img src="' + esc(icon) + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>';
  }

  var I = {
    cpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
    mem: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 17v3M12 17v3M17 17v3M7 10v4M11 10v4M15 10v4"/></svg>',
    gpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="9" cy="12" r="3"/><path d="M15 10h3M15 14h3"/></svg>',
    power: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    disk: '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
    net: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v13M3 13l4 4 4-4M17 20V7M13 11l4-4 4 4"/></svg>',
    box: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    svc: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z"/></svg>',
    temp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z"/></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
    ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    vm: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>'
  };

  /* ---------- container helpers (same rules as Container Hub) ---------- */
  function cstatus(c) {
    if (c.paused) return { k: 'warn', t: 'paused' };
    if (c.state === 'restarting') return { k: 'bad', t: 'restarting' };
    if (c.running && c.health === 'unhealthy') return { k: 'bad', t: 'unhealthy' };
    if (c.running) return { k: 'ok', t: 'running' };
    if (c.autostart) return { k: 'bad', t: c.exit ? 'exited with code ' + c.exit : 'not running' };
    return { k: 'off', t: 'stopped' };
  }
  function cicon(name) {
    if (!S.cts) return '';
    for (var i = 0; i < S.cts.length; i++) if (S.cts[i].name === name) return S.cts[i].icon || '';
    return '';
  }

  /* ---------- names ---------- */
  function diskName(d) {
    if (d.name === 'parity') return 'Parity';
    if (/^parity\d+$/.test(d.name)) return 'Parity ' + d.name.slice(6);
    if (/^disk\d+$/.test(d.name)) return 'Disk ' + d.name.slice(4);
    if (d.name === 'flash') return 'Flash (boot)';
    return d.name;
  }
  function diskState(d) {
    var s = d.status || '';
    if (s === 'DISK_OK') return d.spundown ? { k: 'off', t: 'spun down' } : { k: 'ok', t: 'active' };
    if (/DSBL|MISSING|WRONG/.test(s)) return { k: 'bad', t: s.replace('DISK_', '').toLowerCase().replace(/_/g, ' ') };
    if (/INVALID|EMU|NEW/.test(s)) return { k: 'warn', t: s.replace('DISK_', '').toLowerCase().replace(/_/g, ' ') };
    return { k: 'off', t: s.replace('DISK_', '').toLowerCase() || '–' };
  }
  function checkName(a) {
    if (/^check P/.test(a)) return 'Parity check';
    if (/^check/.test(a)) return 'Read check';
    if (/^recon/.test(a)) return 'Parity sync / rebuild';
    if (/^clear/.test(a)) return 'Clearing';
    return 'Array operation';
  }

  /* ---------- attention list ---------- */
  function alerts() {
    var out = [];
    function add(k, t, href) { out.push({ k: k, t: t, href: href || '' }); }
    var st = S.storage, sy = S.system, lv = S.live;
    if (st) {
      if (st.state && st.state !== 'STARTED') add('bad', 'Array is ' + st.state.toLowerCase().replace(/_/g, ' '), '/Main');
      st.disks.forEach(function (d) {
        var ds = diskState(d);
        if (ds.k === 'bad' || ds.k === 'warn') add(ds.k, diskName(d) + ': ' + ds.t, '/Main');
        if (d.errors > 0) add('bad', diskName(d) + ': ' + d.errors + ' read/write errors', '/Main');
        if (d.temp != null && d.temp >= d.hot) add(d.temp >= d.max ? 'bad' : 'warn', diskName(d) + ' is at ' + d.temp + '°C', '/Main');
      });
      pools().forEach(function (p) {
        if (!p.size) return;
        var u = p.used / p.size * 100;
        if (u >= p.warn) add(u >= p.crit ? 'bad' : 'warn', p.label + ' is ' + Math.round(u) + '% full', '/Main');
      });
      if (st.last_check && st.last_check.errors > 0) add('warn', 'Last parity check found ' + st.last_check.errors + ' errors', '/Main');
    }
    if (lv && lv.ups && !/ONLINE/.test(lv.ups.status)) add('bad', 'UPS: ' + lv.ups.status.toLowerCase() + (lv.ups.runtime ? ', ' + Math.round(lv.ups.runtime) + ' min left' : ''), '/Settings/UPSsettings');
    (lv && lv.gpus || []).forEach(function (g) {
      if (g.vendor === 'NVIDIA' && g.temp >= 83) add(g.temp >= 90 ? 'bad' : 'warn', g.name + ' is at ' + Math.round(g.temp) + '°C');
    });
    if (lv && lv.sensors && lv.sensors.cpu >= 85) add(lv.sensors.cpu >= 95 ? 'bad' : 'warn', 'CPU is at ' + Math.round(lv.sensors.cpu) + '°C');
    if (sy && sy.tailscale && sy.tailscale.state && sy.tailscale.state !== 'Running') {
      add('warn', 'Tailscale ' + (sy.tailscale.state === 'NeedsLogin' ? 'is logged out – remote access is down' : 'is ' + sy.tailscale.state.toLowerCase()), '/Settings/Tailscale');
    }
    if (S.cts) {
      var bad = S.cts.filter(function (c) { return cstatus(c).k === 'bad'; });
      if (bad.length) add('bad', bad.length === 1 ? bad[0].name + ' ' + cstatus(bad[0]).t : bad.length + ' containers need attention: ' + bad.slice(0, 3).map(function (c) { return c.name; }).join(', ') + (bad.length > 3 ? ' …' : ''), '/Docker');
    }
    if (S.services) {
      var down = S.services.filter(function (s, i) { var c = S.checks[i]; return c && !c.up; });
      if (down.length) add('bad', (down.length === 1 ? down[0].name + ' is not responding' : down.length + ' services are not responding: ' + down.map(function (s) { return s.name; }).join(', ')));
    }
    if (sy && sy.notifications) {
      sy.notifications.items.forEach(function (n) {
        if (n.importance === 'alert' || n.importance === 'warning') add(n.importance === 'alert' ? 'bad' : 'warn', (n.subject || n.event) + (n.description ? ' – ' + n.description : ''));
      });
    }
    return out;
  }

  /* ---------- storage groups ---------- */
  function pools() {
    var st = S.storage;
    if (!st) return [];
    var map = {}, list = [];
    st.disks.forEach(function (d) {
      if (d.type !== 'Cache') return;
      var p = map[d.pool];
      if (!p) { p = map[d.pool] = { label: d.pool, members: [], size: 0, used: 0, fs: d.fs_type, warn: d.warn, crit: d.crit }; list.push(p); }
      p.members.push(d);
      if (d.fs_size) { p.size = d.fs_size; p.used = d.fs_used; p.fs = d.fs_type || p.fs; }
    });
    return list;
  }

  /* ---------- rendering ---------- */
  function renderShell() {
    root.innerHTML =
      '<div class="dh-head">' +
        '<div class="dh-id"><div class="dh-name" id="dh-name">Server</div><div class="dh-sub" id="dh-sub"></div></div>' +
        '<span class="dh-grow"></span><div class="dh-clock" id="dh-clock"></div>' +
      '</div>' +
      '<div id="dh-alerts" aria-live="polite"></div>' +
      '<div class="dh-grid">' +
        '<section class="dh-card c3" id="dh-cpu" aria-label="Processor"></section>' +
        '<section class="dh-card c3" id="dh-mem" aria-label="Memory"></section>' +
        '<section class="dh-card c3" id="dh-gpu" aria-label="Graphics"></section>' +
        '<section class="dh-card c3" id="dh-power" aria-label="Power"></section>' +
        '<section class="dh-card c12" id="dh-energy" aria-label="GPU energy and cost" hidden></section>' +
        '<section class="dh-card c8" id="dh-storage" aria-label="Storage"></section>' +
        '<section class="dh-card c4" id="dh-net" aria-label="Network"></section>' +
        '<section class="dh-card c6" id="dh-cont" aria-label="Containers and VMs"></section>' +
        '<section class="dh-card c6" id="dh-svc" aria-label="Services"></section>' +
      '</div>' +
      '<div class="dh-modal" id="dh-modal" hidden></div>';
    ['dh-cpu', 'dh-mem', 'dh-gpu', 'dh-power', 'dh-storage', 'dh-net', 'dh-cont', 'dh-svc'].forEach(function (id) {
      document.getElementById(id).innerHTML = '<div class="dh-skel"></div>';
    });
  }

  function renderHead() {
    var sy = S.system, lv = S.live;
    if (sy) {
      $('#dh-name').text(sy.name);
      $('#dh-sub').html(esc([sy.board, 'Unraid ' + sy.version, sy.ip].filter(Boolean).join(' · ')) + (lv ? ' · up ' + esc(dur(lv.uptime)) : ''));
    }
    var now = new Date();
    $('#dh-clock').html('<b>' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</b><span>' + now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + '</span>');
  }

  function renderAlerts() {
    var a = alerts();
    var el = document.getElementById('dh-alerts');
    if (!S.storage || !S.system) { el.innerHTML = ''; return; }
    if (!a.length) { el.innerHTML = '<div class="dh-allgood">' + I.ok + '<span>Everything looks good</span></div>'; return; }
    a.sort(function (x, y) { return (x.k === 'bad' ? 0 : 1) - (y.k === 'bad' ? 0 : 1); });
    el.innerHTML = '<div class="dh-alerts">' + a.map(function (x) {
      var inner = (x.k === 'bad' ? I.warn : I.info) + '<span>' + esc(x.t) + '</span>';
      return x.href ? '<a class="dh-alert ' + x.k + '" href="' + esc(x.href) + '">' + inner + '</a>' : '<div class="dh-alert ' + x.k + '">' + inner + '</div>';
    }).join('') + '</div>';
  }

  function renderCpu() {
    var lv = S.live;
    if (!lv || S.cpu == null) return;
    var t = lv.sensors && lv.sensors.cpu;
    var cores = S.cores.map(function (v, i) {
      return '<i class="' + (v >= 85 ? 'hi' : v >= 50 ? 'mid' : v >= 15 ? 'lo' : '') + '" style="--v:' + Math.max(4, v).toFixed(0) + '%" title="Thread ' + i + ': ' + Math.round(v) + '%"></i>';
    }).join('');
    var model = S.system ? S.system.cpu.replace(/\s*(w\/|with) .*$/i, '').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim() : '';
    $('#dh-cpu').html(card('cpu', 'Processor', I.cpu, temp(t, 80, 90),
      '<div class="dh-big"><b>' + pct(S.cpu) + '</b><span>' + esc(model) + '</span></div>' +
      spark(S.hist.cpu, 100, 'acc') +
      '<div class="dh-cores" aria-label="Load per thread">' + cores + '</div>' +
      '<div class="dh-kv"><span>Load average</span><b>' + lv.load.map(function (x) { return x.toFixed(2); }).join(' · ') + '</b></div>'));
  }

  function renderMem() {
    var lv = S.live;
    if (!lv) return;
    var m = lv.mem, used = m.used / m.total * 100, cache = Math.min(100 - used, m.cache / m.total * 100);
    $('#dh-mem').html(card('mem', 'Memory', I.mem, '',
      '<div class="dh-big"><b>' + pct(used) + '</b><span>' + mem(m.used) + ' of ' + mem(m.total) + ' in use</span></div>' +
      spark(S.hist.mem, 100, 'pur') +
      '<div class="dh-stack" role="img" aria-label="Memory split"><i class="u" style="width:' + used.toFixed(1) + '%"></i><i class="c" style="width:' + cache.toFixed(1) + '%"></i></div>' +
      '<div class="dh-legend"><span><i class="u"></i>Used ' + mem(m.used) + '</span><span><i class="c"></i>Cache ' + mem(m.cache) + '</span><span><i class="f"></i>Free ' + mem(Math.max(0, m.total - m.used - m.cache)) + '</span></div>' +
      (m.swap_total ? '<div class="dh-kv"><span>Swap</span><b>' + mem(m.swap_used) + ' / ' + mem(m.swap_total) + '</b></div>' : '')));
  }

  function renderGpu() {
    var lv = S.live;
    if (!lv) return;
    var g = lv.gpus && lv.gpus[0], s = lv.sensors || {};
    if (!g) {
      $('#dh-gpu').html(card('gpu', 'Temperatures', I.temp, '',
        '<div class="dh-temps">' + (s.nvme || []).map(function (n, i) { return '<div><span>NVMe ' + (i + 1) + '</span>' + temp(n.temp, 60, 70) + '</div>'; }).join('') +
        (s.board || []).slice(0, 4).map(function (b) { return '<div><span>' + esc(b.name) + '</span>' + temp(b.temp, 60, 80) + '</div>'; }).join('') + '</div>'));
      return;
    }
    var vram = g.vram_total ? g.vram_used / g.vram_total * 100 : 0;
    if (g.vendor === 'NVIDIA') {
      var pw = g.power_limit ? g.power / g.power_limit * 100 : 0;
      var others = lv.gpus.slice(1).map(function (o) { return esc((o.name || o.vendor + ' GPU')) + ' ' + pct(o.busy); }).join(' · ');
      var procs = (g.procs || []).slice().sort(function (a, b) { return b.mem - a.mem; });
      $('#dh-gpu').html(card('gpu', g.name, I.gpu, temp(g.temp, 80, 88),
        '<div class="dh-big"><b>' + pct(g.busy) + '</b><span>busy · ' + esc(g.pstate || '') + (g.clock ? ' · ' + Math.round(g.clock) + ' MHz' : '') + '</span></div>' +
        spark(S.hist.gpu, 100, 'teal') +
        '<div class="dh-kv"><span>Power</span><b>' + (g.power != null ? Math.round(g.power) + ' W' : '–') + (g.power_limit ? ' / ' + Math.round(g.power_limit) + ' W' : '') + '</b></div>' + bar(pw, pw >= 90 ? 'bad' : pw >= 60 ? 'acc' : 'ok', 'Power draw') +
        '<div class="dh-kv"><span>Video memory</span><b>' + mem(g.vram_used) + ' / ' + mem(g.vram_total) + '</b></div>' + bar(vram, lvl(vram, 90, 98)) +
        (g.fan != null ? '<div class="dh-kv"><span>Fan</span><b>' + (g.fan ? pct(g.fan) : 'stopped') + '</b></div>' : '') +
        (procs.length ? '<div class="dh-sect">Using the GPU</div>' + procs.map(function (p) {
          return '<div class="dh-gproc"><span class="dh-tn">' + avatar(p.name, cicon(p.name)) + '<span>' + esc(p.name) + '</span></span><b>' + mem(p.mem) + '</b></div>';
        }).join('') : '<div class="dh-kv"><span>Using the GPU</span><b>nothing</b></div>') +
        (others ? '<div class="dh-kv"><span>Also</span><b>' + others + '</b></div>' : '')));
      return;
    }
    $('#dh-gpu').html(card('gpu', 'Graphics', I.gpu, temp(s.gpu, 80, 95),
      '<div class="dh-big"><b>' + pct(g.busy) + '</b><span>' + esc(g.vendor) + ' GPU busy</span></div>' +
      spark(S.hist.gpu, 100, 'teal') +
      '<div class="dh-kv"><span>Video memory</span><b>' + mem(g.vram_used) + ' / ' + mem(g.vram_total) + '</b></div>' + bar(vram, lvl(vram, 80, 95)) +
      (g.gtt_total ? '<div class="dh-kv"><span>Shared memory</span><b>' + mem(g.gtt_used) + '</b></div>' : '') +
      ((s.nvme || []).length ? '<div class="dh-temps sm">' + s.nvme.map(function (n, i) { return '<div><span>NVMe ' + (i + 1) + '</span>' + temp(n.temp, 60, 70) + '</div>'; }).join('') + '</div>' : '')));
  }

  function renderPower() {
    var lv = S.live;
    if (!lv) return;
    var u = lv.ups, s = lv.sensors || {}, body = '';
    if (u) {
      var on = /ONLINE/.test(u.status);
      body += '<div class="dh-big"><b>' + (u.watts != null ? u.watts + ' W' : pct(u.load)) + '</b><span>' + (u.watts != null ? pct(u.load) + ' of ' + u.nominal + ' W UPS capacity' : 'UPS load') + '</span></div>' +
        bar(u.load, lvl(u.load, 70, 90), 'UPS load') +
        '<div class="dh-kv"><span>Battery</span><b>' + pct(u.battery) + '</b></div>' + bar(u.battery, u.battery < 30 ? 'bad' : u.battery < 60 ? 'warn' : 'ok') +
        '<div class="dh-kv"><span>Runtime on battery</span><b>' + (u.runtime != null ? Math.round(u.runtime) + ' min' : '–') + '</b></div>' +
        (u.voltage ? '<div class="dh-kv"><span>Output</span><b>' + Math.round(u.voltage) + ' V</b></div>' : '');
      var right = chip(on ? 'ok' : 'bad', on ? 'On mains' : esc(u.status.toLowerCase()));
    } else {
      body += '<div class="dh-empty">No UPS connected</div>';
    }
    if (s.gpu_power != null) body += '<div class="dh-kv"><span>Processor package</span><b>' + Math.round(s.gpu_power) + ' W</b></div>';
    (lv.gpus || []).forEach(function (g) { if (g.vendor === 'NVIDIA' && g.power != null) body += '<div class="dh-kv"><span>' + esc(g.name) + '</span><b>' + Math.round(g.power) + ' W</b></div>'; });
    $('#dh-power').html(card('power', u ? (u.model || 'UPS') : 'Power', I.power, right || '', body));
  }

  function diskRow(d, label, extra) {
    var ds = diskState(d), use = d.fs_size ? d.fs_used / d.fs_size * 100 : null;
    var t = d.temp != null ? chip(d.temp >= d.max ? 'bad' : d.temp >= d.hot ? 'warn' : '', Math.round(d.temp) + '°C') : (d.spundown ? chip('', I.moon + 'standby') : '');
    return '<div class="dh-disk">' +
      '<span class="dh-dot ' + ds.k + '" title="' + esc(ds.t) + '"></span>' +
      '<span class="dh-dn"><b>' + esc(label || diskName(d)) + '</b><small>' + esc(extra || [d.fs_type, bytes(d.size)].filter(Boolean).join(' · ')) + '</small></span>' +
      '<span class="dh-du">' + (use != null ? bar(use, lvl(use, d.warn, d.crit)) + '<small>' + bytes(d.fs_used) + ' of ' + bytes(d.fs_size) + ' · ' + pct(use) + '</small>' : '<small class="dh-muted">' + (d.type === 'Parity' ? 'protects the data disks' : '–') + '</small>') + '</span>' +
      '<span class="dh-dt">' + t + (d.errors ? chip('bad', d.errors + ' errors') : '') + '</span>' +
    '</div>';
  }

  function renderStorage() {
    var st = S.storage;
    if (!st) return;
    var arr = st.disks.filter(function (d) { return d.type === 'Parity' || d.type === 'Data'; });
    var data = arr.filter(function (d) { return d.type === 'Data'; });
    var tot = data.reduce(function (a, d) { return a + d.fs_size; }, 0), used = data.reduce(function (a, d) { return a + d.fs_used; }, 0);
    var started = st.state === 'STARTED';
    var head = chip(started ? 'ok' : 'bad', started ? 'Array started' : 'Array ' + esc(st.state.toLowerCase()));
    var chk = '';
    if (st.check) {
      var c = st.check, p = c.size ? c.pos / c.size * 100 : 0, sp = c.dt ? c.db / c.dt : 0, eta = sp ? (c.size - c.pos) / sp : 0;
      chk = '<div class="dh-check"><div class="dh-kv"><span><b>' + checkName(c.action) + '</b> · ' + (sp ? (sp / 1e6).toFixed(0) + ' MB/s' : 'paused') + '</span><b>' + p.toFixed(1) + '%' + (eta ? ' · ' + dur(eta) + ' left' : '') + '</b></div>' + bar(p, 'info') + '</div>';
    } else if (st.last_check && st.last_check.date) {
      var lc = st.last_check, okc = String(lc.status) === '0' && !lc.errors;
      chk = '<div class="dh-kv dh-lastcheck"><span>Last parity check</span><b>' + esc(lc.date) + ' · ' + (okc ? 'no errors' : lc.errors ? lc.errors + ' errors' : 'not finished') + (lc.duration ? ' · ' + dur(lc.duration) : '') + '</b></div>';
    }
    var html = '<div class="dh-sumrow"><div><small>Array capacity</small><b>' + bytes(used) + '</b><span>of ' + bytes(tot) + '</span></div>' +
      '<div class="dh-grow">' + bar(tot ? used / tot * 100 : 0, '', 'Array used') + '</div></div>' + chk +
      '<div class="dh-sect">Array</div>' + arr.map(function (d) { return diskRow(d); }).join('');
    var ps = pools();
    if (ps.length) {
      html += '<div class="dh-sect">Pools</div>' + ps.map(function (p) {
        var first = p.members[0], worst = p.members.reduce(function (a, d) { var k = diskState(d).k; return k === 'bad' ? d : (k === 'warn' && diskState(a).k !== 'bad') ? d : a; }, first);
        var mt = p.members.map(function (d) { return d.temp; }).filter(function (x) { return x != null; });
        var view = $.extend({}, worst, { fs_size: p.size, fs_used: p.used, fs_type: p.fs, temp: mt.length ? Math.max.apply(null, mt) : null, errors: p.members.reduce(function (a, d) { return a + d.errors; }, 0) });
        return diskRow(view, p.label, [p.fs, p.members.length > 1 ? p.members.length + ' devices' : bytes(first.size)].filter(Boolean).join(' · '));
      }).join('');
    }
    var fl = st.disks.filter(function (d) { return d.type === 'Flash'; });
    if (fl.length) html += '<div class="dh-sect">Boot</div>' + fl.map(function (d) { return diskRow(d); }).join('');
    $('#dh-storage').html(card('storage', 'Storage', I.disk, head + '<a class="dh-link" href="/Main">Main ' + I.ext + '</a>', html));
  }

  function renderNet() {
    var lv = S.live;
    if (!lv) return;
    var names = Object.keys(S.net);
    if (!names.length) { $('#dh-net').html(card('net', 'Network', I.net, '', '<div class="dh-skel"></div>')); return; }
    var mains = names.filter(function (n) { return n.indexOf('.') < 0 && !/^br/.test(n); });
    var main = mains.sort(function (a, b) { return (S.net[b].rx + S.net[b].tx) - (S.net[a].rx + S.net[a].tx); })[0] || names[0];
    var m = S.net[main];
    var vl = names.filter(function (n) { return n.indexOf(main + '.') === 0; }).map(function (n) { return { n: n, v: S.net[n].rx + S.net[n].tx, rx: S.net[n].rx, tx: S.net[n].tx }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 5);
    var top = vl.length ? vl[0].v || 1 : 1;
    var ts = S.system && S.system.tailscale;
    var tsRow = ts ? '<div class="dh-kv dh-ts"><span>Tailscale</span>' + (ts.state === 'Running'
      ? chip('ok', 'connected') + '<b>' + ts.online + ' / ' + ts.peers + ' devices online</b>'
      : '<a href="/Settings/Tailscale">' + chip('warn', ts.state === 'NeedsLogin' ? 'logged out' : esc(String(ts.state).toLowerCase())) + '</a>') + '</div>' : '';
    $('#dh-net').html(card('net', 'Network', I.net, chip('', esc(main)),
      '<div class="dh-rates"><div><small>↓ Download</small><b>' + rate(m.rx) + '</b></div><div><small>↑ Upload</small><b>' + rate(m.tx) + '</b></div></div>' +
      '<div class="dh-dual">' + spark(S.hist.rx, null, 'acc') + spark(S.hist.tx, null, 'pur') + '</div>' +
      (vl.length ? '<div class="dh-sect">Busiest VLANs right now</div>' + vl.map(function (x) {
        return '<div class="dh-vl"><span>VLAN ' + esc(x.n.split('.').pop()) + '</span>' + bar(x.v / top * 100, 'acc') + '<b>' + rate(x.v) + '</b></div>';
      }).join('') : '') + tsRow));
  }

  function renderCont() {
    var cs = S.cts, sy = S.system, html = '';
    if (!cs) { $('#dh-cont').html(card('cont', 'Containers & VMs', I.box, '', '<div class="dh-skel"></div>')); return; }
    var run = cs.filter(function (c) { return c.running; }).length;
    var bad = cs.filter(function (c) { return cstatus(c).k === 'bad'; });
    var upd = cs.filter(function (c) { return c.update; }).length;
    html += '<div class="dh-kpis">' +
      '<a class="dh-kpi" href="/Docker"><small>Running</small><b>' + run + '</b><span>of ' + cs.length + '</span></a>' +
      '<a class="dh-kpi ' + (bad.length ? 'bad' : '') + '" href="/Docker"><small>Need attention</small><b>' + bad.length + '</b><span>' + (bad.length ? esc(bad.slice(0, 2).map(function (c) { return c.name; }).join(', ')) : 'all good') + '</span></a>' +
      '<a class="dh-kpi ' + (upd ? 'upd' : '') + '" href="/Docker"><small>Updates</small><b>' + upd + '</b><span>' + (upd ? 'available' : 'up to date') + '</span></a>' +
    '</div>';
    if (S.stats) {
      var arr = Object.keys(S.stats).map(function (n) { return $.extend({ name: n }, S.stats[n]); });
      var byCpu = arr.slice().sort(function (a, b) { return b.cpu - a.cpu; }).slice(0, 5);
      var byMem = arr.slice().sort(function (a, b) { return b.mem - a.mem; }).slice(0, 5);
      var maxCpu = Math.max(1, byCpu[0] ? byCpu[0].cpu : 1), maxMem = Math.max(1, byMem[0] ? byMem[0].mem : 1);
      var row = function (c, v, max, lab, cls) {
        return '<div class="dh-top"><span class="dh-tn">' + avatar(c.name, cicon(c.name)) + '<span>' + esc(c.name) + '</span></span>' + bar(v / max * 100, cls) + '<b>' + lab + '</b></div>';
      };
      html += '<div class="dh-tops"><div><div class="dh-sect">Top CPU</div>' + byCpu.map(function (c) { return row(c, c.cpu, maxCpu, c.cpu.toFixed(1) + '%', 'acc'); }).join('') + '</div>' +
        '<div><div class="dh-sect">Top memory</div>' + byMem.map(function (c) { return row(c, c.mem, maxMem, mem(c.mem * 1048576), 'pur'); }).join('') + '</div></div>';
    } else {
      html += '<div class="dh-muted dh-pad">Measuring container usage …</div>';
    }
    if (sy && sy.vms) {
      html += '<div class="dh-sect">Virtual machines</div>' + (sy.vms.length ? '<div class="dh-vms">' + sy.vms.map(function (v) {
        var on = v.state === 'running', k = on ? 'ok' : /paused/.test(v.state) ? 'warn' : 'off';
        return '<a class="dh-vm" href="/VMs">' + I.vm + '<span>' + esc(v.name) + '</span>' + chip(k, esc(v.state)) + '</a>';
      }).join('') + '</div>' : '<div class="dh-muted dh-pad">No virtual machines</div>');
    }
    $('#dh-cont').html(card('cont', 'Containers & VMs', I.box, '<a class="dh-link" href="/Docker">Docker ' + I.ext + '</a>', html));
  }

  function renderSvc() {
    var list = S.services;
    var edit = '<button type="button" class="dh-btn sm" data-act="svc-edit">' + I.edit + 'Edit</button>';
    if (!list) { $('#dh-svc').html(card('svc', 'Services', I.svc, edit, '<div class="dh-skel"></div>')); return; }
    var html = list.length ? '<div class="dh-svcs">' + list.map(function (s, i) {
      var c = S.checks[i], k = !c ? '' : c.up ? (c.ms > 1500 ? 'warn' : 'ok') : 'bad';
      var t = !c ? 'checking …' : c.up ? c.ms + ' ms' : (c.code ? 'HTTP ' + c.code : 'no answer');
      return '<a class="dh-svcc ' + k + '" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + avatar(s.name, cicon(s.container || s.name)) +
        '<span class="dh-sn"><b>' + esc(s.name) + '</b><small><span class="dh-dot ' + k + '"></span>' + esc(t) + '</small></span>' + I.ext + '</a>';
    }).join('') + '</div>' : '<div class="dh-empty">No services yet. Use <b>Edit</b> to pick the web interfaces you want to watch.</div>';
    if (S.svcAuto && list.length) html += '<div class="dh-muted dh-pad">Picked automatically from your containers – adjust with Edit.</div>';
    $('#dh-svc').html(card('svc', 'Services', I.svc, edit, html));
  }

  function renderEnergy() {
    var e = S.energy, el = $('#dh-energy');
    if (!e || !e.nvidia) { el.attr('hidden', ''); return; }
    el.removeAttr('hidden');
    var price = e.price, cur = e.currency;
    var cost = function (wh) { return wh == null ? null : wh / 1000 * price; };
    var priceBtn = S.priceEdit
      ? '<span class="dh-price"><label for="dh-price-in">Price per kWh</label><input id="dh-price-in" type="text" inputmode="decimal" value="' + String(price).replace('.', ',') + '">' +
        '<button type="button" class="dh-btn sm pri" data-act="price-save">Save</button><button type="button" class="dh-btn sm" data-act="price-cancel">Cancel</button></span>'
      : '<button type="button" class="dh-btn sm" data-act="price-edit" title="Change the electricity price">' + I.edit + money(price, cur).replace(/[.,]00(?=\D*$)/, '') + ' / kWh</button>';
    var mins = e.last30.minutes;
    if (!mins) {
      el.html(card('energy', 'GPU energy & cost', I.power, priceBtn,
        '<div class="dh-empty">' + (e.collecting ? 'Measuring – the first values appear within a minute.' : 'The energy collector is not running. Reinstall the plugin to start it.') + '</div>'));
      return;
    }
    var avgW = e.last30.wh / (mins / 60);
    var monthProj = e.month.minutes ? e.month.wh / e.month.minutes * 1440 * e.month_days : null;
    var idleShare = e.last30.wh ? e.last30.idle_wh / e.last30.wh * 100 : 0;
    var t = e.today, m = e.month;
    var tiles = '<div class="dh-ekpis">' +
      '<div class="dh-ekpi"><small>Today</small><b>' + money(cost(t.wh), cur) + '</b><span>' + kwh(t.wh) + ' · ' + (t.minutes ? Math.round(t.wh / (t.minutes / 60)) + ' W average' : '–') + '</span></div>' +
      '<div class="dh-ekpi"><small>' + new Date().toLocaleDateString([], { month: 'long' }) + ' so far</small><b>' + money(cost(m.wh), cur) + '</b><span>' + kwh(m.wh) + (monthProj ? ' · about ' + money(cost(monthProj), cur) + ' for the month' : '') + '</span></div>' +
      '<div class="dh-ekpi"><small>Per year at this rate</small><b>' + money(avgW * 8.76 * price, cur) + '</b><span>' + Math.round(avgW) + ' W average · ' + kwh(avgW * 8760) + '</span></div>' +
      '<div class="dh-ekpi"><small>Idle (doing nothing)</small><b>' + (e.idle_w != null ? Math.round(e.idle_w) + ' W' : '–') + '</b><span>' + Math.round(idleShare) + '% of the energy · ' + money(cost(e.last30.idle_wh), cur) + ' in 30 days</span></div>' +
    '</div>';
    // 30 days: idle part and active part per day
    var maxWh = Math.max.apply(null, e.days.map(function (d) { return d.wh || 0; }).concat([1]));
    var bw = 100 / e.days.length;
    var bars = e.days.map(function (d, i) {
      if (d.wh == null) return '';
      var x = (i * bw + bw * 0.15).toFixed(2), w = (bw * 0.7).toFixed(2);
      var hTot = d.wh / maxWh * 76, hIdle = (d.idle_wh || 0) / maxWh * 76;
      var lbl = new Date(d.date + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ': ' + kwh(d.wh) + ' · ' + money(cost(d.wh), cur);
      return '<g><title>' + esc(lbl) + '</title><rect class="i" x="' + x + '" y="' + (80 - hIdle).toFixed(2) + '" width="' + w + '" height="' + hIdle.toFixed(2) + '"/>' +
        '<rect class="a' + (i === e.days.length - 1 ? ' now' : '') + '" x="' + x + '" y="' + (80 - hTot).toFixed(2) + '" width="' + w + '" height="' + Math.max(0, hTot - hIdle).toFixed(2) + '"/></g>';
    }).join('');
    var first = new Date(e.days[0].date + 'T12:00').toLocaleDateString([], { day: 'numeric', month: 'short' });
    var chart = '<div class="dh-sect">Last 30 days</div><svg class="dh-bars" viewBox="0 0 100 80" preserveAspectRatio="none" role="img" aria-label="Energy per day for the last 30 days">' + bars + '</svg>' +
      '<div class="dh-axis"><span>' + esc(first) + '</span><span class="dh-legend"><span><i class="ea"></i>in use</span><span><i class="ei"></i>idle</span></span><span>today</span></div>';
    // today: power over the day in 5-minute steps
    // only the measured part of the day is drawn; gaps stay gaps
    var vals = e.curve.filter(function (v) { return v != null; });
    var cmax = Math.max.apply(null, vals.concat([50])) * 1.1, H = 60, path = '', area = '', run = [];
    function flush() {
      if (!run.length) return;
      if (run.length === 1) run.push([run[0][0] + 100 / 287, run[0][1]]);
      path += 'M' + run.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' L');
      area += 'M' + run[0][0].toFixed(2) + ',' + H + ' L' + run.map(function (p) { return p[0].toFixed(2) + ',' + p[1].toFixed(2); }).join(' L') + ' L' + run[run.length - 1][0].toFixed(2) + ',' + H + ' Z';
      run = [];
    }
    e.curve.forEach(function (v, i) {
      if (v == null) { flush(); return; }
      run.push([i / 287 * 100, H - 2 - v / cmax * (H - 4)]);
    });
    flush();
    var nowX = (e.now_minute / 1440 * 100).toFixed(2);
    var day = '<div class="dh-sect">Today, power over the day</div>' +
      '<svg class="dh-spark acc dh-day" viewBox="0 0 100 ' + H + '" preserveAspectRatio="none" role="img" aria-label="Power over the day">' +
      '<line class="now" x1="' + nowX + '" x2="' + nowX + '" y1="0" y2="' + H + '" vector-effect="non-scaling-stroke"/>' +
      (area ? '<path class="a" d="' + area + '"/><path class="l" d="' + path + '" vector-effect="non-scaling-stroke"/>' : '') + '</svg>' +
      '<div class="dh-axis"><span>0:00</span><span>' + (vals.length ? 'peak ' + Math.round(Math.max.apply(null, vals)) + ' W' : '') + '</span><span>24:00</span></div>';
    // who used it
    var apps = Object.keys(m.apps).map(function (k) { return { n: k, wh: m.apps[k] }; });
    apps.push({ n: 'Idle', wh: m.idle_wh, idle: true });
    apps.sort(function (a, b) { return b.wh - a.wh; });
    var topWh = apps.length ? apps[0].wh || 1 : 1;
    var who = '<div class="dh-sect">Who used it this month</div>' + apps.slice(0, 7).map(function (a) {
      return '<div class="dh-top"><span class="dh-tn">' + (a.idle ? '<span class="dh-av"><span class="dh-ini" style="background:var(--off)">' + I.moon + '</span></span>' : avatar(a.n, cicon(a.n))) + '<span>' + esc(a.n) + '</span></span>' +
        bar(a.wh / topWh * 100, a.idle ? '' : 'acc') + '<b>' + money(cost(a.wh), cur) + '</b></div>';
    }).join('') + '<div class="dh-muted dh-note">Energy above the idle draw is split between the containers by their GPU load.</div>';
    el.html(card('energy', 'GPU energy & cost', I.power, priceBtn,
      tiles + '<div class="dh-egrid"><div>' + chart + '</div><div>' + day + '</div><div>' + who + '</div></div>'));
  }

  function renderAll() {
    renderHead(); renderAlerts(); renderCpu(); renderMem(); renderGpu(); renderPower(); renderStorage(); renderNet(); renderCont(); renderSvc(); renderEnergy();
  }

  /* ---------- services editor ---------- */
  function openEditor() {
    var m = $('#dh-modal');
    m.removeAttr('hidden').html('<div class="dh-dialog" role="dialog" aria-modal="true" aria-label="Edit services"><div class="dh-dhd"><h3>Services to watch</h3><span class="dh-grow"></span><button type="button" class="dh-btn sm" data-act="svc-close">Close</button></div><div class="dh-dbody"><div class="dh-muted">Loading …</div></div></div>');
    api('candidates').done(function (r) {
      var cur = (S.services || []).slice();
      S.edit = { cur: cur, cand: r.candidates || [] };
      drawEditor();
    }).fail(function (x) { m.find('.dh-dbody').html('<div class="dh-empty">' + esc(err(x)) + '</div>'); });
  }
  function drawEditor() {
    var e = S.edit, used = {};
    e.cur.forEach(function (s) { used[s.url] = true; });
    var body = '<div class="dh-sect">Watching</div>' + (e.cur.length ? e.cur.map(function (s, i) {
      return '<div class="dh-erow">' + avatar(s.name, cicon(s.container || s.name)) + '<input type="text" value="' + esc(s.name) + '" data-act="svc-name" data-i="' + i + '" aria-label="Name">' +
        '<span class="dh-url" title="' + esc(s.url) + '">' + esc(s.url) + '</span>' +
        '<button type="button" class="dh-btn sm" data-act="svc-up" data-i="' + i + '" aria-label="Move up"' + (i ? '' : ' disabled') + '>↑</button>' +
        '<button type="button" class="dh-btn sm" data-act="svc-del" data-i="' + i + '">Remove</button></div>';
    }).join('') : '<div class="dh-muted dh-pad">Nothing yet.</div>') +
      '<div class="dh-sect">Add from your containers</div><div class="dh-cands">' + e.cand.filter(function (c) { return !used[c.url]; }).map(function (c) {
        return '<button type="button" class="dh-cand" data-act="svc-add" data-n="' + esc(c.name) + '" data-u="' + esc(c.url) + '">' + avatar(c.name, cicon(c.name)) + '<span>' + esc(c.name) + '</span>' + (c.running ? '' : '<small>stopped</small>') + '</button>';
      }).join('') + '</div>' +
      '<div class="dh-sect">Add another address</div><div class="dh-custom"><input type="text" id="dh-cn" placeholder="Name" aria-label="Name"><input type="url" id="dh-cu" placeholder="https://…" aria-label="Address"><button type="button" class="dh-btn sm" data-act="svc-custom">Add</button></div>';
    $('#dh-modal .dh-dbody').html(body);
    $('#dh-modal .dh-dhd .dh-grow').html('');
    if (!$('#dh-modal [data-act=svc-save]').length) $('#dh-modal .dh-dhd').append('<button type="button" class="dh-btn sm pri" data-act="svc-save">Save</button>');
  }
  function closeEditor() { $('#dh-modal').attr('hidden', '').empty(); S.edit = null; }

  $(root).on('click', '[data-act]', function (ev) {
    var el = $(this), a = el.data('act'), e = S.edit, i = +el.data('i');
    if (a === 'svc-edit') { ev.preventDefault(); openEditor(); }
    else if (a === 'svc-close') closeEditor();
    else if (a === 'svc-add' && e) { e.cur.push({ name: el.data('n'), url: el.data('u'), container: el.data('n') }); drawEditor(); }
    else if (a === 'svc-del' && e) { e.cur.splice(i, 1); drawEditor(); }
    else if (a === 'svc-up' && e && i > 0) { var t = e.cur[i]; e.cur[i] = e.cur[i - 1]; e.cur[i - 1] = t; drawEditor(); }
    else if (a === 'svc-custom' && e) {
      var n = $.trim($('#dh-cn').val()), u = $.trim($('#dh-cu').val());
      if (!n || !/^https?:\/\/\S+$/i.test(u)) { $('#dh-cu').focus(); return; }
      e.cur.push({ name: n, url: u, container: '' }); drawEditor();
    } else if (a === 'svc-save' && e) {
      el.prop('disabled', true);
      apiPost('save_services', { services: JSON.stringify(e.cur) }).done(function () { closeEditor(); S.checks = {}; loadServices(); })
        .fail(function (x) { el.prop('disabled', false); alert(err(x)); });
    }
  });
  $(root).on('click', '[data-act=price-edit]', function () { S.priceEdit = true; renderEnergy(); $('#dh-price-in').focus().select(); });
  $(root).on('click', '[data-act=price-cancel]', function () { S.priceEdit = false; renderEnergy(); });
  $(root).on('click', '[data-act=price-save]', function () {
    var b = $(this).prop('disabled', true), v = $.trim($('#dh-price-in').val()).replace(',', '.');
    apiPost('save_price', { price: v }).done(function (r) { S.priceEdit = false; if (S.energy) S.energy.price = r.price; renderEnergy(); })
      .fail(function (x) { b.prop('disabled', false); alert(err(x)); });
  });
  $(root).on('keydown', '#dh-price-in', function (ev) { if (ev.key === 'Enter') $('[data-act=price-save]').click(); if (ev.key === 'Escape') $('[data-act=price-cancel]').click(); });
  $(root).on('input', '[data-act=svc-name]', function () { if (S.edit) S.edit.cur[+$(this).data('i')].name = this.value; });
  $(root).on('click', '#dh-modal', function (ev) { if (ev.target === this) closeEditor(); });
  $(document).on('keydown', function (ev) { if (ev.key === 'Escape' && S.edit) closeEditor(); });

  /* ---------- data ---------- */
  function onLive(r) {
    var p = S.live;
    if (p) {
      var dt = Math.max(0.5, r.time - p.time);
      var d = function (a, b) { var t = a[1] - b[1]; return t > 0 ? Math.max(0, Math.min(100, (a[0] - b[0]) / t * 100)) : 0; };
      S.cpu = d(r.cpu.all, p.cpu.all);
      S.cores = r.cpu.cores.map(function (c, i) { return p.cpu.cores[i] ? d(c, p.cpu.cores[i]) : 0; });
      var net = {};
      Object.keys(r.net).forEach(function (n) {
        var a = r.net[n], b = p.net[n];
        if (b) net[n] = { rx: Math.max(0, (a[0] - b[0]) / dt), tx: Math.max(0, (a[1] - b[1]) / dt) };
      });
      S.net = net;
      push(S.hist.cpu, S.cpu);
      var mains = Object.keys(net).filter(function (n) { return n.indexOf('.') < 0 && !/^br/.test(n); })
        .sort(function (a, b) { return (net[b].rx + net[b].tx) - (net[a].rx + net[a].tx); });
      if (mains[0]) { push(S.hist.rx, net[mains[0]].rx); push(S.hist.tx, net[mains[0]].tx); }
    }
    push(S.hist.mem, r.mem.used / r.mem.total * 100);
    if (r.gpus && r.gpus[0]) { push(S.hist.gpu, r.gpus[0].busy); if (r.gpus[0].power != null) push(S.hist.gpuw, r.gpus[0].power); }
    S.live = r;
    renderHead(); renderCpu(); renderMem(); renderGpu(); renderPower(); renderNet(); renderAlerts();
  }
  function loadLive() { api('live').done(onLive); }
  function loadEnergy() { if (S.priceEdit) return; api('energy').done(function (r) { S.energy = r; renderEnergy(); }); }
  function loadStorage() { api('storage').done(function (r) { S.storage = r; renderStorage(); renderAlerts(); }); }
  function loadSystem() { api('system').done(function (r) { S.system = r; renderHead(); renderCpu(); renderNet(); renderCont(); renderAlerts(); }); }
  function loadContainers() {
    var useHub = S.system ? S.system.container_hub : true;
    var req = useHub ? $.ajax({ url: CH, data: { action: 'state' }, dataType: 'json', cache: false }) : api('containers');
    req.done(function (r) { S.cts = r.containers || null; renderCont(); renderSvc(); renderAlerts(); })
      .fail(function () { if (useHub) api('containers').done(function (r) { S.cts = r.containers || null; renderCont(); renderAlerts(); }); });
  }
  function loadStats() {
    if (S.system && !S.system.container_hub) return;
    $.ajax({ url: CH, data: { action: 'stats' }, dataType: 'json', cache: false }).done(function (r) { S.stats = r.stats || null; renderCont(); });
  }
  function loadServices() {
    api('services').done(function (r) {
      S.services = r.services || []; S.svcAuto = !!r.auto; S.checks = r.checks || {};
      renderSvc(); renderAlerts();
    });
  }

  /* ---------- inside the Dashboard tab: replaces Unraid's tile view ---------- */
  function embedInDashboard() {
    var content = root.parentNode;
    if (!content || !/^\/Dashboard\/?$/.test(location.pathname)) return;
    var frame = null;
    Array.prototype.forEach.call(content.children, function (el) { if (!frame && el.classList.contains('frame') && el.querySelector('.tile, .grid')) frame = el; });
    if (!frame) return; // tabbed page view: the classic dashboard has its own tab
    var kids = Array.prototype.slice.call(content.children), ownTitle = null;
    for (var j = kids.indexOf(root) - 1; j >= 0; j--) { if (kids[j].classList.contains('title')) { ownTitle = kids[j]; break; } }
    // keep this page above the classic tiles
    if (kids.indexOf(root) > kids.indexOf(frame)) {
      if (ownTitle) content.insertBefore(ownTitle, frame);
      content.insertBefore(root, frame);
    }
    var bar = document.createElement('div');
    bar.className = 'dh-classicbar';
    content.insertBefore(bar, frame);
    var hub = ownTitle ? [ownTitle, root] : [root];
    function sw(parent, label, toClassic) {
      if (!parent) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dh-switch';
      b.textContent = label;
      b.addEventListener('click', function () { show(toClassic); });
      (parent.querySelector('.right') || parent).appendChild(b);
    }
    function show(classic, initial) {
      if (!initial) store.set('classic', classic);
      frame.style.display = classic ? '' : 'none';
      bar.style.display = classic ? '' : 'none';
      hub.forEach(function (el) { el.style.display = classic ? 'none' : ''; });
      if (classic) $(window).trigger('resize');
    }
    if (ownTitle) sw(ownTitle, 'Classic view', true);
    else { var tb = document.createElement('div'); tb.className = 'dh-ownbar'; content.insertBefore(tb, root); hub.unshift(tb); sw(tb, 'Classic view', true); }
    sw(bar, 'Dashboard Hub', false);
    show(store.get('classic', false), true);
  }

  $(embedInDashboard);
  renderShell();
  loadSystem();
  loadLive();
  setTimeout(loadLive, 1200);
  loadStorage();
  loadContainers();
  loadStats();
  loadServices();
  loadEnergy();
  setInterval(function () { if (!document.hidden) loadEnergy(); }, 60000);
  setInterval(function () { if (!document.hidden && !S.edit) loadLive(); }, 3000);
  setInterval(function () { if (!document.hidden) loadStorage(); }, 15000);
  setInterval(function () { if (!document.hidden) loadSystem(); }, 30000);
  setInterval(function () { if (!document.hidden) loadContainers(); }, 15000);
  setInterval(function () { if (!document.hidden) loadStats(); }, 30000);
  setInterval(function () { if (!document.hidden && !S.edit) loadServices(); }, 60000);
  setInterval(renderHead, 15000);
})();
