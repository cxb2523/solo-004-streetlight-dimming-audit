#!/usr/bin/env node
// Zero-dependency generator for the sample dataset:
//   data/lamps.json   100 lamps across 12 circuits (5 planted coordinate anomalies)
//   data/curves.json  4 dimming curves + circuit assignments (1 planted overlap)
// Run: node tools/gen-sample.js
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'data');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20250924);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// 12 circuits as a 4 x 3 grid (1 deg lon ~= 95.3 km at lat 31.23)
const LON0 = 121.47;
const LAT0 = 31.23;
const DX = 0.0036;
const DY = 0.0027;

const NAMES = ['中山', '延安', '南京', '淮海', '滨江', '栖霞', '虹桥', '漕河', '莘庄', '张江', '金桥', '外高'];
const circuits = [];
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 4; c++) {
    const idx = r * 4 + c;
    const id = `L${String(idx + 1).padStart(2, '0')}`;
    const x0 = LON0 + c * DX;
    const y0 = LAT0 - r * DY;
    const j = idx * 0.00004;
    circuits.push({
      id,
      name: `${NAMES[idx]}路${idx === 0 ? '主干道' : '路段'}`,
      polygon: [
        [x0, y0],
        [x0 + DX + j * 0.3, y0 + j * 0.2],
        [x0 + DX, y0 - DY],
        [x0 + j * 0.2, y0 - DY - j * 0.25],
      ],
    });
  }
}

// L07 bulges east ~62 m into L08 -> one genuinely overlapping polygon pair
circuits[6].polygon[1][0] += 0.00065;
circuits[6].polygon[2][0] += 0.00065;

const byId = Object.fromEntries(circuits.map((c) => [c.id, c]));

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function centroid(poly) {
  return [
    poly.reduce((s, p) => s + p[0], 0) / poly.length,
    poly.reduce((s, p) => s + p[1], 0) / poly.length,
  ];
}

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

