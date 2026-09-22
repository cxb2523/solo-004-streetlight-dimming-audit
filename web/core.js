/*
 * 路灯能耗审计核心计算（无 DOM 依赖，浏览器与 Node 均可直接引入）。
 * 折算方式：亮度百分比线性折算（dimmingFactor = 亮度% / 100），
 * 即 50% 亮度按 50% 功率计电，不做光通量补偿；页面与本文件均以此为准。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LampCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTES_PER_DAY = 1440;

  function daysInMonth(year, month1) {
    return new Date(Date.UTC(year, month1, 0)).getUTCDate();
  }

  // ISO 日期(YYYY-MM-DD) -> UTC 绝对日序号
  function toDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) throw new Error('日期格式应为 YYYY-MM-DD：' + iso);
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
      throw new Error('非法日期：' + iso);
    }
    return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
  }

  function hhmmToMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) throw new Error('时间格式应为 HH:MM：' + t);
    const h = +m[1];
    const mi = +m[2];
    if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) {
      throw new Error('非法时间：' + t);
    }
    return h * 60 + mi;
  }

  // 曲线时段展开为 [0,1440) 上的区间；跨 0 点时段会被拆成两段。
  function expandSegments(segments) {
    const out = [];
    for (const seg of segments) {
      const start = hhmmToMin(seg.start);
      const end = hhmmToMin(seg.end);
      if (start === end) continue;
      const level = +seg.level;
      if (!(level >= 0 && level <= 100)) {
        throw new Error('亮度必须在 0~100 之间：' + JSON.stringify(seg));
      }
      if (end > start) {
        out.push({ start, end, level });
      } else {
        out.push({ start, end: MINUTES_PER_DAY, level });
        out.push({ start: 0, end, level });
      }
    }
    return out;
  }

  // 一条曲线一天的加权分钟、点亮分钟，并返回重叠区间对。
  function dailyStats(curve) {
    const expanded = expandSegments(curve.segments || []);
    const overlaps = [];
    for (let i = 0; i < expanded.length; i++) {
      for (let j = i + 1; j < expanded.length; j++) {
        const a = expanded[i];
        const b = expanded[j];
        if (a.start < b.end && b.start < a.end) {
          overlaps.push([curve.segments[i], curve.segments[j]]);
        }
      }
    }
    const weighted = new Array(MINUTES_PER_DAY).fill(0);
    const covered = new Array(MINUTES_PER_DAY).fill(0);
    for (const iv of expanded) {
      for (let minute = iv.start; minute < iv.end; minute++) {
        weighted[minute] = Math.max(weighted[minute], iv.level);
        covered[minute] = 1;
      }
    }
    let weightedMinutes = 0;
    let litMinutes = 0;
    for (let minute = 0; minute < MINUTES_PER_DAY; minute++) {
      weightedMinutes += weighted[minute];
      if (covered[minute]) litMinutes++;
    }
    return {
      weightedMinutes,
      litMinutes,
      weightedHours: weightedMinutes / 100 / 60,
      litHours: litMinutes / 60,
      segmentOverlaps: overlaps,
    };
  }

  // 自然日包含法：[from,to] 两端都算一天。
  function inclusiveDays(fromIso, toIso) {
    return toDay(toIso) - toDay(fromIso) + 1;
  }

  // 投运日起在分析区间内的实际生效天数（按自然月，绝不用 30 天一口价）。
  function activeDays(commissionIso, startIso, endIso) {
    const commission = toDay(commissionIso);
    const start = toDay(startIso);
    const end = toDay(endIso);
    const lo = Math.max(commission, start);
    return lo > end ? 0 : end - lo + 1;
  }

  // 分析区间按自然月切块（用于页面核对每月天数与逐月能耗）。
  function monthChunks(startIso, endIso) {
    const startDay = toDay(startIso);
    const endDay = toDay(endIso);
    if (startDay > endDay) throw new Error('分析开始日晚于结束日');
    const startDate = new Date(startDay * 86400000);
    const chunks = [];
    let year = startDate.getUTCFullYear();
    let month = startDate.getUTCMonth();
    while (Date.UTC(year, month, 1) <= endDay * 86400000) {
      const mm = String(month + 1).padStart(2, '0');
      const first = toDay(`${year}-${mm}-01`);
      const lastNum = daysInMonth(year, month + 1);
      const last = toDay(`${year}-${mm}-${String(lastNum).padStart(2, '0')}`);
      const lo = Math.max(startDay, first);
      const hi = Math.min(endDay, last);
      if (lo <= hi) chunks.push({ year, month: month + 1, days: hi - lo + 1 });
      month++;
      if (month === 12) {
        month = 0;
        year++;
      }
    }
    return chunks;
  }

  // 射线法判断点是否在多边形内（闭合与否均可）。
  function pointInPolygon(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-15) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function indexById(list, kind) {
    const map = new Map();
    for (const item of list || []) {
      if (map.has(item.id)) throw new Error(`${kind} id 重复：${item.id}`);
      map.set(item.id, item);
    }
    return map;
  }

  /*
   * 数据审计：
   * 1) 同一曲线的时段互相重叠；
   * 2) assignments 引用不存在的回路/曲线；
   * 3) 同一回路同一时刻有两条生效曲线（日期区间重叠）；
   * 4) 一盏灯的坐标落入 0 个或 >=2 个回路区域（含与所属回路不一致）。
   */
  function audit(data) {
    const issues = [];
    const curves = indexById(data.curves, '曲线');
    const circuits = indexById(data.circuits, '回路');

    for (const curve of data.curves || []) {
      let stats;
      try {
        stats = dailyStats(curve);
      } catch (err) {
        issues.push({ level: 'error', type: 'curve-error', curveId: curve.id, message: err.message });
        continue;
      }
      for (const pair of stats.segmentOverlaps) {
        issues.push({
          level: 'error',
          type: 'segment-overlap',
          curveId: curve.id,
          message: `曲线 ${curve.id}（${curve.name}）时段重叠：${pair[0].start}-${pair[0].end} 与 ${pair[1].start}-${pair[1].end}`,
        });
      }
    }

    const byCircuit = new Map();
    for (const assignment of data.assignments || []) {
      if (!circuits.has(assignment.circuitId)) {
        issues.push({
          level: 'error',
          type: 'bad-ref',
          message: `生效记录引用了不存在的回路：${assignment.circuitId}`,
        });
        continue;
      }
      if (!curves.has(assignment.curveId)) {
        issues.push({
          level: 'error',
          type: 'bad-ref',
          message: `回路 ${assignment.circuitId} 的生效记录引用了不存在的曲线：${assignment.curveId}`,
        });
        continue;
      }
      if (!byCircuit.has(assignment.circuitId)) byCircuit.set(assignment.circuitId, []);
      byCircuit.get(assignment.circuitId).push(assignment);
    }

    for (const [circuitId, list] of byCircuit) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (toDay(a.start) <= toDay(b.end) && toDay(b.start) <= toDay(a.end)) {
            issues.push({
              level: 'error',
              type: 'assignment-overlap',
              circuitId,
              message: `回路 ${circuitId} 同一时刻有两条生效曲线：${a.curveId}（${a.start}~${a.end}）与 ${b.curveId}（${b.start}~${b.end}）`,
            });
          }
        }
      }
    }

    for (const lamp of data.lamps || []) {
      const hits = (data.circuits || [])
        .filter((c) => pointInPolygon(lamp.lng, lamp.lat, c.polygon))
        .map((c) => c.id);
      if (hits.length === 0) {
        issues.push({
          level: 'warn',
          type: 'geometry',
          lampId: lamp.id,
          message: `灯具 ${lamp.id} 坐标不落在任何回路区域内（台账所属：${lamp.circuitId}）`,
        });
      } else if (hits.length > 1) {
        issues.push({
          level: 'warn',
          type: 'geometry',
          lampId: lamp.id,
          message: `灯具 ${lamp.id} 坐标同时落在 ${hits.length} 条回路上：${hits.join('、')}（台账所属：${lamp.circuitId}）`,
        });
      } else if (hits[0] !== lamp.circuitId) {
        issues.push({
          level: 'warn',
          type: 'geometry',
          lampId: lamp.id,
          message: `灯具 ${lamp.id} 台账所属 ${lamp.circuitId}，但坐标实际位于回路 ${hits[0]}`,
        });
      }
    }
    return issues;
  }

  /*
   * 基准方案：每回路取“开始日最晚”的生效曲线。
   * 这是同一时刻存在多条生效曲线（审计报错）时的确定性取数口径，页面写明。
   * 无任何生效记录的回路为 null（按不亮灯处理）。
   */
  function baselineMapping(data, refIso) {
    const ref = toDay(refIso);
    const mapping = {};
    for (const circuit of data.circuits || []) {
      const active = (data.assignments || [])
        .filter((a) => a.circuitId === circuit.id && toDay(a.start) <= ref && ref <= toDay(a.end))
        .sort((a, b) => toDay(b.start) - toDay(a.start) || a.curveId.localeCompare(b.curveId));
      mapping[circuit.id] = active.length ? active[0].curveId : null;
    }
    return mapping;
  }

  /*
   * 计算一套方案在分析区间内的能耗。
   * mapping: { circuitId: curveId | null }
   * 亮灯率 = 亮度加权点亮分钟 / 计划点亮分钟（按亮度全天加权，页面写明）。
   */
  function computeScheme(data, mapping, startIso, endIso, price) {
    const dailyByCurve = new Map();
    for (const curve of data.curves || []) {
      dailyByCurve.set(curve.id, dailyStats(curve));
    }

    const circuitAgg = new Map();
    for (const circuit of data.circuits || []) {
      circuitAgg.set(circuit.id, {
        circuitId: circuit.id,
        circuitName: circuit.name,
        kwh: 0,
        weightedMinutes: 0,
        plannedMinutes: 0,
        lampCount: 0,
        curveId: mapping[circuit.id] ?? null,
      });
    }

    const lampRows = [];
    for (const lamp of data.lamps || []) {
      const days = activeDays(lamp.commissionDate, startIso, endIso);
      const curveId = mapping[lamp.circuitId] ?? null;
      const stats = curveId ? dailyByCurve.get(curveId) : null;
      const weightedHoursPerDay = stats ? stats.weightedHours : 0;
      const litMinutesPerDay = stats ? stats.litMinutes : 0;
      const kwh = lamp.powerKw * weightedHoursPerDay * days;
      const weightedMinutes = stats ? stats.weightedMinutes * days : 0;
      const plannedMinutes = litMinutesPerDay * days;
      lampRows.push({
        lampId: lamp.id,
        circuitId: lamp.circuitId,
        curveId,
        days,
        powerKw: lamp.powerKw,
        weightedHoursPerDay,
        litHoursPerDay: stats ? stats.litHours : 0,
        weightedMinutes,
        plannedMinutes,
        kwh,
      });

      const agg = circuitAgg.get(lamp.circuitId);
      if (agg) {
        agg.kwh += kwh;
        agg.weightedMinutes += weightedMinutes;
        agg.plannedMinutes += plannedMinutes;
        agg.lampCount++;
      }
    }

    const circuits = [];
    let totalKwh = 0;
    let totalWeightedMinutes = 0;
    let totalPlannedMinutes = 0;
    for (const agg of circuitAgg.values()) {
      totalKwh += agg.kwh;
      totalWeightedMinutes += agg.weightedMinutes;
      totalPlannedMinutes += agg.plannedMinutes;
      circuits.push({
        circuitId: agg.circuitId,
        circuitName: agg.circuitName,
        lampCount: agg.lampCount,
        curveId: agg.curveId,
        kwh: agg.kwh,
        cost: agg.kwh * price,
        lightingRate: agg.plannedMinutes > 0 ? agg.weightedMinutes / (agg.plannedMinutes * 100) : null,
      });
    }
    circuits.sort((a, b) => b.kwh - a.kwh);

    return {
      totalKwh,
      totalCost: totalKwh * price,
      lightingRate: totalPlannedMinutes > 0 ? totalWeightedMinutes / (totalPlannedMinutes * 100) : null,
      circuits,
      lamps: lampRows,
    };
  }

  return {
    MINUTES_PER_DAY,
    daysInMonth,
    toDay,
    inclusiveDays,
    activeDays,
    monthChunks,
    expandSegments,
    dailyStats,
    pointInPolygon,
    audit,
    baselineMapping,
    computeScheme,
  };
});
