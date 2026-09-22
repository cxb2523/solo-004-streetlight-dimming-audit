/* 页面交互逻辑：加载数据 -> 审计 -> 地图 -> 双方案能耗对比，全部调用 core.js。 */
(function () {
  'use strict';

  const core = window.LampCore;

  const state = {
    data: null,
    price: 0.62,
    range: { start: '2026-01-01', end: '2026-12-31' },
    refDate: '2026-07-01',
    schemeA: {},
    schemeB: {},
    selectedCircuit: null,
    issues: [],
  };

  const CIRCUIT_COLORS = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231',
    '#911eb4', '#42d4f4', '#f032e6', '#9a6324',
    '#808000', '#000075', '#469990', '#bfef45',
  ];

  const fmtKwh = (v) => `${v.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}`;
  const fmtMoney = (v) => v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
  const fmtSigned = (v) => `${v >= 0 ? '+' : ''}${v.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}`;
  const fmtSignedMoney = (v) =>
    `${v >= 0 ? '+' : ''}${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  async function loadJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url} 加载失败：HTTP ${res.status}`);
    return res.json();
  }

  async function init() {
    try {
      const [lampsDoc, curvesDoc] = await Promise.all([
        loadJson('/data/lamps.json'),
        loadJson('/data/curves.json'),
      ]);
      state.data = { ...curvesDoc, ...lampsDoc };
      state.price = lampsDoc.pricePerKwh ?? 0.62;
      if (curvesDoc.defaultRange) {
        state.range.start = curvesDoc.defaultRange.start;
        state.range.end = curvesDoc.defaultRange.end;
      }
      state.refDate = '2026-07-01';
      state.schemeA = core.baselineMapping(state.data, state.refDate);
      state.schemeB = core.baselineMapping(state.data, state.refDate);

      document.getElementById('dateStart').value = state.range.start;
      document.getElementById('dateEnd').value = state.range.end;
      document.getElementById('refDate').value = state.refDate;
      document.getElementById('priceBadge').textContent = state.price.toFixed(2);

      state.issues = core.audit(state.data);
      state.selectedCircuit = state.data.circuits[0].id;

      bindEvents();
      renderAll();
    } catch (err) {
      document.body.insertAdjacentHTML(
        'afterbegin',
        `<div style="padding:20px;color:#b42318">加载失败：${err.message}</div>`,
      );
    }
  }

  function bindEvents() {
    document.getElementById('btnRecalc').addEventListener('click', () => {
      const start = document.getElementById('dateStart').value;
      const end = document.getElementById('dateEnd').value;
      const ref = document.getElementById('refDate').value;
      if (!start || !end || !ref) return alert('请填齐分析区间与基准取数日');
      state.range = { start, end };
      state.refDate = ref;
      renderAll();
    });
  }

  function renderAll() {
    renderModelNote();
    renderAudit();
    renderMonthStrip();
    renderMap();
    renderDetail();
    renderCompare();
  }

  function renderModelNote() {
    const d = state.data;
    const el = document.getElementById('modelNote');
    el.innerHTML = `
      <span class="tag">折算方式</span>
      本页采用<strong>亮度百分比线性折算</strong>：瞬时功率系数 = 亮度% / 100，
      即 50% 亮度按 50% 额定功率计电，<strong>不做光通量补偿</strong>。
      能耗 = 额定功率(kW) × 当日各时段(亮度%/100 × 小时数)之和 × 生效天数。
      同一回路若同一时刻存在多条生效曲线，方案基准按<strong>开始日最晚</strong>者取数（审计区会同时把重叠报出来）。
      亮灯率 = 亮度加权点亮分钟 ÷ 计划点亮分钟（数据：${d.dimmingModelNote || ''}）。
    `;
  }

  function renderAudit() {
    const panel = document.getElementById('auditPanel');
    const list = document.getElementById('auditList');
    if (state.issues.length === 0) {
      panel.className = 'audit-panel ok';
      list.innerHTML = '<div class="audit-item">未发现曲线重叠、坏引用或坐标归属问题。</div>';
      return;
    }
    const counts = state.issues.reduce((acc, i) => {
      acc[i.level] = (acc[i.level] || 0) + 1;
      return acc;
    }, {});
    panel.className = 'audit-panel';
    panel.querySelector('h2').textContent =
      `数据审计（${state.issues.length} 项：错误 ${counts.error || 0}，告警 ${counts.warn || 0}）`;
    list.innerHTML = state.issues.map((issue) => `
      <div class="audit-item ${issue.level}">
        <span class="badge ${issue.level}">${issue.level === 'error' ? '错误' : '告警'}</span>
        ${issue.message}
      </div>
    `).join('');
  }

  function renderMonthStrip() {
    const chunks = core.monthChunks(state.range.start, state.range.end);
    const total = chunks.reduce((s, c) => s + c.days, 0);
    document.getElementById('monthStrip').innerHTML = chunks.map((c) => `
      <div class="month-cell">
        <div class="ym">${c.year}-${String(c.month).padStart(2, '0')}</div>
        <div><span class="days">${c.days}</span> <span class="unit">天</span></div>
      </div>
    `).join('') + `
      <div class="month-cell">
        <div class="ym">合计</div>
        <div><span class="days">${total}</span> <span class="unit">天</span></div>
      </div>
    `;
  }

  const circuitById = (id) => state.data.circuits.find((c) => c.id === id);
  const curveById = (id) => state.data.curves.find((c) => c.id === id);
  const colorOfCircuit = (id) =>
    CIRCUIT_COLORS[state.data.circuits.findIndex((c) => c.id === id) % CIRCUIT_COLORS.length];

  function geometryBounds() {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const c of state.data.circuits) {
      for (const [lng, lat] of c.polygon) {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    }
    for (const lamp of state.data.lamps) {
      minLng = Math.min(minLng, lamp.lng);
      maxLng = Math.max(maxLng, lamp.lng);
      minLat = Math.min(minLat, lamp.lat);
      maxLat = Math.max(maxLat, lamp.lat);
    }
    return { minLng, maxLng, minLat, maxLat };
  }

  function anomalyLampIds() {
    return new Set(
      state.issues
        .filter((i) => i.type === 'geometry' && i.lampId)
        .map((i) => i.lampId),
    );
  }

  function renderMap() {
    const b = geometryBounds();
    const width = 640;
    const height = 480;
    const pad = 36;
    const sx = (lng) =>
      pad + ((lng - b.minLng) / (b.maxLng - b.minLng || 1)) * (width - 2 * pad);
    const sy = (lat) =>
      height - pad - ((lat - b.minLat) / (b.maxLat - b.minLat || 1)) * (height - 2 * pad);

    const anomalies = anomalyLampIds();
    const selected = state.selectedCircuit;

    const polys = state.data.circuits.map((c) => {
      const points = c.polygon.map(([lng, lat]) => `${sx(lng).toFixed(1)},${sy(lat).toFixed(1)}`).join(' ');
      const centroid = c.polygon.reduce(
        (acc, [lng, lat]) => [acc[0] + sx(lng) / c.polygon.length, acc[1] + sy(lat) / c.polygon.length],
        [0, 0],
      );
      const dimmed = selected && selected !== c.id ? 'dimmed' : '';
      return `
        <polygon class="circuit-poly ${dimmed}" data-circuit="${c.id}"
          points="${points}" fill="${colorOfCircuit(c.id)}" fill-opacity="0.28"></polygon>
        <text class="circuit-label ${dimmed}" x="${centroid[0].toFixed(1)}" y="${centroid[1].toFixed(1)}">
          ${c.id}
        </text>
      `;
    }).join('');

    const dots = state.data.lamps.map((lamp) => {
      const dimmed = selected && lamp.circuitId !== selected ? 'dimmed' : '';
      const anomaly = anomalies.has(lamp.id) ? 'anomaly' : '';
      return `
        <circle class="lamp-dot ${dimmed} ${anomaly}" data-circuit="${lamp.circuitId}"
          cx="${sx(lamp.lng).toFixed(1)}" cy="${sy(lamp.lat).toFixed(1)}" r="3.4"
          fill="${colorOfCircuit(lamp.circuitId)}">
          <title>${lamp.id}｜${lamp.circuitId}｜${lamp.sourceType} ${lamp.powerKw}kW｜${lamp.commissionDate}</title>
        </circle>
      `;
    }).join('');

    document.getElementById('mapWrap').innerHTML = `
      <svg class="map" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">
        ${polys}
        ${dots}
      </svg>
    `;

    document.querySelectorAll('#mapWrap [data-circuit]').forEach((node) => {
      node.addEventListener('click', () => selectCircuit(node.dataset.circuit));
    });

    document.getElementById('mapLegend').innerHTML = state.data.circuits.map((c) => `
      <span class="legend-item ${selected === c.id ? 'active' : ''}" data-circuit="${c.id}">
        <span class="legend-swatch" style="background:${colorOfCircuit(c.id)}"></span>
        ${c.id} ${c.name}
      </span>
    `).join('');
    document.querySelectorAll('#mapLegend .legend-item').forEach((node) => {
      node.addEventListener('click', () => selectCircuit(node.dataset.circuit));
    });
  }

  function selectCircuit(id) {
    state.selectedCircuit = id;
    renderMap();
    renderDetail();
    renderCompare();
  }

  function segPreviewHtml(curveId) {
    const curve = curveId ? curveById(curveId) : null;
    if (!curve) return '<span class="muted">未配置曲线（按不亮灯、零能耗计算）</span>';
    return curve.segments
      .map((s) => `<span class="seg-chip">${s.start}–${s.end}：${s.level}%</span>`)
      .join('') +
      ` <span class="muted">日加权 ${(core.dailyStats(curve).weightedHours).toFixed(3)} h</span>`;
  }

  function renderDetail() {
    const circuit = circuitById(state.selectedCircuit);
    const aId = state.schemeA[circuit.id] ?? '';
    const bId = state.schemeB[circuit.id] ?? '';

    document.getElementById('detailTitle').textContent =
      `回路详情 · ${circuit.id} ${circuit.name}`;

    const options = (current) =>
      `<option value="">（不配置曲线）</option>` +
      state.data.curves.map((c) =>
        `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>${c.id} ${c.name}</option>`,
      ).join('');

    document.getElementById('curveControls').innerHTML = `
      <div class="scheme-controls">
        <div class="scheme-control scheme-a">
          <h3>方案 A 当前档位</h3>
          <select data-scheme="A" data-circuit="${circuit.id}">${options(aId)}</select>
          <div class="seg-preview">${segPreviewHtml(aId)}</div>
        </div>
        <div class="scheme-control scheme-b">
          <h3>方案 B 当前档位</h3>
          <select data-scheme="B" data-circuit="${circuit.id}">${options(bId)}</select>
          <div class="seg-preview">${segPreviewHtml(bId)}</div>
        </div>
      </div>
    `;

    document.querySelectorAll('#curveControls select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const key = sel.dataset.scheme === 'A' ? 'schemeA' : 'schemeB';
        state[key][sel.dataset.circuit] = sel.value || null;
        renderDetail();
        renderCompare();
      });
    });

    renderWorkedExample(circuit);
    renderLampTable(circuit);
  }

  function renderWorkedExample(circuit) {
    const lamps = state.data.lamps.filter((l) => l.circuitId === circuit.id);
    const sample = lamps[0];
    const aId = state.schemeA[circuit.id] ?? null;
    const curve = aId ? curveById(aId) : null;
    if (!sample || !curve) {
      document.getElementById('workedExample').innerHTML =
        '<div class="worked-example"><h3>逐步验算</h3><span class="muted">该回路无灯或未配置曲线。</span></div>';
      return;
    }
    const stats = core.dailyStats(curve);
    const days = core.activeDays(sample.commissionDate, state.range.start, state.range.end);
    const segMath = curve.segments
      .map((s) => {
        let mins;
        const sh = toMinutes(s.start);
        let eh = toMinutes(s.end);
        if (eh <= sh) eh += 1440;
        mins = eh - sh;
        return `${mins}min×${s.level}%`;
      })
      .join(' + ');
    const kwh = sample.powerKw * stats.weightedHours * days;
    document.getElementById('workedExample').innerHTML = `
      <div class="worked-example">
        <h3>逐步验算（方案 A，以 ${sample.id} 为例，线性折算）</h3>
        ① 日加权点亮分钟 = ${segMath} = <strong>${stats.weightedMinutes}</strong> min<br>
        ② 日折算点亮小时 = ${stats.weightedMinutes} ÷ 100 ÷ 60 =
          <strong>${stats.weightedHours.toFixed(3)}</strong> h（50% 亮度即按 0.5 功率）<br>
        ③ 生效天数：投运 ${sample.commissionDate} 在区间
          ${state.range.start}~${state.range.end} 内共 <strong>${days}</strong> 天（按自然月）<br>
        ④ 区间能耗 = ${sample.powerKw} kW × ${stats.weightedHours.toFixed(3)} h × ${days} 天
          = <strong class="formula">${kwh.toFixed(3)}</strong> kWh<br>
        ⑤ 电费 = ${kwh.toFixed(3)} × ${state.price.toFixed(2)}
          = <strong class="formula">${(kwh * state.price).toFixed(2)}</strong> 元<br>
        ⑥ 该灯亮灯率（加权）= ${stats.weightedMinutes} ÷ ${stats.litMinutes} ÷ 100
          = <strong>${fmtPct(stats.weightedMinutes / stats.litMinutes / 100)}</strong>
      </div>
    `;
  }

  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function renderLampTable(circuit) {
    const anomalies = anomalyLampIds();
    const lamps = state.data.lamps
      .filter((l) => l.circuitId === circuit.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const aId = state.schemeA[circuit.id] ?? null;
    const bId = state.schemeB[circuit.id] ?? null;
    const statsA = aId ? core.dailyStats(curveById(aId)) : null;
    const statsB = bId ? core.dailyStats(curveById(bId)) : null;

    const rows = lamps.map((lamp) => {
      const days = core.activeDays(lamp.commissionDate, state.range.start, state.range.end);
      const kwhA = statsA ? lamp.powerKw * statsA.weightedHours * days : 0;
      const kwhB = statsB ? lamp.powerKw * statsB.weightedHours * days : 0;
      const status = days === 0 ? '<span class="muted">未投运/0天</span>' :
        anomalies.has(lamp.id) ? '<strong style="color:#d64545">坐标异常</strong>' : '正常';
      return `
        <tr class="${anomalies.has(lamp.id) ? 'row-anomaly' : ''}">
          <td>${lamp.id}${anomalies.has(lamp.id) ? ' ⚠' : ''}</td>
          <td>${lamp.sourceType}</td>
          <td>${lamp.powerKw.toFixed(2)}</td>
          <td>${lamp.commissionDate}</td>
          <td>${days}</td>
          <td>${status}</td>
          <td class="col-a">${fmtKwh(kwhA)}</td>
          <td class="col-b">${fmtKwh(kwhB)}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('lampTableWrap').innerHTML = `
      <div class="lamp-scroll">
        <table>
          <thead>
            <tr>
              <th>灯号</th><th>光源</th><th>功率 kW</th><th>投运日期</th>
              <th>生效天数</th><th>状态</th>
              <th class="col-a">A 能耗 kWh</th><th class="col-b">B 能耗 kWh</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function rateCell(rate) {
    if (rate == null) return '<span class="muted">—</span>';
    return `
      <span class="rate-bar"><span class="rate-fill" style="width:${(rate * 100).toFixed(1)}%"></span></span>
      ${fmtPct(rate)}
    `;
  }

  function renderCompare() {
    const { start, end } = state.range;
    const resultA = core.computeScheme(state.data, state.schemeA, start, end, state.price);
    const resultB = core.computeScheme(state.data, state.schemeB, start, end, state.price);

    document.getElementById('totalsBar').innerHTML = `
      <div class="total-box scheme-a">
        <h3>方案 A 总计</h3>
        <div class="total-grid">
          <div><div class="metric">总能耗</div><div class="value">${fmtKwh(resultA.totalKwh)}</div><div class="metric">kWh</div></div>
          <div><div class="metric">总电费</div><div class="value">${fmtMoney(resultA.totalCost)}</div><div class="metric">元</div></div>
          <div><div class="metric">总亮灯率</div><div class="value">${fmtPct(resultA.lightingRate)}</div><div class="metric">加权口径</div></div>
        </div>
      </div>
      <div class="total-box scheme-b">
        <h3>方案 B 总计</h3>
        <div class="total-grid">
          <div><div class="metric">总能耗</div><div class="value">${fmtKwh(resultB.totalKwh)}</div><div class="metric">kWh</div></div>
          <div><div class="metric">总电费</div><div class="value">${fmtMoney(resultB.totalCost)}</div><div class="metric">元</div></div>
          <div><div class="metric">总亮灯率</div><div class="value">${fmtPct(resultB.lightingRate)}</div><div class="metric">加权口径</div></div>
        </div>
      </div>
    `;

    const mapA = new Map(resultA.circuits.map((c) => [c.circuitId, c]));
    const mapB = new Map(resultB.circuits.map((c) => [c.circuitId, c]));
    const rows = state.data.circuits.map((c) => {
      const a = mapA.get(c.id);
      const b = mapB.get(c.id);
      return {
        circuit: c,
        a,
        b,
        deltaCost: b.cost - a.cost,
        deltaKwh: b.kwh - a.kwh,
      };
    }).sort((x, y) => Math.abs(y.deltaCost) - Math.abs(x.deltaCost));

    const curveLabel = (id) => id ? `${id} ${curveById(id).name}` : '<span class="muted">未配置</span>';

    document.getElementById('compareTableWrap').innerHTML = `
      <table>
        <thead>
          <tr>
            <th>排名 / 回路</th>
            <th>灯数</th>
            <th class="col-a">A 曲线</th>
            <th class="col-a">A 能耗 kWh</th>
            <th class="col-a">A 电费 元</th>
            <th class="col-a">A 亮灯率</th>
            <th class="col-b">B 曲线</th>
            <th class="col-b">B 能耗 kWh</th>
            <th class="col-b">B 电费 元</th>
            <th class="col-b">B 亮灯率</th>
            <th>B−A 电费 元</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr data-circuit="${r.circuit.id}" style="cursor:pointer;${
              state.selectedCircuit === r.circuit.id ? 'background:#eef5ff;' : ''
            }">
              <td><span class="diff-badge">${i + 1}</span>${r.circuit.id} ${r.circuit.name}</td>
              <td>${r.a.lampCount}</td>
              <td class="col-a">${curveLabel(r.a.curveId)}</td>
              <td class="col-a">${fmtKwh(r.a.kwh)}</td>
              <td class="col-a">${fmtMoney(r.a.cost)}</td>
              <td class="col-a">${rateCell(r.a.lightingRate)}</td>
              <td class="col-b">${curveLabel(r.b.curveId)}</td>
              <td class="col-b">${fmtKwh(r.b.kwh)}</td>
              <td class="col-b">${fmtMoney(r.b.cost)}</td>
              <td class="col-b">${rateCell(r.b.lightingRate)}</td>
              <td class="${r.deltaCost < 0 ? 'delta-neg' : r.deltaCost > 0 ? 'delta-pos' : ''}">
                ${r.deltaCost === 0 ? '0.00' : fmtSignedMoney(r.deltaCost)}
              </td>
            </tr>
          `).join('')}
        </tbody>
        <tfoot>
          <tr style="font-weight:700;background:#f0f5fa">
            <td>合计</td>
            <td>${state.data.lamps.length}</td>
            <td></td>
            <td class="col-a">${fmtKwh(resultA.totalKwh)}</td>
            <td class="col-a">${fmtMoney(resultA.totalCost)}</td>
            <td class="col-a">${rateCell(resultA.lightingRate)}</td>
            <td></td>
            <td class="col-b">${fmtKwh(resultB.totalKwh)}</td>
            <td class="col-b">${fmtMoney(resultB.totalCost)}</td>
            <td class="col-b">${rateCell(resultB.lightingRate)}</td>
            <td class="${resultB.totalCost - resultA.totalCost < 0 ? 'delta-neg' : 'delta-pos'}">
              ${fmtSignedMoney(resultB.totalCost - resultA.totalCost)}
            </td>
          </tr>
        </tfoot>
      </table>
    `;

    document.querySelectorAll('#compareTableWrap tbody tr[data-circuit]').forEach((tr) => {
      tr.addEventListener('click', () => selectCircuit(tr.dataset.circuit));
    });
  }

  init();
})();
