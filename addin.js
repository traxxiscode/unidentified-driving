/* =========================================================
   Unidentified Driving — HOS Dashboard  |  addin.js
   Geotab Add-in entry point: geotab.addin.unidentifieddriving

   NOTE: Geotab API does not allow driver assignment to
   unidentified driving logs. Each row instead links directly
   to the Geotab unidentifiedDriving page, pre-filtered to
   show only that single log's date/time window.
   ========================================================= */

var unidDash = (function () {

  /* ── Private state ─────────────────────────────────────── */
  var _api            = null;
  var _sessionUserId  = null;
  var _currentPeriod  = 3;
  var _currentStatus  = 'all';
  var _currentSearch  = '';
  var _groupFilter    = null;
  var _sortKey        = 'date';
  var _sortDir        = -1;
  var _currentPage    = 1;
  var _PER_PAGE       = 20;
  var _filteredEvents = [];
  var _allEvents      = [];
  var _vehicles       = [];
  var _isLight        = false;
  var _toastTimer     = null;
  var _initialized    = false;
  var _geotabDatabase = null;   // populated from session for link building

  /* ── Constants ──────────────────────────────────────────── */
  var KM_TO_MI        = 0.621371;
  var MIN_DIST_MI     = 0.25;   // events below this threshold are hidden

  /* ── Utilities ─────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function fmtTime(h, m) { return pad(h) + ':' + pad(m); }
  function fmtDur(m) { var h=Math.floor(m/60),mm=m%60; return h>0?h+'h '+pad(mm)+'m':mm+'m'; }

  /** Display distance in miles, rounded to 1 decimal place */
  function fmtDist(mi) { return mi.toFixed(1) + ' mi'; }

  /** Convert km to miles */
  function kmToMi(km) { return +(km * KM_TO_MI).toFixed(2); }

  function toast(msg, color) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = color || '#0C2853';
    el.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 3500);
  }

  function setErr(msg) {
    var el = document.getElementById('errBox');
    if (!el) return;
    el.className = msg ? 'err-box' : '';
    el.textContent = msg || '';
  }

  /* ── Theme ─────────────────────────────────────────────── */
  function applyTheme(isLight) {
    _isLight = isLight;
    document.body.classList.toggle('light', isLight);
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

  /* ── Geotab deep-link builder ───────────────────────────── */
  /**
   * Build a my.geotab.com unidentifiedDriving URL that pre-filters to
   * the exact log by setting both startDate and endDate to the log's
   * dateTime (ISO 8601 UTC).  The vehicle id is appended so only that
   * unit is shown.
   *
   * Example:
   *   https://my.geotab.com/traxxisdemo/#unidentifiedDriving,
   *     annotationsState:all,currentSortOrder:asc,
   *     dateRange:(endDate:'2026-03-01T04:59:59.000Z',
   *                startDate:'2026-02-01T05:00:00.000Z'),
   *     minDistance:'0',vehicle:!(b13__)
   */
  function buildGeotabLink(event) {
    var db   = _geotabDatabase || 'my';
    var iso  = event.dateObj.toISOString();
    var vId  = event._vehicleId || '';
    // Encode the hash fragment manually — do NOT use encodeURIComponent on
    // the whole fragment; Geotab parses the hash itself.
    var hash = 'unidentifiedDriving' +
      ',annotationsState:all' +
      ',currentSortOrder:asc' +
      ',dateRange:(endDate:\'' + iso + '\',startDate:\'' + iso + '\')' +
      ',minDistance:\'0\'' +
      (vId ? ',vehicle:!(' + vId + ')' : '');
    return 'https://my.geotab.com/' + db + '/#' + hash;
  }

  /* ── Filters ─────────────────────────────────────────────── */
  function getFiltered() {
    var cutoff = new Date(new Date() - _currentPeriod * 30 * 86400000);
    return _allEvents.filter(function(e) {
      if (e.dateObj < cutoff) return false;
      if (_currentStatus === 'unassigned' && e.status !== 'unassigned') return false;
      if (_currentStatus === 'resolved'   && e.status === 'unassigned') return false;
      if (_groupFilter   === 'unassigned' && e.status !== 'unassigned') return false;
      if (_groupFilter   === 'resolved'   && e.status === 'unassigned') return false;
      if (_currentSearch) {
        var q = _currentSearch;
        if (e.vehicle.toLowerCase().indexOf(q)===-1 &&
            e.id.toLowerCase().indexOf(q)===-1) return false;
      }
      return true;
    });
  }

  /* ── KPIs ─────────────────────────────────────────────────── */
  function updateKPIs() {
    var cutoff = new Date(new Date() - _currentPeriod * 30 * 86400000);
    var period = _allEvents.filter(function(e){ return e.dateObj >= cutoff; });
    var totalMin = period.reduce(function(s,e){ return s+e.durationMin; }, 0);
    var vSet = {};
    period.forEach(function(e){ vSet[e.vehicle]=true; });
    setText('kpiTotal',     period.length);
    setText('kpiHours',     Math.floor(totalMin/60)+'h');
    setText('kpiVehicles',  Object.keys(vSet).length);
    setText('kpiFleetSub',  'of '+_vehicles.length+' fleet');
    setText('kpiUnassigned',period.filter(function(e){ return e.status==='unassigned'; }).length);
    setText('kpiResolved',  period.filter(function(e){ return e.status!=='unassigned'; }).length);
    setText('foot', period.length+' events · '+Object.keys(vSet).length+' vehicles · '+_currentPeriod+'-month window');
  }

  function setText(id, val) { var el=document.getElementById(id); if(el) el.textContent=val; }

  /* ── Bar Chart ───────────────────────────────────────────── */
  function drawBarChart() {
    var container = document.getElementById('barChart');
    if (!container) return;
    var now = new Date(), months = [];
    for (var i=5; i>=0; i--) {
      var mIdx=now.getMonth()-i, yIdx=now.getFullYear();
      while (mIdx<0) { mIdx+=12; yIdx--; }
      months.push({ label:new Date(yIdx,mIdx,1).toLocaleString('default',{month:'short'}), year:yIdx, month:mIdx });
    }
    var data = months.map(function(m) {
      var me = _allEvents.filter(function(e){ return e.dateObj.getFullYear()===m.year && e.dateObj.getMonth()===m.month; });
      return { label:m.label,
        unassigned: me.filter(function(e){ return e.status==='unassigned'; }).length,
        assigned:   me.filter(function(e){ return e.status==='assigned';   }).length,
        annotated:  me.filter(function(e){ return e.status==='annotated';  }).length };
    });
    var maxVal = Math.max.apply(null, data.map(function(d){ return d.unassigned+d.assigned+d.annotated; }).concat([1]));
    container.innerHTML = '';
    data.forEach(function(d) {
      var uH=Math.round(d.unassigned/maxVal*100), aH=Math.round(d.assigned/maxVal*100), nH=Math.round(d.annotated/maxVal*100);
      container.innerHTML += '<div class="bar-group"><div class="bar-wrap">' +
        '<div class="bar" style="background:var(--score-red);height:'+uH+'%" data-tip="'+d.unassigned+' unassigned"></div>' +
        '<div class="bar" style="background:var(--accent);height:'+aH+'%" data-tip="'+d.assigned+' assigned"></div>' +
        '<div class="bar" style="background:var(--accent-hi);height:'+nH+'%" data-tip="'+d.annotated+' annotated"></div>' +
        '</div><span class="bar-month">'+d.label+'</span></div>';
    });
  }

  /* ── Donut ───────────────────────────────────────────────── */
  function drawDonut() {
    var cutoff = new Date(new Date() - _currentPeriod*30*86400000);
    var period = _allEvents.filter(function(e){ return e.dateObj>=cutoff; });
    var u=period.filter(function(e){ return e.status==='unassigned'; }).length;
    var a=period.filter(function(e){ return e.status==='assigned';   }).length;
    var n=period.filter(function(e){ return e.status==='annotated';  }).length;
    var total=(u+a+n)||1;
    var segs=[{val:u,color:'var(--score-red)',label:'Unassigned'},{val:a,color:'var(--accent)',label:'Assigned'},{val:n,color:'var(--accent-hi)',label:'Annotated'}];
    var cx=65,cy=65,r=50,ir=32,tau=Math.PI*2,start=0,paths='';
    segs.forEach(function(s){
      var frac=s.val/total,sweep=frac*tau,end=start+sweep;
      var x1=cx+r*Math.sin(start),y1=cy-r*Math.cos(start),x2=cx+r*Math.sin(end),y2=cy-r*Math.cos(end);
      var ix1=cx+ir*Math.sin(start),iy1=cy-ir*Math.cos(start),ix2=cx+ir*Math.sin(end),iy2=cy-ir*Math.cos(end);
      if(frac>0.001) paths+='<path d="M'+x1+','+y1+' A'+r+','+r+' 0 '+(sweep>Math.PI?1:0)+',1 '+x2+','+y2+' L'+ix2+','+iy2+' A'+ir+','+ir+' 0 '+(sweep>Math.PI?1:0)+',0 '+ix1+','+iy1+' Z" fill="'+s.color+'" opacity=".88"/>';
      start=end;
    });
    var fc=_isLight?'#051022':'#e8edf5';
    paths+='<text x="65" y="60" text-anchor="middle" font-family="DM Mono,monospace" font-size="20" font-weight="800" fill="'+fc+'">'+total+'</text>';
    paths+='<text x="65" y="74" text-anchor="middle" font-family="DM Mono,monospace" font-size="9" fill="#4d6d96" letter-spacing="1">EVENTS</text>';
    var svg=document.getElementById('donutSvg'); if(svg) svg.innerHTML=paths;
    var lbl=document.getElementById('donutLabels');
    if(lbl) lbl.innerHTML=segs.map(function(s){
      return '<div class="donut-label-item"><span class="donut-dot" style="background:'+s.color+'"></span><span>'+s.label+'</span><span class="donut-pct" style="color:'+s.color+'">'+Math.round(s.val/total*100)+'%</span></div>';
    }).join('');
  }

  /* ── Table ───────────────────────────────────────────────── */
  function renderTable(evts) {
    evts.sort(function(a,b){
      var va,vb;
      if(_sortKey==='vehicle'){va=a.vehicle;vb=b.vehicle;}
      else if(_sortKey==='date'){va=a.dateObj;vb=b.dateObj;}
      else if(_sortKey==='duration'){va=a.durationMin;vb=b.durationMin;}
      else if(_sortKey==='distance'){va=a.distanceMi;vb=b.distanceMi;}
      else{va=a.start;vb=b.start;}
      return va<vb?-_sortDir:va>vb?_sortDir:0;
    });
    _filteredEvents = evts;
    var start=(_currentPage-1)*_PER_PAGE, page=evts.slice(start,start+_PER_PAGE);

    var html='<table><thead><tr>'+
      '<th onclick="unidDash.sortBy(\'vehicle\')">Vehicle'+sa('vehicle')+'</th>'+
      '<th onclick="unidDash.sortBy(\'date\')">Date'+sa('date')+'</th>'+
      '<th onclick="unidDash.sortBy(\'start\')">Start</th>'+
      '<th onclick="unidDash.sortBy(\'duration\')">Duration'+sa('duration')+'</th>'+
      '<th onclick="unidDash.sortBy(\'distance\')">Distance'+sa('distance')+'</th>'+
      '<th class="th-status">Status</th>'+
      '<th class="th-actions">View</th>'+
      '</tr></thead><tbody>';

    page.forEach(function(e){
      var pct=Math.min(100,Math.round(e.durationMin/240*100));
      var bclr=pct>75?'var(--score-red)':pct>40?'var(--score-yellow)':'var(--accent)';
      var badge=e.status==='unassigned'?'<span class="badge badge-unassigned">&#9888; Unassigned</span>':
                e.status==='assigned'  ?'<span class="badge badge-assigned">&#10003; Assigned</span>':
                                        '<span class="badge badge-annotated">&#9998; Annotated</span>';
      var link = buildGeotabLink(e);
      html+='<tr>' +
        '<td><div class="veh-cell"><span class="veh-dot" style="background:'+e.vehicleColor+'"></span><span class="veh-name">'+e.vehicle+'</span></div></td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.date+'</td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.start+'</td>'+
        '<td><div class="dur-wrap"><span class="dur-txt">'+fmtDur(e.durationMin)+'</span><div class="dur-bar"><div class="dur-fill" style="width:'+pct+'%;background:'+bclr+'"></div></div></div></td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+fmtDist(e.distanceMi)+'</td>'+
        '<td class="td-status">'+badge+'</td>'+
        '<td class="td-actions"><a class="btn-view-log" href="'+link+'" target="_blank" rel="noopener noreferrer">'+
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'+
          'View</a></td>'+
        '</tr>';
    });
    html+='</tbody></table>';

    var tp=Math.ceil(evts.length/_PER_PAGE)||1;
    html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-top:1px solid var(--border);">'+
      '<span style="font-size:.72rem;font-family:\'DM Mono\',monospace;color:var(--text3);">Showing '+(evts.length?start+1:0)+'–'+Math.min(start+_PER_PAGE,evts.length)+' of '+evts.length+'</span>'+
      '<div style="display:flex;gap:4px;">';
    html+='<button onclick="unidDash.goPage('+(_currentPage-1)+')" style="'+pbs(false)+'">&#8249;</button>';
    for(var p=1;p<=tp;p++){
      if(tp>7&&p>2&&p<tp-1&&Math.abs(p-_currentPage)>1){if(p===3||p===tp-2)html+='<span style="color:var(--text3);padding:0 4px;">…</span>';continue;}
      html+='<button onclick="unidDash.goPage('+p+')" style="'+pbs(p===_currentPage)+'">'+p+'</button>';
    }
    html+='<button onclick="unidDash.goPage('+(_currentPage+1)+')" style="'+pbs(false)+'">&#8250;</button></div></div>';

    var tbl=document.getElementById('tbl'); if(tbl) tbl.innerHTML=html;
  }

  function sa(k){ return _sortKey!==k?'':' <i class="sort-arrow">'+(_sortDir===1?'↑':'↓')+'</i>'; }
  function pbs(a){ var b='width:28px;height:28px;border-radius:5px;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);transition:all .15s;'; return a?b+'background:var(--accent);border-color:var(--accent);color:#fff;':b+'background:var(--bg3);color:var(--text2);'; }

  function render() {
    updateKPIs();
    drawDonut();
    renderTable(getFiltered());
    updateDateRange();
    updateFilterBadge();
  }

  function updateFilterBadge() {
    var el=document.getElementById('filterBadge'); if(!el) return;
    if (_groupFilter) {
      var labels={unassigned:'Unassigned Only',resolved:'Resolved Only',vehicles:'Affected Vehicles'};
      el.style.display='inline-flex'; el.className='filter-badge';
      el.innerHTML='<span class="filter-dot" style="background:var(--accent)"></span>'+(labels[_groupFilter]||_groupFilter)+'<span class="filter-x" onclick="unidDash.clearGroupFilter()">&#10005;</span>';
    } else { el.style.display='none'; }
  }

  /* ── Data loading ───────────────────────────────────────── */

  function loadFromGeotab() {
    if (!_api) { loadDemoData(); return; }
    setErr('');

    _api.multiCall([
      ['Get', { typeName: 'Device' }],
      ['Get', { typeName: 'User', search: { isDriver: true } }]
    ], function(res) {
      var devices = (res && res[0]) || [];
      var users   = (res && res[1]) || [];

      _vehicles = devices.map(function(d){ return { id:d.id, name:d.name||d.id }; });

      var now      = new Date();
      var fromDate = new Date(now.getFullYear(), now.getMonth() - 5, 1).toISOString();
      var toDate   = now.toISOString();

      _api.call('Get', {
        typeName: 'DutyStatusLog',
        search: {
          userSearch: { id: 'NoUserId' },
          statuses:   ['D'],
          fromDate:   fromDate,
          toDate:     toDate
        }
      }, function(logs) {
        if (!logs || !logs.length) {
          var tbl = document.getElementById('tbl');
          if (tbl) tbl.innerHTML =
            '<div class="box"><div class="msg-txt">No unidentified driving events found in the last 6 months.</div></div>';
          updateKPIs();
          drawBarChart();
          drawDonut();
          updateDateRange();
          return;
        }
        processDutyStatusLogs(logs);
      }, function(err) {
        var msg = err && err.message ? err.message : JSON.stringify(err);
        setErr('Failed to load logs: ' + msg);
        var tbl = document.getElementById('tbl');
        if (tbl) tbl.innerHTML = '<div class="box"><div class="msg-txt">Error loading data — see above.</div></div>';
        console.error('[UnidDash] DutyStatusLog fetch failed:', err);
      });

    }, function(err) {
      var msg = err && err.message ? err.message : JSON.stringify(err);
      setErr('API error: ' + msg);
      var tbl = document.getElementById('tbl');
      if (tbl) tbl.innerHTML = '<div class="box"><div class="msg-txt">Error loading data — see above.</div></div>';
      console.error('[UnidDash] multiCall failed:', err);
    });
  }

  function processDutyStatusLogs(logs) {
    var palette=['#ef4444','#f59e0b','#3a6bb5','#10b981','#c8102e','#e8334a','#60a5fa','#a78bfa','#34d399','#fb923c'];
    var vColorMap={}, colorIdx=0;
    var skipped = 0;

    var events = [];
    logs.forEach(function(log, i) {
      var dt    = new Date(log.dateTime);
      var endDt = log.endDateTime ? new Date(log.endDateTime) : new Date(dt.getTime() + 30*60000);
      var dur   = Math.max(1, Math.round((endDt - dt) / 60000));
      var vId   = log.device && log.device.id ? log.device.id : 'UNKNOWN';

      if (!vColorMap[vId]) { vColorMap[vId] = palette[colorIdx%palette.length]; colorIdx++; }

      var vName = vId;
      for (var k=0; k<_vehicles.length; k++) {
        if (_vehicles[k].id === vId) { vName = _vehicles[k].name; break; }
      }

      // Convert odometer-based distance (metres) to miles
      var distanceKm  = log.odometer ? +(log.odometer/1000).toFixed(1) : +(dur*0.6).toFixed(1);
      var distanceMi  = kmToMi(distanceKm);

      // Skip events below the minimum distance threshold
      if (distanceMi < MIN_DIST_MI) { skipped++; return; }

      var isAssigned   = log.driver && log.driver.id && log.driver.id !== 'NoUserId';
      var hasAnnotation= log.annotations && log.annotations.length > 0;
      var status = isAssigned ? 'assigned' : hasAnnotation ? 'annotated' : 'unassigned';

      events.push({
        id:           'LOG-' + (i+1),
        vehicle:      vName,
        vehicleColor: vColorMap[vId],
        date:         fmtDate(dt),
        dateObj:      dt,
        start:        fmtTime(dt.getHours(), dt.getMinutes()),
        durationMin:  dur,
        distanceMi:   distanceMi,
        status:       status,
        _vehicleId:   vId,
        _rawLog:      log
      });
    });

    _allEvents = events;
    _allEvents.sort(function(a,b){ return b.dateObj - a.dateObj; });
    render();
    drawBarChart();
    var msg = 'Loaded ' + _allEvents.length + ' unidentified logs';
    if (skipped > 0) msg += ' (' + skipped + ' under ' + MIN_DIST_MI + ' mi hidden)';
    toast(msg, '#10b981');
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
    var statusTypes=['unassigned','assigned','annotated'];
    var now=new Date();
    function ri(a,b){return a+Math.floor(Math.random()*(b-a+1));}
    function ro(a){return a[Math.floor(Math.random()*a.length)];}

    _allEvents=[];
    for(var i=0;i<180;i++){
      var mOffset=Math.floor(i/30);
      var mIdx=now.getMonth()-mOffset, yIdx=now.getFullYear();
      while(mIdx<0){mIdx+=12;yIdx--;}
      var dim=new Date(yIdx,mIdx+1,0).getDate();
      var dt=new Date(yIdx,mIdx,ri(1,dim));
      var sh=ri(4,21),sm=ri(0,59),dur=ri(5,240);
      var veh=ro(vDefs), st=ro(statusTypes);
      // Randomise distance in miles; ensure a portion falls below threshold to
      // demo the filter (values 0.05–0.20 mi will be filtered out).
      var rawMi = +(ri(5,160)*0.1).toFixed(1);  // 0.5 mi – 16 mi range for most
      if (i % 12 === 0) rawMi = +(Math.random()*0.24).toFixed(2);  // ~8% under threshold
      if (rawMi < MIN_DIST_MI) continue;  // apply same filter as live data
      _allEvents.push({
        id:'DEMO-'+(10000+i),vehicle:veh.id,vehicleColor:veh.color,
        date:fmtDate(dt),dateObj:dt,start:fmtTime(sh,sm),
        durationMin:dur, distanceMi:rawMi,
        status:st,
        _vehicleId: veh.id,
        _rawLog:null
      });
    }
    _allEvents.sort(function(a,b){return b.dateObj-a.dateObj;});
    render();
    drawBarChart();
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {

    init: function(api, session) {
      _api           = api;
      _sessionUserId = session && session.userId ? session.userId : null;
      // Capture the database name for building Geotab deep links
      _geotabDatabase = session && session.database ? session.database : null;
      var root=document.getElementById('unidentifieddriving');
      if (root) root.style.display='';
      _initialized = true;
      loadFromGeotab();
    },

    /* ── Header controls ── */
    setPeriod: function(m,evt) {
      _currentPeriod=m; _currentPage=1;
      if(evt){ var g=evt.target.closest('.range-group'); if(g) g.querySelectorAll('.range-btn').forEach(function(b){b.classList.remove('active');}); evt.target.classList.add('active'); }
      render();
    },
    setStatus: function(s,evt) {
      _currentStatus=s; _currentPage=1;
      if(evt){ var g=evt.target.closest('.range-group'); if(g) g.querySelectorAll('.range-btn').forEach(function(b){b.classList.remove('active');}); evt.target.classList.add('active'); }
      render();
    },
    toggleTheme: function(){ applyTheme(!_isLight); },
    refresh: function() {
      _allEvents=[];
      setErr('');
      var tbl=document.getElementById('tbl');
      if(tbl) tbl.innerHTML='<div class="box"><div class="spinner"></div><div class="msg-txt">REFRESHING…</div></div>';
      loadFromGeotab();
    },

    /* ── Table controls ── */
    filterSearch: function(){ _currentSearch=(document.getElementById('srch')||{}).value.toLowerCase()||''; _currentPage=1; render(); },
    sortBy: function(k){ if(_sortKey===k){_sortDir*=-1;}else{_sortKey=k;_sortDir=-1;} render(); },
    goPage: function(p){ var t=Math.ceil(_filteredEvents.length/_PER_PAGE)||1; if(p<1||p>t)return; _currentPage=p; renderTable(_filteredEvents); },
    filterGroup: function(g){ _groupFilter=(_groupFilter===g)?null:g; _currentPage=1; render(); },
    clearGroupFilter: function(){ _groupFilter=null; _currentPage=1; render(); },

    /* ── Export ── */
    exportCSV: function(){
      var evts=getFiltered(); if(!evts.length){ toast('No data to export','#ef4444'); return; }
      var hdr=['ID','Vehicle','Date','Start','Duration (min)','Distance (mi)','Status','Geotab Link'];
      var rows=evts.map(function(e){
        return [e.id,e.vehicle,e.date,e.start,e.durationMin,e.distanceMi.toFixed(1),e.status,buildGeotabLink(e)]
          .map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(',');
      });
      var csv=[hdr.join(',')].concat(rows).join('\n');
      var blob=new Blob([csv],{type:'text/csv'});
      var url=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=url; a.download='unidentified-driving-'+new Date().toISOString().slice(0,10)+'.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      toast('CSV exported','#10b981');
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
        unidDash.init(_api, session);
      });
    },

    blur: function () {}
  };
};