/* =========================================================
   Unidentified Driving — HOS Dashboard  |  addin.js
   Geotab Add-in entry point: geotab.addin.unidentifieddriving
   ========================================================= */

var unidDash = (function () {

  /* ── Private state ─────────────────────────────────────── */
  var _api             = null;
  var _currentPeriod   = 3;
  var _currentStatus   = 'all';
  var _currentSearch   = '';
  var _groupFilter     = null;  // 'unassigned' | 'resolved' | 'vehicles'
  var _sortKey         = 'date';
  var _sortDir         = -1;
  var _currentPage     = 1;
  var _PER_PAGE        = 20;
  var _filteredEvents  = [];
  var _allEvents       = [];
  var _vehicles        = [];
  var _drivers         = [];
  var _isLight         = false;
  var _toastTimer      = null;
  var _initialized     = false;
  var _openEventIdx    = null;   // index into _filteredEvents for the open panel
  var _selectedDriver  = null;   // { name, id } for the resolve panel
  var _bulkDriver      = null;
  var _hosRules        = ['Canada South 70h','Canada North 120h','US 60h/7d','US 70h/8d','Exempt'];

  /* ── Utilities ─────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function fmtTime(h, m) { return pad(h) + ':' + pad(m); }
  function fmtDur(m) {
    var h = Math.floor(m/60), mm = m%60;
    return h > 0 ? h + 'h ' + pad(mm) + 'm' : mm + 'm';
  }
  function fmtDist(k) { return k + ' km'; }

  function initials(name) {
    var parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
    return name.slice(0,2).toUpperCase();
  }

  function toast(msg, color) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = color || '#0C2853';
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
  }

  function setErr(msg) {
    var el = document.getElementById('errBox');
    if (!el) return;
    if (msg) {
      el.className = 'err-box';
      el.textContent = msg;
    } else {
      el.className = '';
      el.textContent = '';
    }
  }

  /* ── Theme ─────────────────────────────────────────────── */
  function applyTheme(isLight) {
    _isLight = isLight;
    if (isLight) {
      document.body.classList.add('light');
    } else {
      document.body.classList.remove('light');
    }
    var lbl = document.getElementById('themeLbl');
    if (lbl) lbl.textContent = isLight ? 'LIGHT' : 'DARK';
    drawDonut();
  }

  /* ── Date subtitle ─────────────────────────────────────── */
  function updateDateRange() {
    var el = document.getElementById('dateRange');
    if (!el) return;
    var now  = new Date();
    var from = new Date(now - _currentPeriod * 30 * 86400000);
    el.textContent = fmtDate(from) + '  →  ' + fmtDate(now);
  }

  /* ── Filter helpers ─────────────────────────────────────── */
  function getFiltered() {
    var now    = new Date();
    var cutoff = new Date(now - _currentPeriod * 30 * 86400000);
    return _allEvents.filter(function (e) {
      if (e.dateObj < cutoff) return false;

      // header status filter
      if (_currentStatus === 'unassigned' && e.status !== 'unassigned') return false;
      if (_currentStatus === 'resolved'   && e.status === 'unassigned') return false;

      // KPI group filter
      if (_groupFilter === 'unassigned' && e.status !== 'unassigned') return false;
      if (_groupFilter === 'resolved'   && e.status === 'unassigned') return false;

      // search
      if (_currentSearch) {
        var q = _currentSearch;
        if (e.vehicle.toLowerCase().indexOf(q) === -1 &&
            (e.driver||'').toLowerCase().indexOf(q) === -1 &&
            e.id.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* ── KPI update ─────────────────────────────────────────── */
  function updateKPIs(evts) {
    var now    = new Date();
    var cutoff = new Date(now - _currentPeriod * 30 * 86400000);
    var period = _allEvents.filter(function(e){ return e.dateObj >= cutoff; });

    var totalMin = period.reduce(function(s,e){ return s+e.durationMin; }, 0);
    var vSet = {};
    period.forEach(function(e){ vSet[e.vehicle] = true; });
    var unassigned = period.filter(function(e){ return e.status === 'unassigned'; }).length;
    var resolved   = period.filter(function(e){ return e.status !== 'unassigned'; }).length;

    setText('kpiTotal',     period.length);
    setText('kpiHours',     Math.floor(totalMin/60) + 'h');
    setText('kpiVehicles',  Object.keys(vSet).length);
    setText('kpiFleetSub',  'of ' + _vehicles.length + ' fleet');
    setText('kpiUnassigned',unassigned);
    setText('kpiResolved',  resolved);

    // foot
    setText('foot', period.length + ' events · ' + Object.keys(vSet).length + ' vehicles · ' + _currentPeriod + '-month window');
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Bar Chart ──────────────────────────────────────────── */
  function drawBarChart() {
    var container = document.getElementById('barChart');
    if (!container) return;
    var now = new Date();
    var months = [];
    for (var i = 5; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      months.push({ label: d.toLocaleString('default',{month:'short'}), year: d.getFullYear(), month: d.getMonth() });
    }
    var data = months.map(function(m) {
      var me = _allEvents.filter(function(e) {
        return e.dateObj.getFullYear()===m.year && e.dateObj.getMonth()===m.month;
      });
      return {
        label:      m.label,
        unassigned: me.filter(function(e){ return e.status==='unassigned'; }).length,
        assigned:   me.filter(function(e){ return e.status==='assigned'; }).length,
        annotated:  me.filter(function(e){ return e.status==='annotated'; }).length
      };
    });
    var maxVal = Math.max.apply(null, data.map(function(d){ return d.unassigned+d.assigned+d.annotated; }).concat([1]));
    container.innerHTML = '';
    data.forEach(function(d) {
      var unH = Math.round((d.unassigned/maxVal)*100);
      var asH = Math.round((d.assigned/maxVal)*100);
      var anH = Math.round((d.annotated/maxVal)*100);
      container.innerHTML += '<div class="bar-group">' +
        '<div class="bar-wrap">' +
          '<div class="bar" style="background:var(--score-red);height:'+unH+'%" data-tip="'+d.unassigned+' unassigned"></div>' +
          '<div class="bar" style="background:var(--accent);height:'+asH+'%" data-tip="'+d.assigned+' assigned"></div>' +
          '<div class="bar" style="background:var(--accent-hi);height:'+anH+'%" data-tip="'+d.annotated+' annotated"></div>' +
        '</div>' +
        '<span class="bar-month">'+d.label+'</span>' +
      '</div>';
    });
  }

  /* ── Donut Chart ─────────────────────────────────────────── */
  function drawDonut() {
    var now    = new Date();
    var cutoff = new Date(now - _currentPeriod * 30 * 86400000);
    var period = _allEvents.filter(function(e){ return e.dateObj >= cutoff; });
    var u = period.filter(function(e){ return e.status==='unassigned'; }).length;
    var a = period.filter(function(e){ return e.status==='assigned'; }).length;
    var n = period.filter(function(e){ return e.status==='annotated'; }).length;
    var total = (u+a+n)||1;

    var segs = [
      { val:u, color:'var(--score-red)', hex:'#ef4444', label:'Unassigned' },
      { val:a, color:'var(--accent)',    hex:'#c8102e', label:'Assigned'   },
      { val:n, color:'var(--accent-hi)', hex:'#e8334a', label:'Annotated'  }
    ];

    var cx=65, cy=65, r=50, ir=32, tau=Math.PI*2;
    var start=0, paths='';
    segs.forEach(function(s) {
      var frac  = s.val/total;
      var sweep = frac*tau;
      var end   = start+sweep;
      var x1=cx+r*Math.sin(start), y1=cy-r*Math.cos(start);
      var x2=cx+r*Math.sin(end),   y2=cy-r*Math.cos(end);
      var ix1=cx+ir*Math.sin(start),iy1=cy-ir*Math.cos(start);
      var ix2=cx+ir*Math.sin(end),  iy2=cy-ir*Math.cos(end);
      var lg = sweep>Math.PI?1:0;
      if (frac>0.001) paths += '<path d="M'+x1+','+y1+' A'+r+','+r+' 0 '+lg+',1 '+x2+','+y2+' L'+ix2+','+iy2+' A'+ir+','+ir+' 0 '+lg+',0 '+ix1+','+iy1+' Z" fill="'+s.color+'" opacity=".88"/>';
      start = end;
    });
    var fillText = _isLight ? '#051022' : '#e8edf5';
    paths += '<text x="65" y="60" text-anchor="middle" font-family="DM Mono,monospace" font-size="20" font-weight="800" fill="'+fillText+'">'+total+'</text>';
    paths += '<text x="65" y="74" text-anchor="middle" font-family="DM Mono,monospace" font-size="9" fill="#4d6d96" letter-spacing="1">EVENTS</text>';

    var svg = document.getElementById('donutSvg');
    if (svg) svg.innerHTML = paths;

    var lblEl = document.getElementById('donutLabels');
    if (lblEl) {
      lblEl.innerHTML = segs.map(function(s) {
        var pct = total > 0 ? Math.round(s.val/total*100) : 0;
        return '<div class="donut-label-item">' +
          '<span class="donut-dot" style="background:'+s.color+'"></span>' +
          '<span>'+s.label+'</span>' +
          '<span class="donut-pct" style="color:'+s.color+'">'+pct+'%</span>' +
        '</div>';
      }).join('');
    }
  }

  /* ── Table ──────────────────────────────────────────────── */
  function renderTable(evts) {
    // sort
    evts.sort(function(a,b) {
      var va, vb;
      if      (_sortKey==='vehicle')  { va=a.vehicle;     vb=b.vehicle; }
      else if (_sortKey==='date')     { va=a.dateObj;     vb=b.dateObj; }
      else if (_sortKey==='duration') { va=a.durationMin; vb=b.durationMin; }
      else if (_sortKey==='distance') { va=a.distanceKm;  vb=b.distanceKm; }
      else                            { va=a.start;       vb=b.start; }
      if (va<vb) return -1*_sortDir;
      if (va>vb) return  1*_sortDir;
      return 0;
    });
    _filteredEvents = evts;

    var start = (_currentPage-1)*_PER_PAGE;
    var page  = evts.slice(start, start+_PER_PAGE);

    var html = '<table>' +
      '<thead><tr>' +
        '<th class="th-check"><input type="checkbox" id="selectAll" onchange="unidDash.toggleSelectAll(this)"/></th>' +
        '<th onclick="unidDash.sortBy(\'vehicle\')">Vehicle'+sortArrow('vehicle')+'</th>' +
        '<th onclick="unidDash.sortBy(\'date\')">Date'+sortArrow('date')+'</th>' +
        '<th onclick="unidDash.sortBy(\'start\')">Start</th>' +
        '<th onclick="unidDash.sortBy(\'duration\')">Duration'+sortArrow('duration')+'</th>' +
        '<th onclick="unidDash.sortBy(\'distance\')">Distance'+sortArrow('distance')+'</th>' +
        '<th>HOS Rule</th>' +
        '<th class="th-status">Status</th>' +
        '<th>Driver</th>' +
        '<th>Note</th>' +
        '<th class="th-actions">Resolve</th>' +
      '</tr></thead>' +
      '<tbody>';

    page.forEach(function(e, i) {
      var idx     = start + i;
      var pct     = Math.min(100, Math.round(e.durationMin/240*100));
      var barClr  = pct>75 ? 'var(--score-red)' : pct>40 ? 'var(--score-yellow)' : 'var(--accent)';
      var badge   = e.status==='unassigned'
        ? '<span class="badge badge-unassigned">&#9888; Unassigned</span>'
        : e.status==='assigned'
        ? '<span class="badge badge-assigned">&#10003; Assigned</span>'
        : '<span class="badge badge-annotated">&#9998; Annotated</span>';
      var driverTxt = e.driver
        ? '<span style="font-size:.8rem;font-weight:600;color:var(--text)">'+e.driver+'</span>'
        : '<span style="color:var(--text3);font-size:.78rem;">—</span>';
      var noteTxt = e.annotation
        ? '<span class="note-cell" title="'+e.annotation+'">'+e.annotation+'</span>'
        : '<span class="note-none">—</span>';
      var resolveTxt = e.status==='unassigned' ? 'Resolve' : 'Edit';
      var resolveClass = e.status==='unassigned' ? 'btn-resolve' : 'btn-resolve resolved';

      html += '<tr class="'+(e.checked?'row-selected':'')+'">' +
        '<td class="td-check"><input type="checkbox" '+(e.checked?'checked':'')+' onchange="unidDash.checkRow(this,'+idx+')"/></td>' +
        '<td><div class="veh-cell"><span class="veh-dot" style="background:'+e.vehicleColor+'"></span><span class="veh-name">'+e.vehicle+'</span></div></td>' +
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.date+'</td>' +
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.start+'</td>' +
        '<td><div class="dur-wrap"><span class="dur-txt">'+fmtDur(e.durationMin)+'</span><div class="dur-bar"><div class="dur-fill" style="width:'+pct+'%;background:'+barClr+'"></div></div></div></td>' +
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+fmtDist(e.distanceKm)+'</td>' +
        '<td style="font-size:.75rem;color:var(--text3);">'+e.hosRule+'</td>' +
        '<td class="td-status">'+badge+'</td>' +
        '<td>'+driverTxt+'</td>' +
        '<td>'+noteTxt+'</td>' +
        '<td class="td-actions"><button class="'+resolveClass+'" onclick="unidDash.openPanel('+idx+')">'+resolveTxt+'</button></td>' +
      '</tr>';
    });

    html += '</tbody></table>';

    // pagination
    var totalPages = Math.ceil(evts.length/_PER_PAGE) || 1;
    html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--border);">' +
      '<span style="font-size:.72rem;font-family:\'DM Mono\',monospace;color:var(--text3);">' +
        'Showing '+(evts.length?start+1:0)+'–'+Math.min(start+_PER_PAGE,evts.length)+' of '+evts.length +
      '</span>' +
      '<div style="display:flex;gap:4px;">';
    html += '<button onclick="unidDash.goPage('+(_currentPage-1)+')" style="'+pageBtnStyle(false)+'">&#8249;</button>';
    for (var p=1; p<=totalPages; p++) {
      if (totalPages>7 && p>2 && p<totalPages-1 && Math.abs(p-_currentPage)>1) {
        if (p===3||p===totalPages-2) html += '<span style="color:var(--text3);padding:0 4px;">…</span>';
        continue;
      }
      html += '<button onclick="unidDash.goPage('+p+')" style="'+pageBtnStyle(p===_currentPage)+'">'+p+'</button>';
    }
    html += '<button onclick="unidDash.goPage('+(_currentPage+1)+')" style="'+pageBtnStyle(false)+'">&#8250;</button>';
    html += '</div></div>';

    var tbl = document.getElementById('tbl');
    if (tbl) tbl.innerHTML = html;

    updateBulkBtn();
  }

  function pageBtnStyle(active) {
    var base = 'width:28px;height:28px;border-radius:5px;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);transition:all .15s;';
    if (active) return base + 'background:var(--accent);border-color:var(--accent);color:#fff;';
    return base + 'background:var(--bg3);color:var(--text2);';
  }

  function sortArrow(key) {
    if (_sortKey !== key) return '';
    return ' <i class="sort-arrow">'+ (_sortDir===1?'↑':'↓') +'</i>';
  }

  /* ── Full render ─────────────────────────────────────────── */
  function render() {
    var evts = getFiltered();
    updateKPIs(evts);
    drawBarChart();
    drawDonut();
    renderTable(evts);
    updateDateRange();
    updateFilterBadge();
  }

  function updateFilterBadge() {
    var el = document.getElementById('filterBadge');
    if (!el) return;
    if (_groupFilter) {
      var labels = { unassigned:'Unassigned Only', resolved:'Resolved Only', vehicles:'Affected Vehicles' };
      el.style.display = 'inline-flex';
      el.className = 'filter-badge';
      el.innerHTML = '<span class="filter-dot" style="background:var(--accent)"></span>' + (labels[_groupFilter]||_groupFilter) +
        '<span class="filter-x" onclick="unidDash.clearGroupFilter()">&#10005;</span>';
    } else {
      el.style.display = 'none';
    }
  }

  /* ── Resolve Panel ───────────────────────────────────────── */
  function buildDriverList(searchEl, dropdownEl, onSelect) {
    var q = (searchEl.value || '').toLowerCase().trim();
    var matched = q
      ? _drivers.filter(function(d){ return d.toLowerCase().indexOf(q) !== -1; })
      : _drivers.slice(0, 30);

    if (!matched.length) {
      dropdownEl.innerHTML = '<div class="driver-no-results">No drivers found</div>';
    } else {
      dropdownEl.innerHTML = matched.map(function(d) {
        return '<div class="driver-option" onclick="('+onSelect.toString()+')(\''+d.replace(/'/g,"\\'")+'\')">' +
          '<span class="driver-avatar">'+initials(d)+'</span>'+d+'</div>';
      }).join('');
    }
    dropdownEl.style.display = 'block';
  }

  function generateTimeline(dt, sh, sm, dur) {
    var lines = [];
    var base = new Date(dt); base.setHours(sh, sm, 0);
    lines.push({ time: fmtTime(sh,sm)+' — Engine start', desc: 'Vehicle ignition detected, no driver card present', color:'var(--score-yellow)' });
    var mid = new Date(base.getTime() + dur/2*60000);
    lines.push({ time: fmtTime(mid.getHours(),mid.getMinutes())+' — Speed event', desc: 'Travelling '+(+(dur/2*0.6).toFixed(1))+' km from depot', color:'var(--accent)' });
    var end = new Date(base.getTime() + dur*60000);
    lines.push({ time: fmtTime(end.getHours(),end.getMinutes())+' — Engine off', desc: 'Vehicle stopped, event closed', color:'var(--score-red)' });
    return lines;
  }

  /* ── Geotab data loading ─────────────────────────────────── */
  function loadFromGeotab() {
    if (!_api) { loadDemoData(); return; }
    setErr('');
    var now  = new Date();
    var from = new Date(now - 6*30*86400000);

    _api.call('Get', { typeName:'Device', resultsLimit:500 }, function(devices) {
      _vehicles = (devices||[]).map(function(d){ return { id:d.id, name:d.name||d.id }; });
      setText('kpiFleetSub', 'of '+_vehicles.length+' fleet');

      _api.call('Get', { typeName:'User', resultsLimit:500 }, function(users) {
        _drivers = (users||[]).map(function(u){
          return ((u.firstName||'') + (u.lastName?' '+u.lastName:'')).trim() || u.name || u.id;
        }).filter(Boolean);

        _api.call('Get', {
          typeName: 'ExceptionEvent',
          search: { fromDate:from.toISOString(), toDate:now.toISOString(), ruleName:'Unidentified Driver Activity' },
          resultsLimit: 2000
        }, function(events) {
          if (!events||!events.length) { loadDemoData(); return; }
          processExceptionEvents(events);
        }, function() { loadDemoData(); });
      }, function() { _drivers=[]; loadDemoData(); });
    }, function() { loadDemoData(); });
  }

  function processExceptionEvents(events) {
    var palette = ['#ef4444','#f59e0b','#3a6bb5','#10b981','#c8102e','#e8334a','#60a5fa','#a78bfa','#34d399','#fb923c'];
    var vColorMap = {}, colorIdx = 0;
    _allEvents = events.map(function(evt, i) {
      var dt    = new Date(evt.activeFrom||evt.dateTime);
      var endDt = new Date(evt.activeTo||evt.dateTime);
      var dur   = Math.max(1, Math.round((endDt-dt)/60000));
      var vId   = (evt.device&&evt.device.id) ? evt.device.id : 'UNKNOWN';
      if (!vColorMap[vId]) { vColorMap[vId] = palette[colorIdx%palette.length]; colorIdx++; }
      var vName = vId;
      for (var k=0;k<_vehicles.length;k++) { if (_vehicles[k].id===vId){ vName=_vehicles[k].name; break; } }
      return {
        id: 'EVT-'+(10000+i), vehicle:vName, vehicleColor:vColorMap[vId],
        date:fmtDate(dt), dateObj:dt, start:fmtTime(dt.getHours(),dt.getMinutes()),
        durationMin:dur, distanceKm:+(dur*0.6).toFixed(1),
        hosRule:(evt.rule&&evt.rule.name)||'Unidentified Driver',
        status:'unassigned', driver:null, annotation:null, checked:false,
        timeline:generateTimeline(dt,dt.getHours(),dt.getMinutes(),dur)
      };
    });
    _allEvents.sort(function(a,b){ return b.dateObj-a.dateObj; });
    render();
    toast('Loaded '+_allEvents.length+' events', '#10b981');
  }

  /* ── Demo data ───────────────────────────────────────────── */
  function loadDemoData() {
    var vDefs=[
      {id:'VH-1041',color:'#ef4444'},{id:'VH-2083',color:'#f59e0b'},
      {id:'VH-3317',color:'#3a6bb5'},{id:'VH-4092',color:'#10b981'},
      {id:'VH-5504',color:'#a78bfa'},{id:'VH-6610',color:'#e8334a'},
      {id:'VH-7728',color:'#60a5fa'},{id:'VH-8831',color:'#fb923c'},
      {id:'VH-9043',color:'#34d399'},{id:'VH-0175',color:'#c8102e'}
    ];
    _vehicles = vDefs.map(function(v){ return {id:v.id,name:v.id}; });
    _drivers  = ['J. Harrington','M. Delacroix','T. Okonkwo','S. Patel','R. Vasquez',
                 'L. Nguyen','K. Brennan','D. Achebe','F. Morales','B. Nakamura'];
    var annotations=['Vehicle taken home — approved yard move','Pre-trip inspection drive',
      'Maintenance road test','Driver forgot to log in',
      'ELD malfunction reported — manual logs filed','Authorized personal conveyance',null,null,null,null];
    var statusTypes=['unassigned','assigned','annotated'];
    var now=new Date();
    function ri(a,b){return a+Math.floor(Math.random()*(b-a+1));}
    function ro(a){return a[Math.floor(Math.random()*a.length)];}

    _allEvents=[];
    for(var i=0;i<180;i++){
      var daysBack=ri(0,180);
      var dt=new Date(now-daysBack*86400000);
      var sh=ri(4,21),sm=ri(0,59),dur=ri(5,240);
      var distKm=+(dur*ro([0.4,0.5,0.6,0.7,0.8])).toFixed(1);
      var veh=ro(vDefs), st=ro(statusTypes);
      var ann=st==='annotated'?ro(annotations.filter(Boolean)):null;
      var drv=st==='assigned'?ro(_drivers):null;
      _allEvents.push({
        id:'EVT-'+(10000+i),vehicle:veh.id,vehicleColor:veh.color,
        date:fmtDate(dt),dateObj:dt,start:fmtTime(sh,sm),
        durationMin:dur,distanceKm:distKm,hosRule:ro(_hosRules),
        status:st,driver:drv,annotation:ann,checked:false,
        timeline:generateTimeline(dt,sh,sm,dur)
      });
    }
    _allEvents.sort(function(a,b){return b.dateObj-a.dateObj;});
    render();
  }

  /* ── Bulk button visibility ──────────────────────────────── */
  function updateBulkBtn() {
    var count = _allEvents.filter(function(e){ return e.checked; }).length;
    var btn   = document.getElementById('btnBulk');
    var cntEl = document.getElementById('selCount');
    if (!btn) return;
    if (count>0) {
      btn.style.display = 'inline-flex';
      if (cntEl) cntEl.textContent = count;
    } else {
      btn.style.display = 'none';
    }
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {

    init: function(api) {
      _api = api;
      var root = document.getElementById('unidentifieddriving');
      if (root) root.style.display = '';
      if (!_initialized) {
        _initialized = true;
        // close driver dropdowns when clicking outside
        document.addEventListener('click', function(e) {
          var ds = document.getElementById('driverSearch');
          var dd = document.getElementById('driverDropdown');
          if (dd && ds && !ds.contains(e.target) && !dd.contains(e.target)) {
            dd.style.display = 'none';
          }
          var bs = document.getElementById('bulkDriverSearch');
          var bd = document.getElementById('bulkDriverDropdown');
          if (bd && bs && !bs.contains(e.target) && !bd.contains(e.target)) {
            bd.style.display = 'none';
          }
        });
      }
      loadFromGeotab();
    },

    /* Header controls */
    setPeriod: function(m, evt) {
      _currentPeriod = m; _currentPage = 1;
      if (evt) {
        var grp = evt.target.closest('.range-group');
        if (grp) grp.querySelectorAll('.range-btn').forEach(function(b){ b.classList.remove('active'); });
        evt.target.classList.add('active');
      }
      render();
    },

    setStatus: function(s, evt) {
      _currentStatus = s; _currentPage = 1;
      if (evt) {
        var grp = evt.target.closest('.range-group');
        if (grp) grp.querySelectorAll('.range-btn').forEach(function(b){ b.classList.remove('active'); });
        evt.target.classList.add('active');
      }
      render();
    },

    toggleTheme: function() { applyTheme(!_isLight); },

    refresh: function() {
      _allEvents = [];
      var tbl = document.getElementById('tbl');
      if (tbl) tbl.innerHTML = '<div class="box"><div class="spinner"></div><div class="msg-txt">LOADING…</div></div>';
      loadFromGeotab();
    },

    /* Table interactions */
    filterSearch: function() {
      _currentSearch = (document.getElementById('srch')||{}).value.toLowerCase()||'';
      _currentPage = 1;
      render();
    },

    sortBy: function(key) {
      if (_sortKey===key) { _sortDir*=-1; } else { _sortKey=key; _sortDir=-1; }
      render();
    },

    goPage: function(p) {
      var total = Math.ceil(_filteredEvents.length/_PER_PAGE)||1;
      if (p<1||p>total) return;
      _currentPage=p; renderTable(_filteredEvents);
    },

    filterGroup: function(group) {
      _groupFilter = (_groupFilter===group) ? null : group;
      _currentPage = 1;
      render();
    },

    clearGroupFilter: function() {
      _groupFilter = null; _currentPage = 1; render();
    },

    toggleSelectAll: function(cb) {
      var start = (_currentPage-1)*_PER_PAGE;
      var page  = _filteredEvents.slice(start, start+_PER_PAGE);
      page.forEach(function(e){ e.checked = cb.checked; });
      renderTable(_filteredEvents);
    },

    checkRow: function(cb, idx) {
      if (_filteredEvents[idx]) _filteredEvents[idx].checked = cb.checked;
      updateBulkBtn();
    },

    /* ── Resolve Panel ── */
    openPanel: function(idx) {
      var e = _filteredEvents[idx];
      if (!e) return;
      _openEventIdx   = idx;
      _selectedDriver = e.driver ? { name: e.driver } : null;

      // populate meta
      setText('panelEventId',   e.id);
      setText('panelEventMeta', e.vehicle + '  ·  ' + e.date + '  ·  ' + e.start + '  ·  ' + fmtDur(e.durationMin) + '  ·  ' + fmtDist(e.distanceKm));

      // driver search
      var ds = document.getElementById('driverSearch');
      var dd = document.getElementById('driverDropdown');
      var sd = document.getElementById('selectedDriverDisplay');
      var sn = document.getElementById('selectedDriverName');
      if (ds) ds.value = '';
      if (dd) dd.style.display = 'none';

      if (_selectedDriver && sd && sn) {
        sd.style.display = 'flex';
        sn.textContent   = _selectedDriver.name;
        if (ds) ds.style.display = 'none';
      } else {
        if (sd) sd.style.display = 'none';
        if (ds) ds.style.display = 'block';
      }

      // annotation
      var ta = document.getElementById('annotationNote');
      if (ta) ta.value = e.annotation || '';

      // reset preset chips
      document.querySelectorAll('#presetChips .preset-chip').forEach(function(c){ c.classList.remove('active'); });
      if (e.annotation) {
        document.querySelectorAll('#presetChips .preset-chip').forEach(function(c){
          if (c.textContent === e.annotation) c.classList.add('active');
        });
      }

      var panel = document.getElementById('panelAssign');
      if (panel) { panel.classList.add('open'); panel.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
    },

    closePanel: function() {
      var panel = document.getElementById('panelAssign');
      if (panel) panel.classList.remove('open');
      _openEventIdx  = null;
      _selectedDriver = null;
    },

    /* Driver search in resolve panel */
    showDriverList: function() {
      var ds = document.getElementById('driverSearch');
      var dd = document.getElementById('driverDropdown');
      if (!ds||!dd) return;
      buildDriverList(ds, dd, function(name) {
        unidDash.selectDriver(name);
      });
    },

    filterDriverList: function() {
      var ds = document.getElementById('driverSearch');
      var dd = document.getElementById('driverDropdown');
      if (!ds||!dd) return;
      buildDriverList(ds, dd, function(name) {
        unidDash.selectDriver(name);
      });
    },

    selectDriver: function(name) {
      _selectedDriver = { name: name };
      var ds = document.getElementById('driverSearch');
      var dd = document.getElementById('driverDropdown');
      var sd = document.getElementById('selectedDriverDisplay');
      var sn = document.getElementById('selectedDriverName');
      if (dd) dd.style.display = 'none';
      if (ds) { ds.value = ''; ds.style.display = 'none'; }
      if (sn) sn.textContent = name;
      if (sd) sd.style.display = 'flex';
    },

    clearDriver: function() {
      _selectedDriver = null;
      var ds = document.getElementById('driverSearch');
      var sd = document.getElementById('selectedDriverDisplay');
      if (ds) { ds.value = ''; ds.style.display = 'block'; }
      if (sd) sd.style.display = 'none';
    },

    /* Annotation presets */
    setPreset: function(chip) {
      var ta = document.getElementById('annotationNote');
      document.querySelectorAll('#presetChips .preset-chip').forEach(function(c){ c.classList.remove('active'); });
      if (ta && ta.value === chip.textContent) {
        ta.value = '';  // toggle off
      } else {
        chip.classList.add('active');
        if (ta) ta.value = chip.textContent;
      }
    },

    saveResolve: function() {
      if (_openEventIdx === null) return;
      var e    = _filteredEvents[_openEventIdx];
      if (!e) return;
      var note = (document.getElementById('annotationNote')||{}).value || '';
      note = note.trim();

      if (!_selectedDriver && !note) {
        toast('Assign a driver or add a note to resolve this event', '#f59e0b');
        return;
      }

      if (_selectedDriver) { e.driver = _selectedDriver.name; }
      if (note)            { e.annotation = note; }

      // determine resolved status
      if (_selectedDriver && note)       { e.status = 'assigned'; }
      else if (_selectedDriver && !note) { e.status = 'assigned'; }
      else                               { e.status = 'annotated'; }

      unidDash.closePanel();
      render();
      toast('Event resolved', '#10b981');
    },

    /* ── Bulk Assign Panel ── */
    openBulkPanel: function() {
      var count = _allEvents.filter(function(e){ return e.checked; }).length;
      if (!count) { toast('Select events first using the checkboxes', '#f59e0b'); return; }
      setText('bulkCount', count + ' event' + (count!==1?'s':'') + ' selected');
      _bulkDriver = null;
      var bs = document.getElementById('bulkDriverSearch');
      var bd = document.getElementById('bulkDriverDropdown');
      var bsd = document.getElementById('bulkSelectedDisplay');
      var bn  = document.getElementById('bulkNote');
      if (bs)  { bs.value = ''; bs.style.display = 'block'; }
      if (bd)  bd.style.display = 'none';
      if (bsd) bsd.style.display = 'none';
      if (bn)  bn.value = '';
      var panel = document.getElementById('panelBulk');
      if (panel) { panel.classList.add('open'); panel.scrollIntoView({ behavior:'smooth', block:'nearest' }); }
    },

    closeBulkPanel: function() {
      var panel = document.getElementById('panelBulk');
      if (panel) panel.classList.remove('open');
      _bulkDriver = null;
    },

    showBulkDriverList: function() {
      var bs = document.getElementById('bulkDriverSearch');
      var bd = document.getElementById('bulkDriverDropdown');
      if (!bs||!bd) return;
      buildDriverList(bs, bd, function(name) { unidDash.selectBulkDriver(name); });
    },

    filterBulkDriverList: function() {
      var bs = document.getElementById('bulkDriverSearch');
      var bd = document.getElementById('bulkDriverDropdown');
      if (!bs||!bd) return;
      buildDriverList(bs, bd, function(name) { unidDash.selectBulkDriver(name); });
    },

    selectBulkDriver: function(name) {
      _bulkDriver = { name: name };
      var bs  = document.getElementById('bulkDriverSearch');
      var bd  = document.getElementById('bulkDriverDropdown');
      var bsd = document.getElementById('bulkSelectedDisplay');
      var bsn = document.getElementById('bulkSelectedName');
      if (bd)  bd.style.display = 'none';
      if (bs)  { bs.value=''; bs.style.display='none'; }
      if (bsn) bsn.textContent = name;
      if (bsd) bsd.style.display = 'flex';
    },

    clearBulkDriver: function() {
      _bulkDriver = null;
      var bs  = document.getElementById('bulkDriverSearch');
      var bsd = document.getElementById('bulkSelectedDisplay');
      if (bs)  { bs.value=''; bs.style.display='block'; }
      if (bsd) bsd.style.display='none';
    },

    saveBulkAssign: function() {
      if (!_bulkDriver) { toast('Select a driver first', '#f59e0b'); return; }
      var note  = ((document.getElementById('bulkNote')||{}).value||'').trim();
      var sel   = _allEvents.filter(function(e){ return e.checked; });
      if (!sel.length) { toast('No events selected', '#f59e0b'); return; }
      sel.forEach(function(e) {
        e.driver  = _bulkDriver.name;
        e.status  = 'assigned';
        e.checked = false;
        if (note) e.annotation = note;
      });
      unidDash.closeBulkPanel();
      render();
      toast('Assigned '+sel.length+' event'+(sel.length!==1?'s':'')+' to '+_bulkDriver.name, '#10b981');
    },

    /* Export */
    exportCSV: function() {
      var evts = getFiltered();
      if (!evts.length) { toast('No data to export', '#ef4444'); return; }
      var hdr  = ['ID','Vehicle','Date','Start','Duration (min)','Distance (km)','HOS Rule','Status','Driver','Note'];
      var rows = evts.map(function(e) {
        return [e.id,e.vehicle,e.date,e.start,e.durationMin,e.distanceKm,e.hosRule,e.status,e.driver||'',e.annotation||'']
          .map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(',');
      });
      var csv  = [hdr.join(',')].concat(rows).join('\n');
      var blob = new Blob([csv],{type:'text/csv'});
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href   = url;
      a.download = 'unidentified-driving-'+new Date().toISOString().slice(0,10)+'.csv';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
      toast('CSV exported', '#10b981');
    }
  };
})();

/* ── Geotab Add-in Entry Point ───────────────────────────── */
geotab.addin = geotab.addin || {};
geotab.addin.unidentifieddriving = function () {
  var _api   = null;
  var _state = null;

  return {
    initialize: function (freshApi, freshState, initializeCallback) {
      _api   = freshApi;
      _state = freshState;
      if (typeof initializeCallback === 'function') initializeCallback();
    },

    focus: function (freshApi, freshState) {
      _api   = freshApi;
      _state = freshState;
      _api.getSession(function (session) {
        unidDash.init(_api, session.database);
      });
    },

    blur: function () {}
  };
};