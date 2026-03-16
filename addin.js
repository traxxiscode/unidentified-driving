/* ============================================================
   Unidentified Driving — HOS Dashboard  |  addin.js
   Geotab Add-in entry point: geotab.addin.unidentifieddriving
   ============================================================ */

/* ── Dashboard namespace (IIFE) ─────────────────────────────── */
var unidDash = (function () {

  /* ── Private state ── */
  var _api            = null;
  var _currentPeriod  = 3;          // months
  var _currentStatus  = 'all';
  var _currentSearch  = '';
  var _sortKey        = 'date';
  var _sortDir        = -1;
  var _currentPage    = 1;
  var _PER_PAGE       = 15;
  var _filteredEvents = [];
  var _allEvents      = [];
  var _vehicles       = [];
  var _drivers        = [];
  var _isLight        = false;
  var _toastTimer     = null;
  var _initialized    = false;

  /* ── HOS rule sets pulled from Geotab (fallback list) ── */
  var _hosRules = [
    'Canada South 70h', 'Canada North 120h',
    'US 60h/7d', 'US 70h/8d', 'Exempt'
  ];

  /* ── Utilities ── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtTime(h, m) { return pad(h) + ':' + pad(m); }
  function fmtDur(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    return h > 0 ? h + 'h ' + pad(mm) + 'm' : mm + 'm';
  }
  function fmtDist(k) { return k + ' km'; }

  function toast(msg, color) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.borderColor = color || '';
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  function setErr(msg) {
    var el = document.getElementById('errBox');
    if (el) el.textContent = msg || '';
  }

  /* ── Theme ── */
  function applyTheme(isLight) {
    _isLight = isLight;
    var root = document.getElementById('unidentifieddriving');
    if (!root) return;
    if (isLight) {
      root.classList.add('light');
    } else {
      root.classList.remove('light');
    }
    var lbl = document.getElementById('themeLbl');
    if (lbl) lbl.textContent = isLight ? 'LIGHT' : 'DARK';
    drawDonut();
  }

  /* ── Date range subtitle ── */
  function updateDateRange() {
    var el = document.getElementById('dateRange');
    if (!el) return;
    var now = new Date();
    var from = new Date(now - _currentPeriod * 30 * 86400000);
    el.textContent = 'Period: ' + fmtDate(from) + ' → ' + fmtDate(now);
  }

  /* ── Filter helpers ── */
  function getFiltered() {
    var now = new Date();
    var cutoff = new Date(now - _currentPeriod * 30 * 86400000);
    return _allEvents.filter(function (e) {
      if (e.dateObj < cutoff) return false;
      if (_currentStatus !== 'all' && e.status !== _currentStatus) return false;
      if (_currentSearch) {
        var q = _currentSearch;
        if (
          e.vehicle.toLowerCase().indexOf(q) === -1 &&
          (e.driver || '').toLowerCase().indexOf(q) === -1 &&
          e.id.toLowerCase().indexOf(q) === -1
        ) return false;
      }
      return true;
    });
  }

  /* ── Stats ── */
  function updateStats(evts) {
    var statTotal = document.getElementById('statTotal');
    var statHours = document.getElementById('statHours');
    var statVehicles = document.getElementById('statVehicles');
    var statFleet = document.getElementById('statFleet');
    var statAssigned = document.getElementById('statAssigned');
    var statAnnotations = document.getElementById('statAnnotations');

    if (statTotal) statTotal.textContent = evts.length;
    var totalMin = evts.reduce(function (s, e) { return s + e.durationMin; }, 0);
    var h = Math.floor(totalMin / 60);
    if (statHours) statHours.textContent = h + 'h';
    var vSet = {};
    evts.forEach(function (e) { vSet[e.vehicle] = true; });
    if (statVehicles) statVehicles.textContent = Object.keys(vSet).length;
    if (statFleet) statFleet.textContent = _vehicles.length || '—';
    if (statAssigned) statAssigned.textContent = evts.filter(function (e) { return e.status === 'assigned'; }).length;
    if (statAnnotations) statAnnotations.textContent = evts.filter(function (e) { return e.status === 'annotated'; }).length;
  }

  /* ── Bar Chart ── */
  function drawBarChart(evts) {
    var container = document.getElementById('barChart');
    if (!container) return;
    var now = new Date();
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ label: d.toLocaleString('default', { month: 'short' }), year: d.getFullYear(), month: d.getMonth() });
    }
    var data = months.map(function (m) {
      var me = _allEvents.filter(function (e) {
        return e.dateObj.getFullYear() === m.year && e.dateObj.getMonth() === m.month;
      });
      return {
        label: m.label,
        unassigned: me.filter(function (e) { return e.status === 'unassigned'; }).length,
        assigned:   me.filter(function (e) { return e.status === 'assigned'; }).length,
        annotated:  me.filter(function (e) { return e.status === 'annotated'; }).length
      };
    });
    var maxVal = Math.max.apply(null, data.map(function (d) { return d.unassigned + d.assigned + d.annotated; }).concat([1]));
    container.innerHTML = '';
    data.forEach(function (d) {
      var unH = Math.round((d.unassigned / maxVal) * 100);
      var asH = Math.round((d.assigned / maxVal) * 100);
      var anH = Math.round((d.annotated / maxVal) * 100);
      container.innerHTML += '<div class="bar-group">' +
        '<div class="bar-wrap">' +
          '<div class="bar" style="background:var(--red);height:' + unH + '%" data-tip="' + d.unassigned + ' unassigned"></div>' +
          '<div class="bar" style="background:var(--blue);height:' + asH + '%" data-tip="' + d.assigned + ' assigned"></div>' +
          '<div class="bar" style="background:var(--purple);height:' + anH + '%" data-tip="' + d.annotated + ' annotated"></div>' +
        '</div>' +
        '<span class="bar-month">' + d.label + '</span>' +
      '</div>';
    });
  }

  /* ── Donut Chart ── */
  function drawDonut() {
    var evts = getFiltered();
    var u = evts.filter(function (e) { return e.status === 'unassigned'; }).length;
    var a = evts.filter(function (e) { return e.status === 'assigned'; }).length;
    var n = evts.filter(function (e) { return e.status === 'annotated'; }).length;
    var total = (u + a + n) || 1;
    var segs = [
      { val: u, color: 'var(--red)',    label: 'Unassigned' },
      { val: a, color: 'var(--blue)',   label: 'Assigned' },
      { val: n, color: 'var(--purple)', label: 'Annotated' }
    ];
    var cx = 60, cy = 60, r = 46, ir = 30, tau = Math.PI * 2;
    var start = 0, paths = '';
    segs.forEach(function (s) {
      var frac = s.val / total;
      var sweep = frac * tau;
      var end = start + sweep;
      var x1 = cx + r * Math.sin(start),   y1 = cy - r * Math.cos(start);
      var x2 = cx + r * Math.sin(end),     y2 = cy - r * Math.cos(end);
      var ix1 = cx + ir * Math.sin(start), iy1 = cy - ir * Math.cos(start);
      var ix2 = cx + ir * Math.sin(end),   iy2 = cy - ir * Math.cos(end);
      var lg = sweep > Math.PI ? 1 : 0;
      if (frac > 0) {
        paths += '<path d="M' + x1 + ',' + y1 +
          ' A' + r + ',' + r + ' 0 ' + lg + ',1 ' + x2 + ',' + y2 +
          ' L' + ix2 + ',' + iy2 +
          ' A' + ir + ',' + ir + ' 0 ' + lg + ',0 ' + ix1 + ',' + iy1 +
          ' Z" fill="' + s.color + '" opacity=".85"/>';
      }
      start = end;
    });
    paths += '<text x="60" y="56" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="16" font-weight="600" fill="currentColor">' + total + '</text>';
    paths += '<text x="60" y="70" text-anchor="middle" font-family="IBM Plex Mono,monospace" font-size="8" fill="#8b949e">EVENTS</text>';
    var svg = document.getElementById('donutSvg');
    if (svg) svg.innerHTML = paths;
    var lblEl = document.getElementById('donutLabels');
    if (lblEl) {
      lblEl.innerHTML = segs.map(function (s) {
        return '<div class="donut-label-item">' +
          '<span class="legend-dot" style="background:' + s.color + ';display:inline-block;border-radius:2px;width:8px;height:8px;"></span>' +
          '<span>' + s.label + '</span>' +
          '<span class="donut-pct" style="color:' + s.color + '">' + Math.round(s.val / total * 100) + '%</span>' +
        '</div>';
      }).join('');
    }
  }

  /* ── Table ── */
  function renderTable(evts) {
    evts.sort(function (a, b) {
      var va, vb;
      if (_sortKey === 'vehicle')  { va = a.vehicle;     vb = b.vehicle; }
      else if (_sortKey === 'date')     { va = a.dateObj;     vb = b.dateObj; }
      else if (_sortKey === 'duration') { va = a.durationMin; vb = b.durationMin; }
      else if (_sortKey === 'distance') { va = a.distanceKm;  vb = b.distanceKm; }
      else                              { va = a.start;       vb = b.start; }
      if (va < vb) return -1 * _sortDir;
      if (va > vb) return  1 * _sortDir;
      return 0;
    });
    _filteredEvents = evts;
    var start = (_currentPage - 1) * _PER_PAGE;
    var page  = evts.slice(start, start + _PER_PAGE);
    var tbody = document.getElementById('tableBody');
    if (!tbody) return;
    tbody.innerHTML = page.map(function (e, i) {
      var pct = Math.min(100, Math.round(e.durationMin / 240 * 100));
      var barColor = pct > 75 ? 'var(--red)' : pct > 40 ? 'var(--yellow)' : 'var(--blue)';
      var pillClass = e.status === 'unassigned' ? 'pill-red'   :
                      e.status === 'assigned'   ? 'pill-blue'  : 'pill-purple';
      var pillLabel = e.status === 'unassigned' ? '⚠ Unassigned' :
                      e.status === 'assigned'   ? '✓ Assigned'   : '✎ Annotated';
      var annBadge = e.annotation
        ? '<span class="annotation-badge has-note" onclick="unidDash.openDrawer(' + (start + i) + ',event)">✎ Note</span>'
        : '<span class="annotation-badge" onclick="unidDash.openDrawer(' + (start + i) + ',event)">+ Add</span>';
      return '<tr onclick="unidDash.openDrawer(' + (start + i) + ',event)">' +
        '<td onclick="event.stopPropagation()"><input type="checkbox" data-idx="' + (start + i) + '" onchange="unidDash.checkRow(this,' + (start + i) + ')"/></td>' +
        '<td><div class="vehicle-id"><span class="vehicle-dot" style="background:' + e.vehicleColor + '"></span><span class="mono">' + e.vehicle + '</span></div></td>' +
        '<td class="mono">' + e.date + '</td>' +
        '<td class="mono">' + e.start + '</td>' +
        '<td><div style="min-width:80px"><div class="mono" style="margin-bottom:4px">' + fmtDur(e.durationMin) + '</div><div class="hours-bar"><div class="hours-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div></div></td>' +
        '<td class="mono">' + fmtDist(e.distanceKm) + '</td>' +
        '<td><span class="pill pill-gray">' + e.hosRule + '</span></td>' +
        '<td><span class="pill ' + pillClass + '">' + pillLabel + '</span></td>' +
        '<td class="mono">' + (e.driver || '<span style="color:var(--text3)">—</span>') + '</td>' +
        '<td onclick="event.stopPropagation()">' + annBadge + '</td>' +
        '<td onclick="event.stopPropagation()"><button class="btn" onclick="unidDash.quickAssign(' + (start + i) + ')">Assign</button></td>' +
      '</tr>';
    }).join('');

    var pageInfo = document.getElementById('pageInfo');
    if (pageInfo) {
      pageInfo.textContent = 'Showing ' + (evts.length ? start + 1 : 0) + '–' + Math.min(start + _PER_PAGE, evts.length) + ' of ' + evts.length;
    }

    var totalPages = Math.ceil(evts.length / _PER_PAGE);
    var pHtml = '<button class="page-btn" onclick="unidDash.goPage(' + (_currentPage - 1) + ')">&#8249;</button>';
    for (var p = 1; p <= totalPages; p++) {
      if (totalPages > 7 && p > 2 && p < totalPages - 1 && Math.abs(p - _currentPage) > 1) {
        if (p === 3 || p === totalPages - 2) pHtml += '<span style="color:var(--text3);padding:0 4px;font-size:12px">…</span>';
        continue;
      }
      pHtml += '<button class="page-btn' + (p === _currentPage ? ' active' : '') + '" onclick="unidDash.goPage(' + p + ')">' + p + '</button>';
    }
    pHtml += '<button class="page-btn" onclick="unidDash.goPage(' + (_currentPage + 1) + ')">&#8250;</button>';
    var pagEl = document.getElementById('pagination');
    if (pagEl) pagEl.innerHTML = pHtml;
  }

  /* ── Full render ── */
  function render() {
    var evts = getFiltered();
    updateStats(evts);
    drawBarChart(evts);
    drawDonut();
    renderTable(evts);
    updateDateRange();
  }

  /* ── Timeline generator (used for demo / fallback data) ── */
  function generateTimeline(dt, sh, sm, dur) {
    var lines = [];
    var base = new Date(dt);
    base.setHours(sh, sm, 0);
    lines.push({ time: fmtTime(sh, sm) + ' — Engine start', desc: 'Vehicle ignition detected, no driver card present', color: 'var(--yellow)' });
    var mid = new Date(base.getTime() + dur / 2 * 60000);
    lines.push({ time: fmtTime(mid.getHours(), mid.getMinutes()) + ' — Speed event', desc: 'Travelling ' + (+(dur / 2 * 0.6).toFixed(1)) + ' km from depot', color: 'var(--blue)' });
    var end = new Date(base.getTime() + dur * 60000);
    lines.push({ time: fmtTime(end.getHours(), end.getMinutes()) + ' — Engine off', desc: 'Vehicle stopped, event closed', color: 'var(--red)' });
    return lines;
  }

  /* ── Load data from Geotab API ── */
  function loadFromGeotab() {
    if (!_api) { loadDemoData(); return; }

    setErr('');
    var now  = new Date();
    var from = new Date(now - 6 * 30 * 86400000); // 6 months back (cover all chart range)

    // Step 1: get devices (vehicles)
    _api.call('Get', {
      typeName: 'Device',
      resultsLimit: 500
    }, function (devices) {
      _vehicles = (devices || []).map(function (d) {
        return { id: d.id, name: d.name || d.id };
      });

      // Step 2: get users (drivers)
      _api.call('Get', {
        typeName: 'User',
        resultsLimit: 500
      }, function (users) {
        _drivers = (users || []).map(function (u) {
          return (u.firstName || '') + (u.lastName ? ' ' + u.lastName : '') || u.name || u.id;
        }).filter(Boolean);

        // Step 3: get unidentified driver exception data
        // ExceptionEvent for the "Unidentified Driver Activity" rule, or
        // DutyStatusLog with no driver. We use DutyStatusLog here.
        _api.call('Get', {
          typeName: 'DutyStatusLog',
          search: {
            fromDate: from.toISOString(),
            toDate:   now.toISOString(),
            driverSearch: { id: 'UnknownDriverId' }
          },
          resultsLimit: 2000
        }, function (logs) {
          if (!logs || !logs.length) {
            // Fallback: try ExceptionEvent for unidentified driving rules
            fetchExceptionEvents(from, now);
            return;
          }
          processLogs(logs);
        }, function (err) {
          console.warn('[UnidDash] DutyStatusLog fetch failed, trying ExceptionEvents:', err);
          fetchExceptionEvents(from, now);
        });
      }, function (err) {
        console.warn('[UnidDash] Users fetch failed:', err);
        _drivers = [];
        fetchExceptionEvents(from, now);
      });
    }, function (err) {
      console.warn('[UnidDash] Devices fetch failed, loading demo data:', err);
      loadDemoData();
    });
  }

  function fetchExceptionEvents(from, now) {
    _api.call('Get', {
      typeName: 'ExceptionEvent',
      search: {
        fromDate: from.toISOString(),
        toDate:   now.toISOString(),
        ruleName: 'Unidentified Driver Activity'
      },
      resultsLimit: 2000
    }, function (events) {
      if (!events || !events.length) {
        console.info('[UnidDash] No Geotab unidentified events found; loading demo data.');
        loadDemoData();
        return;
      }
      processExceptionEvents(events);
    }, function (err) {
      console.warn('[UnidDash] ExceptionEvent fetch failed, loading demo data:', err);
      loadDemoData();
    });
  }

  function processLogs(logs) {
    var vColors = ['#f85149','#ffa657','#58a6ff','#3fb950','#bc8cff','#f78166','#79c0ff','#d29922','#56d364','#ff7b72'];
    var vColorMap = {};
    var colorIdx = 0;
    _allEvents = logs.map(function (log, i) {
      var dt = new Date(log.dateTime || log.startTime);
      var dur = log.durationTicks ? Math.round(log.durationTicks / 600000000) : 30;
      var vId = (log.device && log.device.id) ? log.device.id : 'UNKNOWN';
      if (!vColorMap[vId]) {
        vColorMap[vId] = vColors[colorIdx % vColors.length];
        colorIdx++;
      }
      var vName = vId;
      for (var k = 0; k < _vehicles.length; k++) {
        if (_vehicles[k].id === vId) { vName = _vehicles[k].name; break; }
      }
      return {
        id:           'EVT-' + String(10000 + i),
        vehicle:      vName,
        vehicleColor: vColorMap[vId],
        date:         fmtDate(dt),
        dateObj:      dt,
        start:        fmtTime(dt.getHours(), dt.getMinutes()),
        durationMin:  dur,
        distanceKm:   +(dur * 0.6).toFixed(1),
        hosRule:      log.ruleName || 'N/A',
        status:       'unassigned',
        driver:       null,
        annotation:   null,
        checked:      false,
        timeline:     generateTimeline(dt, dt.getHours(), dt.getMinutes(), dur)
      };
    });
    render();
    toast('Loaded ' + _allEvents.length + ' events from Geotab', '#3fb950');
  }

  function processExceptionEvents(events) {
    var vColors = ['#f85149','#ffa657','#58a6ff','#3fb950','#bc8cff','#f78166','#79c0ff','#d29922','#56d364','#ff7b72'];
    var vColorMap = {};
    var colorIdx = 0;
    _allEvents = events.map(function (evt, i) {
      var dt = new Date(evt.activeFrom || evt.dateTime);
      var endDt = new Date(evt.activeTo || evt.dateTime);
      var dur = Math.max(1, Math.round((endDt - dt) / 60000));
      var distKm = +(dur * 0.6).toFixed(1);
      var vId = (evt.device && evt.device.id) ? evt.device.id : 'UNKNOWN';
      if (!vColorMap[vId]) {
        vColorMap[vId] = vColors[colorIdx % vColors.length];
        colorIdx++;
      }
      var vName = vId;
      for (var k = 0; k < _vehicles.length; k++) {
        if (_vehicles[k].id === vId) { vName = _vehicles[k].name; break; }
      }
      return {
        id:           'EVT-' + String(10000 + i),
        vehicle:      vName,
        vehicleColor: vColorMap[vId],
        date:         fmtDate(dt),
        dateObj:      dt,
        start:        fmtTime(dt.getHours(), dt.getMinutes()),
        durationMin:  dur,
        distanceKm:   distKm,
        hosRule:      (evt.rule && evt.rule.name) || 'Unidentified Driver',
        status:       'unassigned',
        driver:       null,
        annotation:   null,
        checked:      false,
        timeline:     generateTimeline(dt, dt.getHours(), dt.getMinutes(), dur)
      };
    });
    render();
    toast('Loaded ' + _allEvents.length + ' events from Geotab', '#3fb950');
  }

  /* ── Demo / fallback data (mirrors original scorecard) ── */
  function loadDemoData() {
    var vDefs = [
      { id: 'VH-1041', color: '#f85149' }, { id: 'VH-2083', color: '#ffa657' },
      { id: 'VH-3317', color: '#58a6ff' }, { id: 'VH-4092', color: '#3fb950' },
      { id: 'VH-5504', color: '#bc8cff' }, { id: 'VH-6610', color: '#f78166' },
      { id: 'VH-7728', color: '#79c0ff' }, { id: 'VH-8831', color: '#d29922' },
      { id: 'VH-9043', color: '#56d364' }, { id: 'VH-0175', color: '#ff7b72' }
    ];
    _vehicles = vDefs.map(function (v) { return { id: v.id, name: v.id }; });
    _drivers = ['J. Harrington','M. Delacroix','T. Okonkwo','S. Patel','R. Vasquez',
                'L. Nguyen','K. Brennan','D. Achebe','F. Morales','B. Nakamura'];
    var annotations = [
      'Vehicle taken home — approved yard move',
      'Pre-trip inspection drive',
      'Maintenance road test',
      'Driver forgot to log in',
      'ELD malfunction reported — manual logs filed',
      'Authorized personal conveyance',
      null, null, null, null
    ];
    var statusTypes = ['unassigned','assigned','annotated'];
    var now = new Date();

    function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
    function randOf(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    _allEvents = [];
    for (var i = 0; i < 180; i++) {
      var daysBack = randInt(0, 180);
      var dt = new Date(now - daysBack * 86400000);
      var sh = randInt(4, 21), sm = randInt(0, 59);
      var dur = randInt(5, 240);
      var distKm = +(dur * randOf([0.4,0.5,0.6,0.7,0.8])).toFixed(1);
      var veh = randOf(vDefs);
      var st  = randOf(statusTypes);
      var ann = st === 'annotated' ? randOf(annotations.filter(Boolean)) : null;
      var drv = st === 'assigned'  ? randOf(_drivers) : null;
      _allEvents.push({
        id:           'EVT-' + String(10000 + i),
        vehicle:      veh.id,
        vehicleColor: veh.color,
        date:         fmtDate(dt),
        dateObj:      dt,
        start:        fmtTime(sh, sm),
        durationMin:  dur,
        distanceKm:   distKm,
        hosRule:      randOf(_hosRules),
        status:       st,
        driver:       drv,
        annotation:   ann,
        checked:      false,
        timeline:     generateTimeline(dt, sh, sm, dur)
      });
    }
    _allEvents.sort(function (a, b) { return b.dateObj - a.dateObj; });
    render();
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {

    /* Called by Geotab focus() after API session is ready */
    init: function (api) {
      _api = api;
      var root = document.getElementById('unidentifieddriving');
      if (root) root.style.display = '';

      // Wire up the drawer close-on-overlay-click
      var overlay = document.getElementById('detailModal');
      if (overlay && !_initialized) {
        overlay.addEventListener('click', function (e) {
          if (e.target === overlay) unidDash.closeDrawer();
        });
        _initialized = true;
      }

      loadFromGeotab();
    },

    /* Header control callbacks */
    setPeriod: function (m) {
      _currentPeriod = m;
      _currentPage = 1;
      document.querySelectorAll('#periodChips .hdr-chip').forEach(function (c) { c.classList.remove('active'); });
      event.target.classList.add('active');
      render();
    },

    setStatus: function (s) {
      _currentStatus = s;
      _currentPage = 1;
      document.querySelectorAll('#statusChips .hdr-chip').forEach(function (c) { c.classList.remove('active'); });
      event.target.classList.add('active');
      render();
    },

    toggleTheme: function () {
      applyTheme(!_isLight);
    },

    refresh: function () {
      _allEvents = [];
      var tbody = document.getElementById('tableBody');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="11"><div class="box"><div class="spinner"></div><div class="msg-txt">LOADING…</div></div></td></tr>';
      }
      loadFromGeotab();
    },

    filterTable: function () {
      _currentSearch = (document.getElementById('searchBox') || {}).value.toLowerCase() || '';
      _currentPage = 1;
      render();
    },

    sortTable: function (key) {
      if (_sortKey === key) { _sortDir *= -1; }
      else { _sortKey = key; _sortDir = -1; }
      render();
    },

    goPage: function (p) {
      var total = Math.ceil(_filteredEvents.length / _PER_PAGE);
      if (p < 1 || p > total) return;
      _currentPage = p;
      renderTable(_filteredEvents);
    },

    /* Drawer */
    openDrawer: function (idx, ev) {
      if (ev) ev.stopPropagation();
      var e = _filteredEvents[idx];
      if (!e) return;
      var titleEl = document.getElementById('drawerTitle');
      if (titleEl) titleEl.textContent = e.id + ' · ' + e.vehicle;
      var driverOptions = _drivers.map(function (d) {
        return '<option value="' + d + '"' + (e.driver === d ? ' selected' : '') + '>' + d + '</option>';
      }).join('');
      var content = document.getElementById('drawerContent');
      if (!content) return;
      var rows = [
        ['Event ID',     e.id],
        ['Vehicle',      e.vehicle],
        ['Date',         e.date],
        ['Start Time',   e.start],
        ['Duration',     fmtDur(e.durationMin)],
        ['Distance',     fmtDist(e.distanceKm)],
        ['HOS Rule Set', e.hosRule],
        ['Current Status', '<span class="pill ' + (e.status === 'unassigned' ? 'pill-red' : e.status === 'assigned' ? 'pill-blue' : 'pill-purple') + '">' + e.status + '</span>']
      ];
      content.innerHTML =
        '<div>' +
          rows.map(function (r) {
            return '<div class="detail-row"><span class="detail-key">' + r[0] + '</span><span class="detail-val">' + r[1] + '</span></div>';
          }).join('') +
        '</div>' +
        '<div class="timeline" style="margin-top:20px">' +
          '<div style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--text3);margin-bottom:12px">Event Timeline</div>' +
          e.timeline.map(function (t) {
            return '<div class="timeline-item">' +
              '<div class="timeline-dot" style="border-color:' + t.color + ';background:' + t.color + '22"></div>' +
              '<div class="timeline-content">' +
                '<div class="timeline-time">' + t.time + '</div>' +
                '<div class="timeline-desc">' + t.desc + '</div>' +
              '</div></div>';
          }).join('') +
        '</div>' +
        '<div class="annotation-section">' +
          '<h4>Annotation</h4>' +
          (e.annotation
            ? '<div class="annotation-entry"><div class="annotation-meta">NOTE</div><div class="annotation-text">' + e.annotation + '</div></div>'
            : '<div style="color:var(--text3);font-size:12px;margin-bottom:12px">No annotation added.</div>') +
        '</div>' +
        '<div class="assign-form">' +
          '<h4 style="font-family:\'IBM Plex Mono\',monospace;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:var(--text3);margin-bottom:12px">Assign Driver / Add Note</h4>' +
          '<div class="form-group"><label class="form-label">Assign Driver</label>' +
            '<select class="form-select" id="drawerDriver"><option value="">— Select Driver —</option>' + driverOptions + '</select></div>' +
          '<div class="form-group"><label class="form-label">Annotation Note</label>' +
            '<textarea class="form-textarea" id="drawerNote" placeholder="Enter reason or note for this event…">' + (e.annotation || '') + '</textarea></div>' +
          '<div style="display:flex;gap:8px;margin-top:4px">' +
            '<button class="btn btn-primary" onclick="unidDash.saveDrawer(' + idx + ')">Save Changes</button>' +
            '<button class="btn" onclick="unidDash.closeDrawer()">Cancel</button>' +
          '</div>' +
        '</div>';
      var overlay = document.getElementById('detailModal');
      if (overlay) overlay.classList.add('open');
    },

    closeDrawer: function () {
      var overlay = document.getElementById('detailModal');
      if (overlay) overlay.classList.remove('open');
    },

    saveDrawer: function (idx) {
      var e = _filteredEvents[idx];
      if (!e) return;
      var drvEl  = document.getElementById('drawerDriver');
      var noteEl = document.getElementById('drawerNote');
      var drv  = drvEl  ? drvEl.value  : '';
      var note = noteEl ? noteEl.value.trim() : '';
      if (drv)  { e.driver = drv; e.status = 'assigned'; }
      if (note) { e.annotation = note; e.status = drv ? 'assigned' : 'annotated'; }
      unidDash.closeDrawer();
      render();
      toast('Changes saved', '#3fb950');
    },

    quickAssign: function (idx) {
      var e = _filteredEvents[idx];
      if (!e) return;
      var list = _drivers.map(function (d, i) { return (i + 1) + '. ' + d; }).join('\n');
      var drv = prompt('Assign driver to ' + e.vehicle + ' on ' + e.date + ':\n\n' + list + '\n\nEnter name or number:');
      if (!drv) return;
      var num = parseInt(drv, 10);
      e.driver = (!isNaN(num) && num >= 1 && num <= _drivers.length) ? _drivers[num - 1] : drv;
      e.status = 'assigned';
      render();
      toast('Driver assigned: ' + e.driver, '#3fb950');
    },

    /* Select-all / row check */
    toggleSelectAll: function (cb) {
      document.querySelectorAll('#tableBody input[type=checkbox]').forEach(function (c) { c.checked = cb.checked; });
    },

    checkRow: function (cb, idx) {
      if (_filteredEvents[idx]) _filteredEvents[idx].checked = cb.checked;
    },

    openAssignAll: function () {
      var sel = _filteredEvents.filter(function (e) { return e.checked; });
      if (!sel.length) { toast('No events selected', '#f85149'); return; }
      var list = _drivers.map(function (d, i) { return (i + 1) + '. ' + d; }).join('\n');
      var drv = prompt('Assign driver to ' + sel.length + ' selected events:\n\n' + list + '\n\nEnter name or number:');
      if (!drv) return;
      var num  = parseInt(drv, 10);
      var name = (!isNaN(num) && num >= 1 && num <= _drivers.length) ? _drivers[num - 1] : drv;
      sel.forEach(function (e) { e.driver = name; e.status = 'assigned'; e.checked = false; });
      render();
      toast('Assigned ' + sel.length + ' events to ' + name, '#3fb950');
    },

    /* Export */
    exportCSV: function () {
      var evts = getFiltered();
      if (!evts.length) { toast('No data to export', '#f85149'); return; }
      var hdr  = ['ID','Vehicle','Date','Start','Duration (min)','Distance (km)','HOS Rule','Status','Driver','Annotation'];
      var rows = evts.map(function (e) {
        return [e.id, e.vehicle, e.date, e.start, e.durationMin, e.distanceKm, e.hosRule, e.status, e.driver || '', e.annotation || '']
          .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
      });
      var csv  = [hdr.join(',')].concat(rows).join('\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href   = url;
      a.download = 'unidentified-driving-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('CSV exported', '#3fb950');
    }
  };
})();

/* ── Geotab Add-in Entry Point ───────────────────────────────── */
geotab.addin = geotab.addin || {};
geotab.addin.unidentifieddriving = function () {
  var _api   = null;
  var _state = null;

  return {
    /**
     * initialize — store references, call the callback immediately.
     * Do NOT call api.getSession() here; session isn't guaranteed ready
     * until focus() fires. Matches the reference add-in pattern exactly.
     */
    initialize: function (freshApi, freshState, initializeCallback) {
      _api   = freshApi;
      _state = freshState;
      if (typeof initializeCallback === 'function') initializeCallback();
    },

    /**
     * focus — called every time the user navigates to this add-in.
     * Correct place to call api.getSession() and kick off data loading.
     */
    focus: function (freshApi, freshState) {
      _api   = freshApi;
      _state = freshState;

      _api.getSession(function (session) {
        // Pass the authenticated API to the dashboard
        unidDash.init(_api, session.database);
      });
    },

    blur: function () {}
  };
};