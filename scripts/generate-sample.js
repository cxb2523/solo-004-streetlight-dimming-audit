#!/usr/bin/env node
/*
 * 生成样例数据 data/lamps.json 与 data/curves.json（确定性随机，可重复执行）。
 * 坐标系：模拟经纬度（东经 120.10~120.22，北纬 30.25~30.34），
 * 12 条回路按 4 列 x 3 行排布，C4/C8 边界故意侵入相邻回路制造“落两条回路”的灯。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../web/core.js');

const OUT_DIR = path.join(__dirname, '..', 'data');
const PRICE = 0.62;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260922);

const COLS = 4;
const ROWS = 3;
const X0 = 120.10;
const Y0 = 30.25;
const CW = 0.030;
const RH = 0.030;
const GAP = 0.0004;

function ringFor(index) {
  const col = (index - 1) % COLS;
  const row = Math.floor((index - 1) / COLS);
  let xMax = X0 + (col + 1) * CW - GAP;
  const xMin = X0 + col * CW + GAP;
  const yMin = Y0 + (ROWS - 1 - row) * RH + GAP;
  const yMax = Y0 + (ROWS - row) * RH - GAP;
  // C3、C7 向右扩张侵入相邻的 C4、C8 约 0.0035 度，形成重叠带
  if (index === 3 || index === 7) xMax += 0.0035;
  const j = 0.00025;
  const jitter = () => +(rand() * 2 * j - j).toFixed(6);
  return [
    [+xMin.toFixed(6), +yMin.toFixed(6)],
    [+xMax.toFixed(6), +(yMin + jitter()).toFixed(6)],
    [+(xMax + jitter()).toFixed(6), +(yMax + jitter()).toFixed(6)],
    [+(xMin + jitter()).toFixed(6), +(yMax + jitter()).toFixed(6)],
  ].map((p) => [+p[0], +p[1]]);
}

const circuitNames = [
  '滨河东路一段', '滨河东路二段', '人民西路', '解放大道北段',
  '解放大道南段', '中山路北段', '中山路南段', '建设西路',
  '建设东路', '公园环路', '经开大道', '站前路',
];

const circuits = Array.from({ length: 12 }, (_, i) => ({
  id: `C${i + 1}`,
  name: circuitNames[i],
  polygon: ringFor(i + 1),
}));

// 五档调光曲线（可套用于任意回路）
const curves = [
  {
    id: 'K1',
    name: '整夜全亮',
    segments: [
      { start: '18:30', end: '23:00', level: 100 },
      { start: '23:00', end: '06:00', level: 70 },
    ],
  },
  {
    id: 'K2',
    name: '半夜节能',
    segments: [
      { start: '18:30', end: '22:00', level: 100 },
      { start: '22:00', end: '06:00', level: 60 },
    ],
  },
  {
    id: 'K3',
    name: '深夜深度节能',
    segments: [
      { start: '18:30', end: '21:30', level: 100 },
      { start: '21:30', end: '05:30', level: 40 },
      { start: '05:30', end: '06:00', level: 80 },
    ],
  },
  {
    id: 'K4',
    name: '智慧分时段',
    segments: [
      { start: '18:00', end: '20:00', level: 90 },
      { start: '20:00', end: '22:30', level: 70 },
      { start: '22:30', end: '05:00', level: 35 },
      { start: '05:00', end: '06:30', level: 75 },
    ],
  },
  {
    id: 'K5',
    name: '人少即灭（激进节能）',
    segments: [
      { start: '18:30', end: '21:00', level: 85 },
      { start: '21:00', end: '04:30', level: 20 },
      { start: '04:30', end: '06:00', level: 60 },
    ],
  },
];

// 2026 全年生效；C4 额外叠一条 6~8 月的曲线，制造“同一时刻两条生效”审计项
const planCurve = ['K2', 'K1', 'K2', 'K3', 'K1', 'K2', 'K3', 'K2', 'K4', 'K4', 'K4', 'K3'];
const assignments = circuits.map((c, i) => ({
  circuitId: c.id,
  curveId: planCurve[i],
  start: '2026-01-01',
  end: '2026-12-31',
}));
assignments.push({ circuitId: 'C4', curveId: 'K5', start: '2026-06-01', end: '2026-08-31' });

// 每回路“正常灯”数量（合计 95，另有 5 盏异常灯）
const counts = [9, 8, 7, 8, 9, 8, 7, 8, 8, 8, 8, 7];

const sourceTable = [
  ['LED', [0.08, 0.12, 0.15, 0.20]],
  ['高压钠灯', [0.15, 0.25, 0.40]],
];

function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// 在回路外接盒内随机一点
function normalPoint(circuitIndex) {
  const ring = circuits[circuitIndex].polygon;
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs) + 0.0012;
  const maxX = Math.max(...xs) - 0.0012;
  const minY = Math.min(...ys) + 0.0012;
  const maxY = Math.max(...ys) - 0.0012;
  return { lng: minX + rand() * (maxX - minX), lat: minY + rand() * (maxY - minY) };
}

// 恰好落在本回路、且不触发任何几何异常的点
function uniquePoint(circuitId, circuitIndex) {
  for (let tries = 0; tries < 300; tries++) {
    const p = normalPoint(circuitIndex);
    const hits = circuits
      .filter((c) => core.pointInPolygon(p.lng, p.lat, c.polygon))
      .map((c) => c.id);
    if (hits.length === 1 && hits[0] === circuitId) return p;
  }
  throw new Error(`无法为 ${circuitId} 生成唯一落区点`);
}

const lamps = [];

for (let ci = 0; ci < 12; ci++) {
  const [sourceType, powers] = sourceTable[ci % 2];
  for (let n = 0; n < counts[ci]; n++) {
    const p = uniquePoint(circuits[ci].id, ci);
    lamps.push({
      circuitId: circuits[ci].id,
      lng: +p.lng.toFixed(6),
      lat: +p.lat.toFixed(6),
      powerKw: pick(powers),
      sourceType,
      commissionDate: '',
      anomalous: false,
    });
  }
}

// 落在 C3/C4（上排）、C7/C8（中排）重叠带里的点
function overlapPoint(targetA, targetB, yMin, yMax) {
  for (let tries = 0; tries < 300; tries++) {
    const p = { lng: 120.1905 + rand() * 0.0022, lat: yMin + rand() * (yMax - yMin) };
    const hits = circuits
      .filter((c) => core.pointInPolygon(p.lng, p.lat, c.polygon))
      .map((c) => c.id);
    if (hits.includes(targetA) && hits.includes(targetB)) return p;
  }
  throw new Error(`无法构造 ${targetA}/${targetB} 重叠点`);
}

const pA = overlapPoint('C3', 'C4', 30.312, 30.338);
const pB = overlapPoint('C7', 'C8', 30.282, 30.308);

// 5 盏问题灯：2 盏落在两条回路上，1 盏落空，1 盏所属与实际不符，再加 1 盏落空远灯
const anomalyLamps = [
  { circuitId: 'C4', lng: +pA.lng.toFixed(6), lat: +pA.lat.toFixed(6), powerKw: 0.15, sourceType: 'LED' },
  { circuitId: 'C8', lng: +pB.lng.toFixed(6), lat: +pB.lat.toFixed(6), powerKw: 0.25, sourceType: '高压钠灯' },
  { circuitId: 'C1', lng: 120.2240, lat: 30.2560, powerKw: 0.12, sourceType: 'LED' }, // 落在所有回路外
  { circuitId: 'C6', lng: 120.1150, lat: 30.3200, powerKw: 0.15, sourceType: 'LED' }, // 实际只在 C2 内
];

// 第二盏重叠灯同样取自重叠带，保证命中两条回路
const pA2 = overlapPoint('C3', 'C4', 30.312, 30.338);
anomalyLamps.splice(1, 0, {
  circuitId: 'C3',
  lng: +pA2.lng.toFixed(6),
  lat: +pA2.lat.toFixed(6),
  powerKw: 0.12,
  sourceType: 'LED',
});

for (const a of anomalyLamps) {
  lamps.push({ ...a, commissionDate: '', anomalous: true });
}

// 投运日期：绝大多数在 2026 年前投运；3 盏年中投运（跨月天数校验）；2 盏 2027 年（区间内不生效）
const commissionPool = [
  '2023-08-18', '2024-05-10', '2024-09-01', '2025-01-25',
  '2025-03-15', '2025-06-20', '2025-11-08',
];
for (const lamp of lamps) lamp.commissionDate = pick(commissionPool);
lamps[0].commissionDate = '2026-07-01';
lamps[20].commissionDate = '2026-03-01';
lamps[50].commissionDate = '2026-09-15';
lamps[70].commissionDate = '2027-02-01';
lamps[90].commissionDate = '2027-06-01';

// 按回路、经度排序后统一编号 L-001 ~ L-100
lamps.sort((a, b) => (
  a.circuitId === b.circuitId ? a.lng - b.lng : a.circuitId.localeCompare(b.circuitId)
));
const finalLamps = lamps.map((lamp, i) => ({
  id: `L-${String(i + 1).padStart(3, '0')}`,
  circuitId: lamp.circuitId,
  lng: lamp.lng,
  lat: lamp.lat,
  powerKw: lamp.powerKw,
  sourceType: lamp.sourceType,
  commissionDate: lamp.commissionDate,
}));

const lampsDoc = {
  schema: 'streetlight-lamps/1',
  generatedAt: '2026-09-22',
  pricePerKwh: PRICE,
  note: '坐标为模拟经纬度；坐标异常灯请以 curves.json 同批次审计结果为准。',
  lamps: finalLamps,
};

const curvesDoc = {
  schema: 'streetlight-curves/1',
  generatedAt: '2026-09-22',
  dimmingModel: 'linear',
  dimmingModelNote: '亮度百分比线性折算：功率系数=亮度%/100，不做光通量补偿。',
  defaultRange: { start: '2026-01-01', end: '2026-12-31' },
  circuits,
  curves,
  assignments,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, 'lamps.json'),
  JSON.stringify(lampsDoc, null, 2) + '\n',
  'utf8',
);
fs.writeFileSync(
  path.join(OUT_DIR, 'curves.json'),
  JSON.stringify(curvesDoc, null, 2) + '\n',
  'utf8',
);

const data = { ...curvesDoc, ...lampsDoc };
const issues = core.audit(data);
const geometryIssues = issues.filter((i) => i.type === 'geometry');
const overlapIssues = issues.filter((i) => i.type === 'assignment-overlap');

console.log(`灯数: ${finalLamps.length}，回路: ${circuits.length}，曲线: ${curves.length}`);
console.log(`几何异常: ${geometryIssues.length}，生效曲线重叠: ${overlapIssues.length}`);
for (const issue of issues) console.log(`- [${issue.level}] ${issue.message}`);
