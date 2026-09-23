/* 路灯调光能耗审计 —— 纯前端，无框架、无依赖 */
(function () {
  'use strict';

  // ---------------- 状态 ----------------
  const state = {
    lampsData: null,
    curvesData: null,
    circuitById: new Map(),
    curveById: new Map(),
    assignmentsByCircuit: new Map(),
    windowStart: '2025-01-15',
    windowEnd: '2025-03-15',
    selectedCircuitId: null,
    selectedLampId: null,
    audits: [],
    schemeA: { mode: 'ledger', fixedCurveId: 'STD', overrides: new Map() },
    schemeB: { mode: 'fixed', fixedCurveId: 'ECO', overrides: new Map() },
    resultA: null,
    resultB: null,
  };

  // ---------------- 日期工具（UTC，避免时区/夏令时干扰） ----------------
  const DAY_MS = 86400000;

  function parseDate(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  function addDays(ms, n) {
    return ms + n * DAY_MS;
  }
  function eachInclusiveDay(startMs, endMs) {
    const out = [];
    for (let t = startMs; t <= endMs; t += DAY_MS) out.push(t);
    return out;
  }
  function inclusiveDays(startMs, endMs) {
    return Math.round((endMs - startMs) / DAY_MS) + 1;
  }
  // 两个闭区间的重叠天数（日期按全天计）
  function overlapInclusiveDays(a0, a1, b0, b1) {
    const s = Math.max(a0, b0);
    const e = Math.min(a1, b1);
    return e < s ? 0 : inclusiveDays(s, e);
  }
  function monthKey(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  function monthLabel(key) {
    const [y, m] = key.split('-');
    return `${y} 年 ${Number(m)} 月`;
  }
  function daysInMonthOf(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  // ---------------- 几何 ----------------
  function pointInPolygon(lon, lat, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  function centroid(poly) {
    return [
      poly.reduce((s, p) => s + p[0], 0) / poly.length,
      poly.reduce((s, p) => s + p[1], 0) / poly.length,
    ];
  }
  function haversineMeters(aLon, aLat, bLon, bLat) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ---------------- 曲线解析 ----------------
  function hmToMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }
  // 展开跨午夜时段：按列出顺序累计推进，起点早于前一段终点则整体 +1440
  function curveIntervals(curve) {
    const out = [];
    let prevEnd = -Infinity;
    for (const seg of curve.segments) {
      let s = hmToMinutes(seg.start);
      let e = hmToMinutes(seg.end);
      while (s < prevEnd) {
        s += 1440;
        e += 1440;
      }
      if (e <= s) e += 1440;
      out.push({ s, e, pct: seg.brightnessPct, raw: seg });
      prevEnd = e;
    }
    return out;
  }
  // 每日“等效满功率小时” = Σ 时长(h) × 亮度%
  function weightedFullPowerHours(curve) {
    return curveIntervals(curve).reduce((sum, iv) => sum + ((iv.e - iv.s) / 60) * (iv.pct / 100), 0);
  }
  // 每日实际点亮小时（亮度 > 0 的时段）
  function litHoursOfCurve(curve) {
    return curveIntervals(curve).reduce((sum, iv) => sum + (iv.pct > 0 ? (iv.e - iv.s) / 60 : 0), 0);
  }
  function plannedHoursPerDay(data) {
    let s = hmToMinutes(data.scheduledOn);
    let e = hmToMinutes(data.scheduledOff);
    if (e <= s) e += 1440;
    return (e - s) / 60;
  }

  // ---------------- 台账生效曲线（含重叠检测） ----------------
  const FAR_FUTURE = Date.UTC(2999, 0, 1);

  function assignmentRange(a) {
    return [parseDate(a.startDate), a.endDate ? parseDate(a.endDate) : FAR_FUTURE];
  }
  function activeAssignments(circuitId, dayMs) {
    const list = state.assignmentsByCircuit.get(circuitId) || [];
    return list.filter((a) => {
      const [s, e] = assignmentRange(a);
      return dayMs >= s && dayMs <= e;
    });
  }
  // 同一时刻多条生效时：取 startDate 最晚的一条（确定性的冲突兜底）
  function resolveLedgerCurveId(circuitId, dayMs) {
    const active = activeAssignments(circuitId, dayMs);
    if (active.length === 0) return null;
    active.sort((a, b) => {
      const d = parseDate(b.startDate) - parseDate(a.startDate);
      if (d !== 0) return d;
      return (b.endDate || '9999') < (a.endDate || '9999') ? -1 : 1;
    });
    return active[0].curveId;
  }

  // ---------------- 数据审计 ----------------
  function runAudits() {
    const audits = [];
    const w0 = parseDate(state.windowStart);
    const w1 = parseDate(state.windowEnd);

    // 1) 同一回路同一时刻多条生效曲线
    for (const [circuitId, list] of state.assignmentsByCircuit) {
      for (let i = 0; i < list.length; i++) {
        for (let k = i + 1; k < list.length; k++) {
          const [a0, a1] = assignmentRange(list[i]);
          const [b0, b1] = assignmentRange(list[k]);
          const days = overlapInclusiveDays(a0, a1, b0, b1);
          if (days > 0) {
            const s = fmtDate(Math.max(a0, b0));
            const e = fmtDate(Math.min(a1, b1));
            const inWindow = overlapInclusiveDays(a0, a1, w0, w1) && overlapInclusiveDays(b0, b1, w0, w1)
              ? overlapInclusiveDays(Math.max(a0, b0), Math.min(a1, b1), w0, w1)
              : 0;
            audits.push({
              type: 'curve-overlap',
              severity: 'error',
              circuitId,
              title: `回路 ${circuitId} 曲线生效期重叠`,
              detail: `${list[i].curveId} 与 ${list[k].curveId} 在 ${s} ~ ${e} 同时生效（共 ${days} 天${
                days > 1 ? '' : ''
              }；分析窗口内 ${inWindow} 天）。计算按 startDate 最晚者取值，请核实台账。`,
            });
          }
        }
      }
    }

    // 2) 灯具坐标落点审计
    for (const lamp of state.lampsData.lamps) {
      if (!state.circuitById.has(lamp.circuitId)) {
        audits.push({
          type: 'lamp-unknown-circuit',
          severity: 'error',
          lampId: lamp.id,
          title: `灯具 ${lamp.id} 台账回路 ${lamp.circuitId} 不存在`,
          detail: 'lamps.json 中引用了未定义的回路编号。',
        });
        continue;
      }
      const hits = state.lampsData.circuits.filter((c) => pointInPolygon(lamp.lon, lamp.lat, c.polygon));
      if (hits.length > 1) {
        audits.push({
          type: 'lamp-multi',
          severity: 'error',
          circuitId: lamp.circuitId,
          lampId: lamp.id,
          title: `灯具 ${lamp.id} 同时落在 ${hits.length} 条回路上`,
          detail: `台账回路 ${lamp.circuitId}，坐标 (${lamp.lon}, ${lamp.lat}) 落在 ${hits
            .map((c) => c.id)
            .join('、')} 范围内。`,
        });
      } else if (hits.length === 1 && hits[0].id !== lamp.circuitId) {
        const center = centroid(state.circuitById.get(lamp.circuitId).polygon);
        const dist = Math.round(haversineMeters(lamp.lon, lamp.lat, center[0], center[1]));
        audits.push({
          type: 'lamp-mismatch',
          severity: 'warn',
          circuitId: lamp.circuitId,
          lampId: lamp.id,
          title: `灯具 ${lamp.id} 坐标偏离台账回路`,
          detail: `台账回路 ${lamp.circuitId}，实际落在 ${hits[0].id}，距 ${lamp.circuitId} 中心约 ${dist} m。`,
        });
      } else if (hits.length === 0) {
        const center = centroid(state.circuitById.get(lamp.circuitId).polygon);
        const dist = Math.round(haversineMeters(lamp.lon, lamp.lat, center[0], center[1]));
        audits.push({
          type: 'lamp-outside',
          severity: 'warn',
          circuitId: lamp.circuitId,
          lampId: lamp.id,
          title: `灯具 ${lamp.id} 不在任何回路范围内`,
          detail: `台账回路 ${lamp.circuitId}，坐标 (${lamp.lon}, ${lamp.lat}) 未落入任何回路，距 ${lamp.circuitId} 中心约 ${dist} m。`,
        });
      }
    }

    // 3) 曲线时段完整性（应恰好铺满计划亮灯区间）
    for (const a of state.curvesData.assignments) {
      if (!state.circuitById.has(a.circuitId)) {
        audits.push({
          type: 'assign-unknown',
          severity: 'error',
          title: `曲线指派引用了不存在的回路 ${a.circuitId}`,
          detail: `curves.json assignments 中 ${a.curveId} → ${a.circuitId}。`,
        });
      }
      if (!state.curveById.has(a.curveId)) {
        audits.push({
          type: 'assign-unknown',
          severity: 'error',
          circuitId: a.circuitId,
          title: `回路 ${a.circuitId} 指派了不存在的曲线 ${a.curveId}`,
          detail: '该指派在计算中被忽略。',
        });
      }
    }
    const onMin = hmToMinutes(state.curvesData.scheduledOn);
    const offMin = hmToMinutes(state.curvesData.scheduledOff) + 1440;
    for (const curve of state.curvesData.curves) {
      const ivs = curveIntervals(curve);
      const problems = [];
      if (ivs[0].s !== onMin) problems.push(`起始 ${curve.segments[0].start} ≠ ${state.curvesData.scheduledOn}`);
      if (ivs[ivs.length - 1].e !== offMin) problems.push(`结束 ${curve.segments[curve.segments.length - 1].end} ≠ ${state.curvesData.scheduledOff}`);
      for (let i = 1; i < ivs.length; i++) {
        if (ivs[i].s !== ivs[i - 1].e) problems.push(`时段在 ${fmtHM(ivs[i - 1].e)} 处${ivs[i].s > ivs[i - 1].e ? '断档' : '重叠'}`);
      }
      if (problems.length) {
        audits.push({
          type: 'curve-gap',
          severity: 'warn',
          title: `曲线 ${curve.id} 时段未铺满全天计划`,
          detail: problems.join('；'),
        });
      }
    }
    return audits;
  }
  function fmtHM(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  // ---------------- 能耗计算引擎 ----------------
  // scheme = { mode: 'ledger' | 'fixed', fixedCurveId }
  // 折算方式：线性，功率(kW) × 当日亮度 → kWh
  function computeScheme(scheme) {
    const w0 = parseDate(state.windowStart);
    const w1 = parseDate(state.windowEnd);
    const plannedH = plannedHoursPerDay(state.curvesData);
    const days = eachInclusiveDay(w0, w1);

    const curveDayCache = new Map();
    function dayCurveMetrics(curveId) {
      if (!curveDayCache.has(curveId)) {
        const curve = state.curveById.get(curveId);
        curveDayCache.set(curveId, {
          wfph: weightedFullPowerHours(curve),
          litH: litHoursOfCurve(curve),
        });
      }
      return curveDayCache.get(curveId);
    }

  function curveIdForDay(circuitId, dayMs) {
      if (scheme.overrides && scheme.overrides.has(circuitId)) return scheme.overrides.get(circuitId);
      if (scheme.mode === 'fixed') return scheme.fixedCurveId;
      return resolveLedgerCurveId(circuitId, dayMs);
    }

    const circuitAgg = new Map();
    const lampAgg = new Map();
    const curveUsage = new Map(); // circuitId -> Map(curveId -> days)

    for (const c of state.lampsData.circuits) {
      circuitAgg.set(c.id, blankAgg());
      curveUsage.set(c.id, new Map());
    }

    for (const lamp of state.lampsData.lamps) {
      const commission = parseDate(lamp.commissionDate);
      const agg = blankAgg();
      for (const dayMs of days) {
        if (dayMs < commission) continue; // 未投运，当日不耗能量
        const curveId = curveIdForDay(lamp.circuitId, dayMs);
        if (!curveId || !state.curveById.has(curveId)) {
          agg.missingDays++;
          continue;
        }
        const m = dayCurveMetrics(curveId);
        const kwh = (lamp.powerW / 1000) * m.wfph;
        addDay(agg, dayMs, kwh, m.litH, plannedH, curveId);
        const cagg = circuitAgg.get(lamp.circuitId);
        if (cagg) addDay(cagg, dayMs, kwh, m.litH, plannedH, curveId);
        const cu = curveUsage.get(lamp.circuitId);
        cu.set(curveId, (cu.get(curveId) || 0) + 1);
      }
      lampAgg.set(lamp.id, agg);
    }

    const price = state.curvesData.pricePerKwh;
    const circuits = state.lampsData.circuits.map((c) => {
      const agg = circuitAgg.get(c.id);
      const usage = [...curveUsage.get(c.id).entries()]
        .map(([curveId, n]) => ({ curveId, curveName: state.curveById.get(curveId).name, days: n }))
        .sort((a, b) => b.days - a.days);
      return {
        circuitId: c.id,
        name: c.name,
        lampCount: state.lampsData.lamps.filter((l) => l.circuitId === c.id).length,
        kwh: agg.kwh,
        cost: agg.kwh * price,
        litHours: agg.litHours,
        plannedHours: agg.plannedHours,
        litRate: agg.plannedHours > 0 ? agg.litHours / agg.plannedHours : null,
        activeDays: agg.activeDays,
        missingDays: agg.missingDays,
        byMonth: agg.byMonth,
        curveUsage: usage,
      };
    });

    const total = blankAgg();
    for (const agg of circuitAgg.values()) mergeAgg(total, agg);

    return {
      scheme,
      circuits,
      lamps: state.lampsData.lamps.map((l) => {
        const agg = lampAgg.get(l.id);
        return {
          id: l.id,
          circuitId: l.circuitId,
          kwh: agg.kwh,
          cost: agg.kwh * price,
          litRate: agg.plannedHours > 0 ? agg.litHours / agg.plannedHours : null,
          activeDays: agg.activeDays,
          byMonth: agg.byMonth,
          curveDays: agg.curveDays,
        };
      }),
      total: {
        kwh: total.kwh,
        cost: total.kwh * price,
        litRate: total.plannedHours > 0 ? total.litHours / total.plannedHours : null,
        byMonth: total.byMonth,
      },
      windowDays: days.length,
      plannedHoursPerDay: plannedH,
    };
  }

  function blankAgg() {
    return {
      kwh: 0,
      litHours: 0,
      plannedHours: 0,
      activeDays: 0,
      missingDays: 0,
      byMonth: new Map(),
      curveDays: new Map(),
    };
  }

  function addDay(agg, dayMs, kwh, litH, plannedH, curveId) {
    agg.kwh += kwh;
    agg.litHours += litH;
    agg.plannedHours += plannedH;
    agg.activeDays += 1;
    const key = monthKey(dayMs);
    if (!agg.byMonth.has(key)) {
      agg.byMonth.set(key, { kwh: 0, litHours: 0, plannedHours: 0, lampDays: 0, calendarDays: 0 });
    }
    const m = agg.byMonth.get(key);
    m.kwh += kwh;
    m.litHours += litH;
    m.plannedHours += plannedH;
    m.lampDays += 1;
    agg.curveDays.set(curveId, (agg.curveDays.get(curveId) || 0) + 1);
  }

  function mergeAgg(dst, src) {
    dst.kwh += src.kwh;
    dst.litHours += src.litHours;
    dst.plannedHours += src.plannedHours;
    dst.activeDays += src.activeDays;
    dst.missingDays += src.missingDays;
    for (const [key, m] of src.byMonth) {
      if (!dst.byMonth.has(key)) dst.byMonth.set(key, { kwh: 0, litHours: 0, plannedHours: 0, lampDays: 0, calendarDays: 0 });
      const d = dst.byMonth.get(key);
      d.kwh += m.kwh;
      d.litHours += m.litHours;
      d.plannedHours += m.plannedHours;
      d.lampDays += m.lampDays;
    }
    for (const [curveId, n] of src.curveDays) {
      dst.curveDays.set(curveId, (dst.curveDays.get(curveId) || 0) + n);
    }
  }

  function windowCalendarDaysByMonth() {
    const w0 = parseDate(state.windowStart);
    const w1 = parseDate(state.windowEnd);
    const out = new Map();
    for (const t of eachInclusiveDay(w0, w1)) {
      const key = monthKey(t);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }

  // ---------------- 格式化 ----------------
  const fmtInt = (n) => Math.round(n).toLocaleString('zh-CN');
  const fmtKwh = (n) => (n >= 1000 ? n.toFixed(0) : n.toFixed(1));
  const fmtMoney = (n) => n.toFixed(2);
  const fmtPct = (r) => (r === null || r === undefined ? '—' : (r * 100).toFixed(1) + '%');
  const fmtSigned = (n, digits = 0) => (n > 0 ? '+' : '') + n.toFixed(digits);
  const el = (id) => document.getElementById(id);

  // ---------------- 初始化 ----------------
  async function init() {
    const [lampsRes, curvesRes] = await Promise.all([
      fetch('data/lamps.json'),
      fetch('data/curves.json'),
    ]);
    state.lampsData = await lampsRes.json();
    state.curvesData = await curvesRes.json();

    for (const c of state.lampsData.circuits) state.circuitById.set(c.id, c);
    for (const cv of state.curvesData.curves) state.curveById.set(cv.id, cv);
    for (const a of state.curvesData.assignments) {
      if (!state.assignmentsByCircuit.has(a.circuitId)) state.assignmentsByCircuit.set(a.circuitId, []);
      state.assignmentsByCircuit.get(a.circuitId).push(a);
    }

    el('priceBox').textContent = state.curvesData.pricePerKwh.toFixed(2);
    populateCurveSelects();
    bindEvents();
    state.audits = runAudits();
    renderModelBanner();
    renderAudits();
    renderMap();
    recalc();
    renderCalcNotes();
  }

  function populateCurveSelects() {
    for (const id of ['fixedA', 'fixedB']) {
      const sel = el(id);
      sel.innerHTML = '';
      for (const cv of state.curvesData.curves) {
        const opt = document.createElement('option');
        opt.value = cv.id;
        opt.textContent = `${cv.id} · ${cv.name}`;
        sel.appendChild(opt);
      }
    }
    el('fixedA').value = 'STD';
    el('fixedB').value = 'ECO';
  }

  function bindEvents() {
    el('windowStart').addEventListener('change', (e) => {
      state.windowStart = e.target.value;
      if (parseDate(state.windowStart) > parseDate(state.windowEnd)) {
        state.windowEnd = state.windowStart;
        el('windowEnd').value = state.windowStart;
      }
      state.audits = runAudits();
      renderAudits();
      recalc();
    });
    el('windowEnd').addEventListener('change', (e) => {
      state.windowEnd = e.target.value;
      if (parseDate(state.windowEnd) < parseDate(state.windowStart)) {
        state.windowStart = state.windowEnd;
        el('windowStart').value = state.windowEnd;
      }
      state.audits = runAudits();
      renderAudits();
      recalc();
    });

    document.querySelectorAll('input[name="modeA"]').forEach((r) =>
      r.addEventListener('change', (e) => {
        state.schemeA.mode = e.target.value;
        recalc();
      })
    );
    document.querySelectorAll('input[name="modeB"]').forEach((r) =>
      r.addEventListener('change', (e) => {
        state.schemeB.mode = e.target.value;
        recalc();
      })
    );
    el('fixedA').addEventListener('change', (e) => {
      state.schemeA.fixedCurveId = e.target.value;
      flashCard('schemeACard');
      recalc();
    });
    el('fixedB').addEventListener('change', (e) => {
      state.schemeB.fixedCurveId = e.target.value;
      flashCard('schemeBCard');
      recalc();
    });

    el('modalBackdrop').addEventListener('click', (e) => {
      if (e.target === el('modalBackdrop')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  }

  function flashCard(id) {
    const node = el(id);
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 600);
  }

  function recalc() {
    state.resultA = computeScheme(state.schemeA);
    state.resultB = computeScheme(state.schemeB);
    renderSummary();
    renderCompareTable();
    renderSelectedCircuit();
    renderWindowLabel();
  }

  function renderWindowLabel() {
    const days = inclusiveDays(parseDate(state.windowStart), parseDate(state.windowEnd));
    el('windowDays').textContent = `${days} 天（含首尾）`;
  }

  function renderModelBanner() {
    const m = state.curvesData.brightnessModel;
    el('modelBanner').innerHTML =
      `折算方式：<b>${m.name}</b>（id: ${m.id}）。${m.note} ` +
      `计划亮灯 ${state.curvesData.scheduledOn} ~ 次日 ${state.curvesData.scheduledOff}，每日 ${plannedHoursPerDay(
        state.curvesData
      )} 小时。`;
  }

  // ---------------- 审计栏 ----------------
  function renderAudits() {
    const panel = el('auditPanel');
    panel.innerHTML = '';
    if (state.audits.length === 0) {
      const ok = document.createElement('div');
      ok.className = 'audit-ok';
      ok.textContent = '未发现曲线重叠或坐标异常。';
      panel.appendChild(ok);
      return;
    }
    const errors = state.audits.filter((a) => a.severity === 'error').length;
    const warns = state.audits.filter((a) => a.severity === 'warn').length;
    const head = document.createElement('div');
    head.className = 'audit-ok';
    head.style.borderColor = 'rgba(248,113,113,0.5)';
    head.style.color = 'var(--bad)';
    head.style.background = 'rgba(248,113,113,0.06)';
    head.textContent = `数据校验：${errors} 个错误、${warns} 个警告（点击条目可定位）`;
    panel.appendChild(head);

    for (const a of state.audits) {
      const item = document.createElement('div');
      item.className = `audit-item ${a.severity} clickable`;
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = a.title;
      const d = document.createElement('div');
      d.className = 'd';
      d.textContent = a.detail;
      item.append(t, d);
      item.addEventListener('click', () => {
        if (a.circuitId) selectCircuit(a.circuitId);
        if (a.lampId) {
          state.selectedLampId = a.lampId;
          updateLampStyles();
          openLampModal(a.lampId);
        }
        document.querySelector('.map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      panel.appendChild(item);
    }
  }

  // ---------------- 地图 ----------------
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function anomalyLampIds() {
    const set = new Set();
    for (const a of state.audits) {
      if (a.lampId) set.add(a.lampId);
    }
    return set;
  }

  function lampHits(lamp) {
    return state.lampsData.circuits.filter((c) => pointInPolygon(lamp.lon, lamp.lat, c.polygon));
  }

  function renderMap() {
    const wrap = el('mapWrap');
    wrap.innerHTML = '';

    const allPts = state.lampsData.circuits.flatMap((c) => c.polygon);
    const allLons = allPts.map((p) => p[0]).concat(state.lampsData.lamps.map((l) => l.lon));
    const allLats = allPts.map((p) => p[1]).concat(state.lampsData.lamps.map((l) => l.lat));
    const minLon = Math.min(...allLons);
    const maxLon = Math.max(...allLons);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    const padLon = (maxLon - minLon) * 0.04;
    const padLat = (maxLat - minLat) * 0.05;
    const W = 760;
    const H = 560;
    const sx = (lon) => ((lon - minLon + padLon) / (maxLon - minLon + padLon * 2)) * (W - 20) + 10;
    const sy = (lat) => H - (((lat - minLat + padLat) / (maxLat - minLat + padLat * 2)) * (H - 20) + 10);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('id', 'mapSvg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);

    // polygons
    for (const c of state.lampsData.circuits) {
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', c.polygon.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' '));
      poly.setAttribute('class', 'circuit-poly');
      poly.dataset.circuitId = c.id;
      poly.addEventListener('click', () => selectCircuit(c.id));
      svg.appendChild(poly);

      const [clon, clat] = centroid(c.polygon);
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', sx(clon));
      label.setAttribute('y', sy(clat) - 2);
      label.setAttribute('class', 'circuit-label');
      label.dataset.circuitLabel = c.id;
      label.textContent = c.id;
      svg.appendChild(label);
    }

    // deviation guide lines for mismatched / outside lamps
    const badIds = anomalyLampIds();
    for (const lamp of state.lampsData.lamps) {
      if (!badIds.has(lamp.id)) continue;
      const c = state.circuitById.get(lamp.circuitId);
      if (!c) continue;
      const [clon, clat] = centroid(c.polygon);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', sx(lamp.lon));
      line.setAttribute('y1', sy(lamp.lat));
      line.setAttribute('x2', sx(clon));
      line.setAttribute('y2', sy(clat));
      line.setAttribute('class', 'deviation-line');
      svg.appendChild(line);
    }

    // lamps
    for (const lamp of state.lampsData.lamps) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', sx(lamp.lon));
      circle.setAttribute('cy', sy(lamp.lat));
      circle.setAttribute('r', 3.6);
      const isBad = badIds.has(lamp.id);
      circle.setAttribute('class', `lamp-dot ${isBad ? 'anomaly' : 'normal'}`);
      circle.dataset.lampId = lamp.id;
      circle.dataset.circuit = lamp.circuitId;
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${lamp.id} · ${lamp.powerW}W · ${lamp.lightSource} · 台账 ${lamp.circuitId}`;
      circle.appendChild(title);
      circle.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedLampId = lamp.id;
        updateLampStyles();
        openLampModal(lamp.id);
      });
      svg.appendChild(circle);
    }

    wrap.appendChild(svg);
    updateLampStyles();
  }

  function selectCircuit(circuitId) {
    state.selectedCircuitId = state.selectedCircuitId === circuitId ? null : circuitId;
    state.selectedLampId = null;
    updateLampStyles();
    renderSelectedCircuit();
    updateRowHighlight();
  }

  function updateLampStyles() {
    const badIds = anomalyLampIds();
    document.querySelectorAll('#mapSvg .lamp-dot').forEach((node) => {
      const lampId = node.dataset.lampId;
      const classes = ['lamp-dot'];
      classes.push(badIds.has(lampId) ? 'anomaly' : 'normal');
      if (state.selectedCircuitId) {
        classes.push(node.dataset.circuit === state.selectedCircuitId ? 'selected-circuit' : 'dim');
      }
      if (lampId === state.selectedLampId) classes.push('selected-lamp');
      node.setAttribute('class', classes.join(' '));
    });
    document.querySelectorAll('#mapSvg .circuit-poly').forEach((node) => {
      node.classList.toggle('selected', node.dataset.circuitId === state.selectedCircuitId);
    });
    document.querySelectorAll('#mapSvg .circuit-label').forEach((node) => {
      node.classList.toggle('selected', node.dataset.circuitLabel === state.selectedCircuitId);
    });
  }

  // ---------------- 总览 ----------------
  function renderSummary() {
    const a = state.resultA.total;
    const b = state.resultB.total;
    el('totA-kwh').textContent = fmtKwh(a.kwh);
    el('totA-cost').textContent = fmtMoney(a.cost);
    el('totA-rate').textContent = fmtPct(a.litRate);
    el('totB-kwh').textContent = fmtKwh(b.kwh);
    el('totB-cost').textContent = fmtMoney(b.cost);
    el('totB-rate').textContent = fmtPct(b.litRate);
  }

  // ---------------- 选中回路 ----------------
  function curveBadge(resultCircuit, modeName) {
    if (!resultCircuit) return ['badge-none', '—'];
    const usage = resultCircuit.curveUsage;
    if (usage.length === 0) return ['badge-none', '无生效曲线'];
    if (usage.length === 1) return ['badge-curve', `${usage[0].curveId}`];
    return ['badge-curve badge-multi', usage.map((u) => `${u.curveId}×${u.days}d`).join(' / ')];
  }

  function renderSelectedCircuit() {
    const title = el('selectedTitle');
    const body = el('selectedBody');
    body.innerHTML = '';
    const cid = state.selectedCircuitId;
    if (!cid) {
      title.textContent = '未选择回路';
      body.classList.add('muted');
      body.textContent = '在左侧平面图点击回路，可在此为 A / B 分别改曲线。';
      return;
    }
    body.classList.remove('muted');
    const circuit = state.circuitById.get(cid);
    const rowA = state.resultA.circuits.find((c) => c.circuitId === cid);
    const rowB = state.resultB.circuits.find((c) => c.circuitId === cid);
    title.textContent = `${cid} · ${circuit.name}`;

    body.appendChild(curveOverrideRow('A', cid, state.schemeA, rowA, 'tag-a'));
    body.appendChild(curveOverrideRow('B', cid, state.schemeB, rowB, 'tag-b'));

    const kv = document.createElement('div');
    kv.className = 'kv-line';
    const delta = rowB.kwh - rowA.kwh;
    kv.innerHTML =
      `A：${fmtKwh(rowA.kwh)} kWh / ${fmtMoney(rowA.cost)} 元，亮灯率 ${fmtPct(rowA.litRate)}；` +
      `B：${fmtKwh(rowB.kwh)} kWh / ${fmtMoney(rowB.cost)} 元，亮灯率 ${fmtPct(rowB.litRate)}。` +
      ` B−A = <b class="${delta > 0 ? 'delta-pos' : 'delta-neg'}">${fmtSigned(delta, 1)} kWh</b>` +
      `（${fmtSigned(rowB.cost - rowA.cost, 2)} 元）。`;
    body.appendChild(kv);
  }

  function curveOverrideRow(tag, cid, scheme, resultCircuit, tagClass) {
    const row = document.createElement('div');
    row.className = 'curve-row';
    const tagNode = document.createElement('span');
    tagNode.className = `tag ${tagClass}`;
    tagNode.textContent = tag;
    const right = document.createElement('div');
    const sel = document.createElement('select');
    const follow = document.createElement('option');
    follow.value = '';
    follow.textContent = '跟随上方全局设置';
    sel.appendChild(follow);
    for (const cv of state.curvesData.curves) {
      const opt = document.createElement('option');
      opt.value = cv.id;
      opt.textContent = `仅本回路改用 ${cv.id} · ${cv.name}`;
      sel.appendChild(opt);
    }
    if (!scheme.overrides) scheme.overrides = new Map();
    sel.value = scheme.overrides.get(cid) || '';
    sel.addEventListener('change', () => {
      if (sel.value) scheme.overrides.set(cid, sel.value);
      else scheme.overrides.delete(cid);
      recalc();
      flashCard(tag === 'A' ? 'schemeACard' : 'schemeBCard');
    });
    right.appendChild(sel);

    const chips = document.createElement('div');
    chips.className = 'usage-chips';
    if (resultCircuit.curveUsage.length === 0) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = '窗口内无生效曲线';
      chips.appendChild(c);
    } else {
      for (const u of resultCircuit.curveUsage) {
        const c = document.createElement('span');
        c.className = 'chip';
        c.innerHTML = `实际按 <b>${u.curveId}</b> 计 ${u.days} 灯·日`;
        chips.appendChild(c);
      }
    }
    right.appendChild(chips);
    row.append(tagNode, right);
    return row;
  }

  // ---------------- 对比表 ----------------
  function renderCompareTable() {
    const tbody = el('compareTable').querySelector('tbody');
    const tfoot = el('compareTable').querySelector('tfoot');
    tbody.innerHTML = '';
    tfoot.innerHTML = '';

    const rows = state.lampsData.circuits.map((c) => {
      const a = state.resultA.circuits.find((x) => x.circuitId === c.id);
      const b = state.resultB.circuits.find((x) => x.circuitId === c.id);
      return { c, a, b, diff: b.kwh - a.kwh };
    });
    rows.sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff));

    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.dataset.circuitId = r.c.id;
      if (r.c.id === state.selectedCircuitId) tr.classList.add('selected');
      const [aCls, aTxt] = curveBadge(r.a);
      const [bCls, bTxt] = curveBadge(r.b);
      tr.innerHTML = `
        <td>${r.c.id}<div class="muted small">${r.c.name}</div></td>
        <td>${r.a.lampCount}</td>
        <td class="scheme-col"><span class="${aCls}">${aTxt}</span></td>
        <td class="scheme-col">${fmtKwh(r.a.kwh)}</td>
        <td class="scheme-col">${fmtMoney(r.a.cost)}</td>
        <td class="scheme-col">${fmtPct(r.a.litRate)}</td>
        <td class="scheme-col"><span class="${bCls}">${bTxt}</span></td>
        <td class="scheme-col">${fmtKwh(r.b.kwh)}</td>
        <td class="scheme-col">${fmtMoney(r.b.cost)}</td>
        <td class="scheme-col">${fmtPct(r.b.litRate)}</td>
        <td class="${r.diff > 0 ? 'delta-pos' : r.diff < 0 ? 'delta-neg' : ''}">${fmtSigned(r.diff, 1)}</td>
        <td class="${r.diff > 0 ? 'delta-pos' : r.diff < 0 ? 'delta-neg' : ''}">${fmtSigned(r.b.cost - r.a.cost, 2)}</td>`;
      tr.addEventListener('click', () => selectCircuit(r.c.id));
      tbody.appendChild(tr);
    }

    const ta = state.resultA.total;
    const tb = state.resultB.total;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>合计</td><td>${state.lampsData.lamps.length}</td>
      <td class="scheme-col"></td>
      <td class="scheme-col">${fmtKwh(ta.kwh)}</td>
      <td class="scheme-col">${fmtMoney(ta.cost)}</td>
      <td class="scheme-col">${fmtPct(ta.litRate)}</td>
      <td class="scheme-col"></td>
      <td class="scheme-col">${fmtKwh(tb.kwh)}</td>
      <td class="scheme-col">${fmtMoney(tb.cost)}</td>
      <td class="scheme-col">${fmtPct(tb.litRate)}</td>
      <td class="${tb.kwh - ta.kwh > 0 ? 'delta-pos' : 'delta-neg'}">${fmtSigned(tb.kwh - ta.kwh, 1)}</td>
      <td class="${tb.cost - ta.cost > 0 ? 'delta-pos' : 'delta-neg'}">${fmtSigned(tb.cost - ta.cost, 2)}</td>`;
    tfoot.appendChild(tr);
  }

  function updateRowHighlight() {
    document.querySelectorAll('#compareTable tbody tr').forEach((tr) => {
      tr.classList.toggle('selected', tr.dataset.circuitId === state.selectedCircuitId);
    });
  }

  // ---------------- 单灯弹窗（逐步验算） ----------------
  function openLampModal(lampId) {
    const lamp = state.lampsData.lamps.find((l) => l.id === lampId);
    if (!lamp) return;
    const hits = lampHits(lamp);
    const la = state.resultA.lamps.find((l) => l.id === lampId);
    const lb = state.resultB.lamps.find((l) => l.id === lampId);
    const price = state.curvesData.pricePerKwh;
    const plannedH = plannedHoursPerDay(state.curvesData);

    const modal = el('lampModal');
    modal.innerHTML = '';

    const head = document.createElement('h2');
    head.innerHTML = `<span>${lamp.id} · ${lamp.powerW}W ${lamp.lightSource}</span><span class="close" title="关闭">×</span>`;
    head.querySelector('.close').addEventListener('click', closeModal);
    modal.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'modal-grid';
    const kv = [
      ['台账回路', lamp.circuitId + ' · ' + state.circuitById.get(lamp.circuitId).name],
      ['坐标', `${lamp.lon}, ${lamp.lat}`],
      ['几何落点', hits.length ? hits.map((c) => c.id).join('、') : '不在任何回路'],
      ['投运日期', lamp.commissionDate],
      ['统计窗口', `${state.windowStart} ~ ${state.windowEnd}`],
      ['有效在运天数', `${la.activeDays} 天（按投运日起含首日）`],
    ];
    for (const [k, v] of kv) {
      const kNode = document.createElement('div');
      kNode.className = 'k';
      kNode.textContent = k;
      const vNode = document.createElement('div');
      vNode.textContent = v;
      grid.append(kNode, vNode);
    }
    modal.appendChild(grid);

    modal.appendChild(
      lampStepBox('方案 A', lamp, la, state.schemeA, price, plannedH, 'tag-a')
    );
    modal.appendChild(
      lampStepBox('方案 B', lamp, lb, state.schemeB, price, plannedH, 'tag-b')
    );

    el('modalBackdrop').classList.remove('hidden');
  }

  function lampStepBox(tag, lamp, result, scheme, price, plannedH, tagClass) {
    const box = document.createElement('div');
    box.className = 'step-box';
    const head = document.createElement('h4');
    head.innerHTML = `<span class="tag ${tagClass}">${tag}</span> 演算过程`;
    box.appendChild(head);

    if (result.activeDays === 0) {
      const p = document.createElement('div');
      p.className = 'muted';
      p.textContent = '该灯在统计窗口内尚未投运，能耗为 0。';
      box.appendChild(p);
      return box;
    }

    const lines = [];
    lines.push(
      `① 计划亮灯：每日 ${state.curvesData.scheduledOn} ~ 次日 ${state.curvesData.scheduledOff} = ${plannedH} h/天。`
    );

    const parts = [...result.curveDays.entries()]
      .map(([curveId, days]) => {
        const cv = state.curveById.get(curveId);
        const w = weightedFullPowerHours(cv);
        const lit = litHoursOfCurve(cv);
        return { curveId, days, w, lit, segText: cv.segments.map((s) => `${s.start}-${s.end} ${s.brightnessPct}%`).join('，') };
      })
      .sort((a, b) => b.days - a.days);

    parts.forEach((p, i) => {
      lines.push(
        `②-${i + 1} 曲线 ${p.curveId}（${p.segText}）：当日等效满功率 ` +
        `${p.w.toFixed(2)} h，实际点亮 ${p.lit.toFixed(2)} h；按此曲线计 ${p.days} 天。`
      );
    });

    const wTotal = parts.reduce((s, p) => s + p.w * p.days, 0);
    const litTotal = parts.reduce((s, p) => s + p.lit * p.days, 0);
    const plannedTotal = plannedH * result.activeDays;
    lines.push(
      `③ 线性折算能耗 = ${lamp.powerW / 1000} kW × Σ(等效满功率h×天数) = ${lamp.powerW / 1000} × ${wTotal.toFixed(
        2
      )} = <span class="formula">${result.kwh.toFixed(3)} kWh</span>。`
    );
    lines.push(
      `④ 电费 = ${result.kwh.toFixed(3)} × ${price} = <span class="formula">${result.cost.toFixed(
        3
      )} 元</span>。`
    );
    lines.push(
      `⑤ 亮灯率 = 实际点亮 ${litTotal.toFixed(2)} h ÷ 计划 ${plannedTotal.toFixed(
        2
      )} h = <span class="formula">${fmtPct(result.litRate)}</span>。`
    );

    for (const text of lines) {
      const p = document.createElement('div');
      p.innerHTML = text;
      p.style.margin = '4px 0';
      box.appendChild(p);
    }

    // monthly breakdown
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    thead.innerHTML =
      '<tr><th>月份</th><th>在运天数</th><th>该月日历天</th><th>能耗 (kWh)</th><th>电费 (元)</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    const cal = windowCalendarDaysByMonth();
    for (const [key, m] of [...result.byMonth.entries()].sort()) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${monthLabel(key)}</td><td>${m.lampDays}</td><td>${cal.get(
        key
      )}</td><td>${m.kwh.toFixed(3)}</td><td>${(m.kwh * price).toFixed(3)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

    return box;
  }

  function closeModal() {
    el('modalBackdrop').classList.add('hidden');
    state.selectedLampId = null;
    updateLampStyles();
  }

  // ---------------- 底部口径说明 ----------------
  function renderCalcNotes() {
    const m = state.curvesData.brightnessModel;
    const price = state.curvesData.pricePerKwh;
    const std = state.curveById.get('STD');
    const notes = [
      `<b>折算方式：${m.name}</b>。${m.note}`,
      `单灯单日能耗 = 额定功率(kW) × 当日等效满功率小时；当日等效满功率小时 = Σ 时段时长(h) × 亮度%。`,
      ...(std
        ? [
            `以标准曲线为例：${std.segments
              .map((s) => `${s.start}-${s.end} 取 ${s.brightnessPct}%`)
              .join('，')} → ${weightedFullPowerHours(std).toFixed(2)} 等效满功率小时/天。`,
          ]
        : []),
      `单灯区间能耗 = 功率(kW) × Σ(各曲线等效满功率小时 × 适用天数)；电费 = 能耗(kWh) × ${price} 元/kWh。`,
      `日数按真实日历逐日累计：跨月分别归入对应自然月，2 月按 28/29 天、大小月按实际天数，投运日之前不计（含投运首日）。`,
      `亮灯率 = 全部在运灯·日的实际点亮小时之和 ÷ 计划亮灯小时之和（计划 ${state.curvesData.scheduledOn} ~ 次日 ${state.curvesData.scheduledOff}，每日 ${plannedHoursPerDay(
        state.curvesData
      )} 小时；亮度 0% 的时段不计实际点亮）。`,
      `同一回路同一时刻存在多条生效曲线时按错误上报，计算取 startDate 最晚的一条；一条曲线可套用于多条回路。`,
      `坐标同时落入多个回路多边形、落入回路与台账不符、落入所有回路之外，均在上方审计栏列出并在地图标红。`,
    ];
    const ol = el('calcNotes');
    ol.innerHTML = '';
    for (const n of notes) {
      const li = document.createElement('li');
      li.innerHTML = n;
      ol.appendChild(li);
    }
  }

  // ---------------- 启动 / 导出（供 Node 验算脚本复用） ----------------
  const api = {
    state,
    parseDate,
    fmtDate,
    inclusiveDays,
    overlapInclusiveDays,
    pointInPolygon,
    weightedFullPowerHours,
    litHoursOfCurve,
    plannedHoursPerDay,
    curveIntervals,
    runAudits,
    computeScheme,
    loadForTest(lampsData, curvesData, windowStart, windowEnd) {
      state.lampsData = lampsData;
      state.curvesData = curvesData;
      state.circuitById = new Map(lampsData.circuits.map((c) => [c.id, c]));
      state.curveById = new Map(curvesData.curves.map((c) => [c.id, c]));
      state.assignmentsByCircuit = new Map();
      for (const a of curvesData.assignments) {
        if (!state.assignmentsByCircuit.has(a.circuitId)) state.assignmentsByCircuit.set(a.circuitId, []);
        state.assignmentsByCircuit.get(a.circuitId).push(a);
      }
      state.schemeA = { mode: 'ledger', fixedCurveId: 'STD', overrides: new Map() };
      state.schemeB = { mode: 'fixed', fixedCurveId: 'ECO', overrides: new Map() };
      if (windowStart) state.windowStart = windowStart;
      if (windowEnd) state.windowEnd = windowEnd;
    },
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