function randomPointIn(cid, marginLon = 0.00055, marginLat = 0.00045) {
  const c = byId[cid];
  const lons = c.polygon.map((p) => p[0]);
  const lats = c.polygon.map((p) => p[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  for (let t = 0; t < 200; t++) {
    const lon = minLon + marginLon + rand() * (maxLon - minLon - marginLon * 2);
    const lat = minLat + marginLat + rand() * (maxLat - minLat - marginLat * 2);
    if (pointInPolygon(lon, lat, c.polygon)) return [round6(lon), round6(lat)];
  }
  return centroid(c.polygon).map(round6);
}

const SOURCES = {
  LED: { label: 'LED', powers: [60, 80, 100, 120, 150, 180, 200] },
  HPS: { label: '高压钠灯', powers: [150, 250, 400] },
  MH: { label: '金卤灯', powers: [100, 175, 250] },
  CFL: { label: '节能灯', powers: [40, 65, 85] },
};

const counts = {
  L01: 9, L02: 8, L03: 7, L04: 8,
  L05: 8, L06: 7, L07: 8, L08: 8,
  L09: 8, L10: 8, L11: 8, L12: 8,
};
const anomalies = [
  { cid: 'L01', at: 'L12', note: '台账回路与实际位置不符（灯落在 L12 范围内）' },
  { cid: 'L01', at: 'L12', note: '台账回路与实际位置不符（灯落在 L12 范围内）' },
  { cid: 'L01', at: 'L12', note: '台账回路与实际位置不符（灯落在 L12 范围内）' },
  { cid: 'L08', at: 'OVERLAP', note: '坐标同时落在 L07 / L08 重叠带内' },
  { cid: 'L03', at: 'OUTSIDE', note: '坐标在所有回路范围之外，距台账回路约 3 km' },
];

const lamps = [];
let seq = 1;

function randomSource() {
  const r = rand();
  if (r < 0.7) return 'LED';
  if (r < 0.88) return 'HPS';
  if (r < 0.96) return 'MH';
  return 'CFL';
}

function randomCommissionDate() {
  const start = Date.UTC(2023, 0, 1);
  const end = Date.UTC(2024, 11, 15);
  const d = new Date(start + rand() * (end - start));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function makeLamp(cid, coord, source, power, commissionDate, plantedNote) {
  const lamp = {
    id: `SL-${String(seq++).padStart(4, '0')}`,
    circuitId: cid,
    lon: coord[0],
    lat: coord[1],
    powerW: power,
    lightSource: source,
    commissionDate,
  };
  if (plantedNote) lamp.plantedNote = plantedNote;
  return lamp;
}

for (const c of circuits) {
  for (let i = 0; i < counts[c.id]; i++) {
    const src = randomSource();
    lamps.push(makeLamp(c.id, randomPointIn(c.id), SOURCES[src].label, pick(SOURCES[src].powers), randomCommissionDate()));
  }
}

// lamps commissioned inside the default window 2025-01-15..2025-03-15
lamps.find((l) => l.id === 'SL-0005').commissionDate = '2025-02-10';
lamps.find((l) => l.id === 'SL-0020').commissionDate = '2025-03-01';
lamps.find((l) => l.id === 'SL-0040').commissionDate = '2025-01-20';
lamps.find((l) => l.id === 'SL-0060').commissionDate = '2025-02-28';
lamps.find((l) => l.id === 'SL-0080').commissionDate = '2024-12-01';
lamps.find((l) => l.id === 'SL-0090').commissionDate = '2025-01-15';

const l12center = centroid(byId.L12.polygon);
for (const a of anomalies) {
  let coord;
  let source = 'LED';
  let power = 100;
  let commission = '2024-06-01';
  if (a.at === 'L12') {
    coord = [round6(l12center[0] + (rand() - 0.5) * 0.0012), round6(l12center[1] + (rand() - 0.5) * 0.0009)];
  } else if (a.at === 'OVERLAP') {
    const latBand = byId.L08.polygon.map((p) => p[1]);
    coord = [121.4811, round6(Math.min(...latBand) + 0.0009)];
    commission = '2025-02-05';
  } else {
    const c3 = centroid(byId.L03.polygon);
    coord = [round6(c3[0] - 0.032), round6(c3[1] + 0.002)];
    source = 'HPS';
    power = 250;
  }
  lamps.push(makeLamp(a.cid, coord, SOURCES[source].label, power, commission, a.note));
}

const lampsPayload = {
  schemaVersion: 1,
  coordinateSystem: 'WGS84 lon/lat',
  circuits: circuits.map((c) => ({ id: c.id, name: c.name, polygon: c.polygon })),
  lamps,
};

const seg = (start, end, brightnessPct) => ({ start, end, brightnessPct });
const curvesPayload = {
  schemaVersion: 1,
  pricePerKwh: 0.62,
  scheduledOn: '18:00',
  scheduledOff: '06:00',
  brightnessModel: {
    id: 'linear',
    name: '亮度百分比线性折算',
    note: '功率 = 额定功率 × 亮度百分比（70% 亮度即按额定功率的 70% 计耗），不做光通量/视觉补偿。',
  },
  curves: [
    {
      id: 'STD',
      name: '标准曲线',
      segments: [
        seg('18:00', '21:00', 100),
        seg('21:00', '23:00', 80),
        seg('23:00', '05:00', 60),
        seg('05:00', '06:00', 80),
      ],
    },
    {
      id: 'ECO',
      name: '深夜节能曲线',
      segments: [
        seg('18:00', '21:00', 100),
        seg('21:00', '23:00', 70),
        seg('23:00', '05:00', 40),
        seg('05:00', '06:00', 70),
      ],
    },
    {
      id: 'DEEP',
      name: '深夜加强节能',
      segments: [
        seg('18:00', '21:00', 90),
        seg('21:00', '23:00', 60),
        seg('23:00', '05:00', 30),
        seg('05:00', '06:00', 60),
      ],
    },
    {
      id: 'BOOST',
      name: '高亮度保障曲线',
      segments: [
        seg('18:00', '21:00', 100),
        seg('21:00', '23:00', 90),
        seg('23:00', '05:00', 75),
        seg('05:00', '06:00', 90),
      ],
    },
  ],
  assignments: [
    { circuitId: 'L01', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L02', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L03', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L04', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    // L05: STD until 2025-02-28 then ECO from 2025-03-01 (clean hand-off)
    { circuitId: 'L05', curveId: 'STD', startDate: '2025-01-01', endDate: '2025-02-28' },
    { circuitId: 'L05', curveId: 'ECO', startDate: '2025-03-01', endDate: null },
    { circuitId: 'L06', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L07', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L08', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L09', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L10', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L11', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    { circuitId: 'L12', curveId: 'STD', startDate: '2025-01-01', endDate: null },
    // planted violation: L10 has two simultaneously effective records 2025-02-01..2025-02-15
    { circuitId: 'L10', curveId: 'ECO', startDate: '2025-02-01', endDate: '2025-02-15' },
  ],
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'lamps.json'), JSON.stringify(lampsPayload, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'curves.json'), JSON.stringify(curvesPayload, null, 2) + '\n');

console.log(`wrote ${lamps.length} lamps, ${circuits.length} circuits -> data/lamps.json`);
console.log(`wrote ${curvesPayload.curves.length} curves, ${curvesPayload.assignments.length} assignments -> data/curves.json`);
