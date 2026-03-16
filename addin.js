/* =========================================================
   Unidentified Driving — HOS Dashboard  |  addin.js
   Geotab Add-in entry point: geotab.addin.unidentifieddriving

   API write-back pattern:
     - Assign driver : api.call("Set", { typeName:"DutyStatusLog",
                         entity: { ...originalLog, driver:{ id:driverId } } })
     - Add annotation: api.call("Add", { typeName:"AnnotationLog",
                         entity: { comment, driver:{ id:currentUserId },
                                   dateTime, dutyStatusLog:{ id:logId } } })
   ========================================================= */

var unidDash = (function () {

  /* ── Private state ─────────────────────────────────────── */
  var _api            = null;
  var _sessionUserId  = null;   // logged-in user id (for AnnotationLog author)
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
  var _drivers        = [];     // [{ id, name }]
  var _isLight        = false;
  var _toastTimer     = null;
  var _initialized    = false;
  var _openEventIdx   = null;
  var _selectedDriver = null;   // { id, name }
  var _bulkDriver     = null;
  var _saving         = false;
  var _hosRules       = ['Canada South 70h','Canada North 120h','US 60h/7d','US 70h/8d','Exempt'];

  /* ── Utilities ─────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
  function fmtTime(h, m) { return pad(h) + ':' + pad(m); }
  function fmtDur(m) { var h=Math.floor(m/60),mm=m%60; return h>0?h+'h '+pad(mm)+'m':mm+'m'; }
  function fmtDist(k) { return k + ' km'; }
  function initials(name) {
    var p = name.trim().split(/\s+/);
    return p.length>=2 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : name.slice(0,2).toUpperCase();
  }

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

  function setSaving(on) {
    _saving = on;
    var btn = document.querySelector('#panelAssign .btn-save');
    if (btn) { btn.textContent = on ? 'Saving…' : 'Save & Resolve'; btn.disabled = on; }
    var btn2 = document.querySelector('#panelBulk .btn-save');
    if (btn2) { btn2.textContent = on ? 'Saving…' : 'Apply to Selected'; btn2.disabled = on; }
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
            (e.driver||'').toLowerCase().indexOf(q)===-1 &&
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
      else if(_sortKey==='distance'){va=a.distanceKm;vb=b.distanceKm;}
      else{va=a.start;vb=b.start;}
      return va<vb?-_sortDir:va>vb?_sortDir:0;
    });
    _filteredEvents = evts;
    var start=(_currentPage-1)*_PER_PAGE, page=evts.slice(start,start+_PER_PAGE);

    var html='<table><thead><tr>'+
      '<th class="th-check"><input type="checkbox" id="selectAll" onchange="unidDash.toggleSelectAll(this)"/></th>'+
      '<th onclick="unidDash.sortBy(\'vehicle\')">Vehicle'+sa('vehicle')+'</th>'+
      '<th onclick="unidDash.sortBy(\'date\')">Date'+sa('date')+'</th>'+
      '<th onclick="unidDash.sortBy(\'start\')">Start</th>'+
      '<th onclick="unidDash.sortBy(\'duration\')">Duration'+sa('duration')+'</th>'+
      '<th onclick="unidDash.sortBy(\'distance\')">Distance'+sa('distance')+'</th>'+
      '<th>HOS Rule</th>'+
      '<th class="th-status">Status</th>'+
      '<th>Driver</th>'+
      '<th>Note</th>'+
      '<th class="th-actions">Resolve</th>'+
      '</tr></thead><tbody>';

    page.forEach(function(e,i){
      var idx=start+i;
      var pct=Math.min(100,Math.round(e.durationMin/240*100));
      var bclr=pct>75?'var(--score-red)':pct>40?'var(--score-yellow)':'var(--accent)';
      var badge=e.status==='unassigned'?'<span class="badge badge-unassigned">&#9888; Unassigned</span>':
                e.status==='assigned'  ?'<span class="badge badge-assigned">&#10003; Assigned</span>':
                                        '<span class="badge badge-annotated">&#9998; Annotated</span>';
      var drvTxt=e.driver?'<span style="font-size:.8rem;font-weight:600;color:var(--text)">'+e.driver+'</span>':'<span style="color:var(--text3);font-size:.78rem;">—</span>';
      var noteTxt=e.annotation?'<span class="note-cell" title="'+e.annotation.replace(/"/g,'&quot;')+'">'+e.annotation+'</span>':'<span class="note-none">—</span>';
      var rLabel=e.status==='unassigned'?'Resolve':'Edit';
      var rClass=e.status==='unassigned'?'btn-resolve':'btn-resolve resolved';
      html+='<tr class="'+(e.checked?'row-selected':'')+'">' +
        '<td class="td-check"><input type="checkbox" '+(e.checked?'checked':'')+' onchange="unidDash.checkRow(this,'+idx+')"/></td>'+
        '<td><div class="veh-cell"><span class="veh-dot" style="background:'+e.vehicleColor+'"></span><span class="veh-name">'+e.vehicle+'</span></div></td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.date+'</td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+e.start+'</td>'+
        '<td><div class="dur-wrap"><span class="dur-txt">'+fmtDur(e.durationMin)+'</span><div class="dur-bar"><div class="dur-fill" style="width:'+pct+'%;background:'+bclr+'"></div></div></div></td>'+
        '<td style="font-family:\'DM Mono\',monospace;font-size:.8rem;">'+fmtDist(e.distanceKm)+'</td>'+
        '<td style="font-size:.75rem;color:var(--text3);">'+e.hosRule+'</td>'+
        '<td class="td-status">'+badge+'</td>'+
        '<td>'+drvTxt+'</td>'+
        '<td>'+noteTxt+'</td>'+
        '<td class="td-actions"><button class="'+rClass+'" onclick="unidDash.openPanel('+idx+')">'+rLabel+'</button></td>'+
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
    updateBulkBtn();
  }

  function sa(k){ return _sortKey!==k?'':' <i class="sort-arrow">'+(_sortDir===1?'↑':'↓')+'</i>'; }
  function pbs(a){ var b='width:28px;height:28px;border-radius:5px;cursor:pointer;font-family:\'DM Mono\',monospace;font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);transition:all .15s;'; return a?b+'background:var(--accent);border-color:var(--accent);color:#fff;':b+'background:var(--bg3);color:var(--text2);'; }

  function render() {
    updateKPIs();
    drawBarChart();
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

  function updateBulkBtn() {
    var count=_allEvents.filter(function(e){ return e.checked; }).length;
    var btn=document.getElementById('btnBulk'); if(!btn) return;
    btn.style.display=count>0?'inline-flex':'none';
    var c=document.getElementById('selCount'); if(c) c.textContent=count;
  }

  /* ── Driver dropdown builder ─────────────────────────────── */
  function buildDriverList(searchEl, dropdownEl, onSelect) {
    var q=(searchEl.value||'').toLowerCase().trim();
    var matched=q?_drivers.filter(function(d){ return d.name.toLowerCase().indexOf(q)!==-1; }):_drivers.slice(0,30);
    if(!matched.length){
      dropdownEl.innerHTML='<div class="driver-no-results">No drivers found</div>';
    } else {
      dropdownEl.innerHTML=matched.map(function(d){
        // Escape single quotes in the driver name for the inline onclick
        var safeName=d.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        var safeId=d.id;
        return '<div class="driver-option" onclick="('+onSelect.toString()+')(\''+safeId+'\',\''+safeName+'\')">'+
          '<span class="driver-avatar">'+initials(d.name)+'</span>'+d.name+'</div>';
      }).join('');
    }
    dropdownEl.style.display='block';
  }

  /* ── Geotab API write-back ───────────────────────────────── */

  /**
   * Assign a driver to a DutyStatusLog by calling Set on the full log entity.
   * We must send back the COMPLETE original log with the driver swapped —
   * the Geotab API requires all fields present.
   */
  function apiAssignDriver(event, driverId, cb) {
    if (!_api || !event._rawLog) { cb(null); return; }  // demo mode: skip
    var updated = JSON.parse(JSON.stringify(event._rawLog));
    updated.driver = { id: driverId };
    _api.call('Set', { typeName: 'DutyStatusLog', entity: updated },
      function() { cb(null); },
      function(err) { cb(err); }
    );
  }

  /**
   * Add an AnnotationLog tied to a DutyStatusLog.
   * The author is the currently logged-in user.
   */
  function apiAddAnnotation(event, comment, cb) {
    if (!_api || !event._rawLog) { cb(null); return; }  // demo mode: skip
    var authorId = _sessionUserId || 'b0';
    _api.call('Add', {
      typeName: 'AnnotationLog',
      entity: {
        comment:        comment,
        driver:         { id: authorId },
        dateTime:       new Date().toISOString(),
        dutyStatusLog:  { id: event._rawLog.id }
      }
    },
    function() { cb(null); },
    function(err) { cb(err); }
    );
  }

  /**
   * Persist a single event: optionally Set driver, optionally Add annotation.
   * Calls cb(err) when done (err=null on success).
   */
  function persistEvent(event, driverId, note, cb) {
    var steps = [];

    if (driverId && (!event._rawLog || event._rawLog.driver.id === 'UnknownDriverId')) {
      steps.push(function(next) { apiAssignDriver(event, driverId, next); });
    }
    if (note) {
      steps.push(function(next) { apiAddAnnotation(event, note, next); });
    }

    // run steps in sequence
    function run(i) {
      if (i >= steps.length) { cb(null); return; }
      steps[i](function(err) { if (err) { cb(err); } else { run(i+1); } });
    }
    run(0);
  }

  /* ── Data loading ───────────────────────────────────────── */

  function loadFromGeotab() {
    if (!_api) { loadDemoData(); return; }
    setErr('');

    // Step 1: fetch Devices and Users in parallel via multiCall,
    // mirroring the reference add-in's pattern exactly.
    _api.multiCall([
      ['Get', { typeName: 'Device', resultsLimit: 500 }],
      ['Get', { typeName: 'User',   search: { isDriver: true }, resultsLimit: 1000 }]
    ], function(res) {
      var devices = (res && res[0]) || [];
      var users   = (res && res[1]) || [];

      _vehicles = devices.map(function(d){ return { id:d.id, name:d.name||d.id }; });

      _drivers = users
        .filter(function(u){ return u.id !== 'UnknownDriverId'; })
        .map(function(u){
          var name = ((u.firstName||'')+(u.lastName?' '+u.lastName:'')).trim() || u.name || '';
          return { id:u.id, name:name };
        })
        .filter(function(u){ return u.name; });

      // Step 2: fetch unidentified DutyStatusLogs.
      // userSearch id must be "NoUserId" — this is the correct Geotab identifier
      // for logs with no assigned driver. No date filter on the search itself;
      // we filter by date client-side using the period selector.
      _api.call('Get', {
        typeName: 'DutyStatusLog',
        search: {
          userSearch: { id: 'NoUserId' }
        },
        resultsLimit: 1000
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
      // multiCall failed — show the actual error rather than silently falling back
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

    _allEvents = logs.map(function(log, i) {
      var dt    = new Date(log.dateTime);
      var endDt = log.endDateTime ? new Date(log.endDateTime) : new Date(dt.getTime() + 30*60000);
      var dur   = Math.max(1, Math.round((endDt - dt) / 60000));
      var vId   = log.device && log.device.id ? log.device.id : 'UNKNOWN';

      if (!vColorMap[vId]) { vColorMap[vId] = palette[colorIdx%palette.length]; colorIdx++; }

      var vName = vId;
      for (var k=0; k<_vehicles.length; k++) {
        if (_vehicles[k].id === vId) { vName = _vehicles[k].name; break; }
      }

      // Determine resolved state from the log itself:
      // If driver is not UnknownDriverId it was already assigned.
      var isAssigned   = log.driver && log.driver.id !== 'UnknownDriverId';
      var hasAnnotation= log.annotations && log.annotations.length > 0;
      var status = isAssigned ? 'assigned' : hasAnnotation ? 'annotated' : 'unassigned';
      var driverName = null;
      if (isAssigned) {
        for (var j=0; j<_drivers.length; j++) {
          if (_drivers[j].id === log.driver.id) { driverName = _drivers[j].name; break; }
        }
        if (!driverName) driverName = log.driver.id;
      }
      var annotationText = hasAnnotation ? log.annotations[0].comment : null;

      return {
        id:           'LOG-' + (i+1),
        vehicle:      vName,
        vehicleColor: vColorMap[vId],
        date:         fmtDate(dt),
        dateObj:      dt,
        start:        fmtTime(dt.getHours(), dt.getMinutes()),
        durationMin:  dur,
        distanceKm:   log.odometer ? +(log.odometer/1000).toFixed(1) : +(dur*0.6).toFixed(1),
        hosRule:      log.hosRuleSet || 'N/A',
        status:       status,
        driver:       driverName,
        annotation:   annotationText,
        checked:      false,
        _rawLog:      log    // keep the full object for Set calls
      };
    });

    _allEvents.sort(function(a,b){ return b.dateObj - a.dateObj; });
    render();
    toast('Loaded ' + _allEvents.length + ' unidentified logs', '#10b981');
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
    _drivers  = [
      {id:'d1',name:'J. Harrington'},{id:'d2',name:'M. Delacroix'},
      {id:'d3',name:'T. Okonkwo'},  {id:'d4',name:'S. Patel'},
      {id:'d5',name:'R. Vasquez'},  {id:'d6',name:'L. Nguyen'},
      {id:'d7',name:'K. Brennan'},  {id:'d8',name:'D. Achebe'},
      {id:'d9',name:'F. Morales'},  {id:'d10',name:'B. Nakamura'}
    ];
    var anns=['Vehicle taken home — approved yard move','Pre-trip inspection drive',
      'Maintenance road test','Driver forgot to log in',
      'ELD malfunction — manual logs filed','Authorized personal conveyance',null,null,null,null];
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
      var ann=st==='annotated'?ro(anns.filter(Boolean)):null;
      var drv=st==='assigned'?ro(_drivers):null;
      _allEvents.push({
        id:'DEMO-'+(10000+i),vehicle:veh.id,vehicleColor:veh.color,
        date:fmtDate(dt),dateObj:dt,start:fmtTime(sh,sm),
        durationMin:dur,distanceKm:+(dur*ro([0.4,0.5,0.6,0.7,0.8])).toFixed(1),
        hosRule:ro(_hosRules),status:st,
        driver:drv?drv.name:null,
        annotation:ann,checked:false,
        _rawLog:null  // no raw log in demo mode — API calls are skipped
      });
    }
    _allEvents.sort(function(a,b){return b.dateObj-a.dateObj;});
    render();
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {

    init: function(api, session) {
      _api           = api;
      // session.userName is the logged-in user's name; session.userId is their id
      // Both are used for AnnotationLog authorship.
      _sessionUserId = session && session.userId ? session.userId : null;
      var root=document.getElementById('unidentifieddriving');
      if (root) root.style.display='';
      if (!_initialized) {
        _initialized=true;
        document.addEventListener('click', function(ev) {
          ['driverSearch','bulkDriverSearch'].forEach(function(sid){
            var s=document.getElementById(sid);
            var d=document.getElementById(sid.replace('Search','Dropdown'));
            if(d&&s&&!s.contains(ev.target)&&!d.contains(ev.target)) d.style.display='none';
          });
        });
      }
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
    toggleSelectAll: function(cb){
      var start=(_currentPage-1)*_PER_PAGE;
      _filteredEvents.slice(start,start+_PER_PAGE).forEach(function(e){ e.checked=cb.checked; });
      renderTable(_filteredEvents);
    },
    checkRow: function(cb,idx){ if(_filteredEvents[idx]) _filteredEvents[idx].checked=cb.checked; updateBulkBtn(); },

    /* ── Resolve panel ── */
    openPanel: function(idx) {
      var e=_filteredEvents[idx]; if(!e) return;
      _openEventIdx=idx;
      _selectedDriver = e.driver ? (function(){
        for(var i=0;i<_drivers.length;i++){ if(_drivers[i].name===e.driver) return _drivers[i]; }
        return { id:null, name:e.driver };
      })() : null;

      setText('panelEventId',  e.id);
      setText('panelEventMeta', e.vehicle+' · '+e.date+' · '+e.start+' · '+fmtDur(e.durationMin)+' · '+fmtDist(e.distanceKm));

      var ds=document.getElementById('driverSearch');
      var dd=document.getElementById('driverDropdown');
      var sd=document.getElementById('selectedDriverDisplay');
      var sn=document.getElementById('selectedDriverName');
      if(ds) ds.value='';
      if(dd) dd.style.display='none';
      if(_selectedDriver&&sd&&sn){
        sd.style.display='flex'; sn.textContent=_selectedDriver.name;
        if(ds) ds.style.display='none';
      } else {
        if(sd) sd.style.display='none';
        if(ds) ds.style.display='block';
      }
      var ta=document.getElementById('annotationNote'); if(ta) ta.value=e.annotation||'';
      document.querySelectorAll('#presetChips .preset-chip').forEach(function(c){
        c.classList.toggle('active', c.textContent===(e.annotation||''));
      });
      var panel=document.getElementById('panelAssign');
      if(panel){ panel.classList.add('open'); panel.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    },

    closePanel: function(){
      var p=document.getElementById('panelAssign'); if(p) p.classList.remove('open');
      _openEventIdx=null; _selectedDriver=null;
    },

    showDriverList: function(){
      var ds=document.getElementById('driverSearch'),dd=document.getElementById('driverDropdown');
      if(ds&&dd) buildDriverList(ds,dd,function(id,name){ unidDash.selectDriver(id,name); });
    },
    filterDriverList: function(){
      var ds=document.getElementById('driverSearch'),dd=document.getElementById('driverDropdown');
      if(ds&&dd) buildDriverList(ds,dd,function(id,name){ unidDash.selectDriver(id,name); });
    },
    selectDriver: function(id,name){
      _selectedDriver={id:id,name:name};
      var ds=document.getElementById('driverSearch'),dd=document.getElementById('driverDropdown');
      var sd=document.getElementById('selectedDriverDisplay'),sn=document.getElementById('selectedDriverName');
      if(dd) dd.style.display='none';
      if(ds){ ds.value=''; ds.style.display='none'; }
      if(sn) sn.textContent=name;
      if(sd) sd.style.display='flex';
    },
    clearDriver: function(){
      _selectedDriver=null;
      var ds=document.getElementById('driverSearch'),sd=document.getElementById('selectedDriverDisplay');
      if(ds){ ds.value=''; ds.style.display='block'; }
      if(sd) sd.style.display='none';
    },

    setPreset: function(chip){
      var ta=document.getElementById('annotationNote');
      document.querySelectorAll('#presetChips .preset-chip').forEach(function(c){ c.classList.remove('active'); });
      if(ta&&ta.value===chip.textContent){ ta.value=''; } else { chip.classList.add('active'); if(ta) ta.value=chip.textContent; }
    },

    saveResolve: function() {
      if(_openEventIdx===null||_saving) return;
      var e=_filteredEvents[_openEventIdx]; if(!e) return;
      var note=((document.getElementById('annotationNote')||{}).value||'').trim();
      if(!_selectedDriver&&!note){ toast('Assign a driver or add a note to resolve this event','#f59e0b'); return; }

      setSaving(true);
      var driverId   = _selectedDriver ? _selectedDriver.id : null;
      var driverName = _selectedDriver ? _selectedDriver.name : null;

      persistEvent(e, driverId, note, function(err) {
        setSaving(false);
        if (err) {
          toast('Save failed: '+(err.message||err),'#ef4444');
          setErr('Failed to save: '+(err.message||JSON.stringify(err)));
          return;
        }
        // Update local state to reflect what was persisted
        if (driverName) { e.driver=driverName; e.status='assigned'; }
        if (note)       { e.annotation=note; if(!driverName) e.status='annotated'; }
        if (e._rawLog && driverId) e._rawLog.driver = { id: driverId };

        unidDash.closePanel();
        render();
        toast('Event resolved and saved','#10b981');
      });
    },

    /* ── Bulk panel ── */
    openBulkPanel: function(){
      var count=_allEvents.filter(function(e){ return e.checked; }).length;
      if(!count){ toast('Select events first using the checkboxes','#f59e0b'); return; }
      setText('bulkCount',count+' event'+(count!==1?'s':'')+' selected');
      _bulkDriver=null;
      var bs=document.getElementById('bulkDriverSearch'),bd=document.getElementById('bulkDriverDropdown');
      var bsd=document.getElementById('bulkSelectedDisplay'),bn=document.getElementById('bulkNote');
      if(bs){ bs.value=''; bs.style.display='block'; }
      if(bd) bd.style.display='none';
      if(bsd) bsd.style.display='none';
      if(bn) bn.value='';
      var p=document.getElementById('panelBulk');
      if(p){ p.classList.add('open'); p.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    },
    closeBulkPanel: function(){
      var p=document.getElementById('panelBulk'); if(p) p.classList.remove('open'); _bulkDriver=null;
    },
    showBulkDriverList: function(){
      var bs=document.getElementById('bulkDriverSearch'),bd=document.getElementById('bulkDriverDropdown');
      if(bs&&bd) buildDriverList(bs,bd,function(id,name){ unidDash.selectBulkDriver(id,name); });
    },
    filterBulkDriverList: function(){
      var bs=document.getElementById('bulkDriverSearch'),bd=document.getElementById('bulkDriverDropdown');
      if(bs&&bd) buildDriverList(bs,bd,function(id,name){ unidDash.selectBulkDriver(id,name); });
    },
    selectBulkDriver: function(id,name){
      _bulkDriver={id:id,name:name};
      var bs=document.getElementById('bulkDriverSearch'),bd=document.getElementById('bulkDriverDropdown');
      var bsd=document.getElementById('bulkSelectedDisplay'),bsn=document.getElementById('bulkSelectedName');
      if(bd) bd.style.display='none';
      if(bs){ bs.value=''; bs.style.display='none'; }
      if(bsn) bsn.textContent=name;
      if(bsd) bsd.style.display='flex';
    },
    clearBulkDriver: function(){
      _bulkDriver=null;
      var bs=document.getElementById('bulkDriverSearch'),bsd=document.getElementById('bulkSelectedDisplay');
      if(bs){ bs.value=''; bs.style.display='block'; }
      if(bsd) bsd.style.display='none';
    },

    saveBulkAssign: function(){
      if(!_bulkDriver||_saving){ toast('Select a driver first','#f59e0b'); return; }
      var note=((document.getElementById('bulkNote')||{}).value||'').trim();
      var sel=_allEvents.filter(function(e){ return e.checked; });
      if(!sel.length){ toast('No events selected','#f59e0b'); return; }

      setSaving(true);
      var done=0, errors=0;
      sel.forEach(function(e){
        persistEvent(e, _bulkDriver.id, note, function(err){
          if(err){ errors++; } else {
            e.driver=_bulkDriver.name; e.status='assigned'; e.checked=false;
            if(note) e.annotation=note;
            if(e._rawLog) e._rawLog.driver={ id:_bulkDriver.id };
          }
          done++;
          if(done===sel.length){
            setSaving(false);
            unidDash.closeBulkPanel();
            render();
            if(errors){ toast(errors+' save(s) failed — check console','#ef4444'); }
            else { toast('Assigned '+sel.length+' event'+(sel.length!==1?'s':'')+' to '+_bulkDriver.name,'#10b981'); }
          }
        });
      });
    },

    /* ── Export ── */
    exportCSV: function(){
      var evts=getFiltered(); if(!evts.length){ toast('No data to export','#ef4444'); return; }
      var hdr=['ID','Vehicle','Date','Start','Duration (min)','Distance (km)','HOS Rule','Status','Driver','Note'];
      var rows=evts.map(function(e){
        return [e.id,e.vehicle,e.date,e.start,e.durationMin,e.distanceKm,e.hosRule,e.status,e.driver||'',e.annotation||'']
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
      // getSession provides the real authenticated session.
      // Matches the reference add-in pattern exactly — call init here, not in initialize.
      _api.getSession(function (session) {
        unidDash.init(_api, session);
      });
    },

    blur: function () {}
  };
};