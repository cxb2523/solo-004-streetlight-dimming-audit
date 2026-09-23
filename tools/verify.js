#!/usr/bin/env node
// Headless acceptance checks: node tools/verify.js
const path = require('path');
const fs = require('fs');
const api = require(path.join(__dirname, '..', 'app.js'));

const lampsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'lamps.json'), 'utf8'));
const curvesData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'curves.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}
function approx(name, actual, expected, eps = 1e-6) {
  const ok = Math.abs(actual - expected) <= eps;
  if (ok) {
    pass++;
    console.log(`PASS  ${name} (=${actual})`);
  } else {
    fail++;
    console.log(`FAIL  ${name}\n      expected ~${expected}\n      actual   ${actual}`);
  }
}

// ---- curve weights (linear model) ----
const std = curvesData.curves.find((c) => c.id === 'STD');
const eco = curvesData.curves.find((c) => c.id === 'ECO');
const deep = curvesData.curves.find((c) => c.id === 'DEEP');
const boost = curvesData.curves.find((c) => c.id === 'BOOST');
approx('STD 等效满功率 9.0 h', api.weightedFullPowerHours(std), 9.0);
approx('ECO 等效满功率 7.5 h', api.weightedFullPowerHours(eco), 7.5);
approx('DEEP 等效满功率 6.3 h', api.weightedFullPowerHours(deep), 6.3);
approx('BOOST 等效满功率 10.2 h', api.weightedFullPowerHours(boost), 10.2);
approx('计划亮灯 12 h/天', api.plannedHoursPerDay(curvesData), 12);

// ---- calendar day counts ----
check('窗口含首尾 60 天', api.inclusiveDays(api.parseDate('2025-01-15'), api.parseDate('2025-03-15')), 60);
check('2025-02 平月 28 天', api.inclusiveDays(api.parseDate('2025-02-01'), api.parseDate('2025-02-28')), 28);
check('2024-02 闰年 29 天', api.inclusiveDays(api.parseDate('2024-02-01'), api.parseDate('2024-02-29')), 29);
check('大月 31 天', api.inclusiveDays(api.parseDate('2025-01-01'), api.parseDate('2025-01-31')), 31);
check('小月 30 天', api.inclusiveDays(api.parseDate('2025-04-01'), api.parseDate('2025-04-30')), 30);

// ---- audits on default window ----
api.loadForTest(lampsData, curvesData, '2025-01-15', '2025-03-15');
const audits = api.runAudits();
const curveOverlaps = audits.filter((a) => a.type === 'curve-overlap');
check('曲线重叠报 1 条（L10）', curveOverlaps.map((a) => a.circuitId), ['L10']);
check(
  'L10 重叠期为 02-01~02-15 共 15 天',
  curveOverlaps[0].detail.includes('2025-02-01 ~ 2025-02-15 同时生效（共 15 天'),
  true
);
const multi = audits.filter((a) => a.type === 'lamp-multi').map((a) => a.lampId);
const mismatch = audits.filter((a) => a.type === 'lamp-mismatch').map((a) => a.lampId);
const outside = audits.filter((a) => a.type === 'lamp-outside').map((a) => a.lampId);
check('落两条回路 1 盏 (SL-0099)', multi, ['SL-0099']);
check('台账不符 3 盏', mismatch.sort(), ['SL-0096', 'SL-0097', 'SL-0098']);
check('回路外 1 盏 (SL-0100)', outside, ['SL-0100']);

// ---- scheme A: ledger ----
const state = api.state;
state.schemeA = { mode: 'ledger', fixedCurveId: 'STD', overrides: new Map() };
state.schemeB = { mode: 'fixed', fixedCurveId: 'ECO', overrides: new Map() };
const resA = api.computeScheme(state.schemeA);
const resB = api.computeScheme(state.schemeB);

// curveUsage 单位为“灯·日”（该回路所有在运灯按此曲线计的天数之和）
const l05A = resA.circuits.find((c) => c.circuitId === 'L05');
check('L05 台账：STD 355 灯·日（8灯×45天，SL-0040 少5天）', l05A.curveUsage.find((u) => u.curveId === 'STD').days, 355);
check('L05 台账：ECO 120 灯·日（8灯×15天）', l05A.curveUsage.find((u) => u.curveId === 'ECO').days, 120);

// L10 overlap: 15 days ECO (latest startDate wins), 45 days STD
const l10A = resA.circuits.find((c) => c.circuitId === 'L10');
check('L10 重叠兜底：ECO 120 灯·日（8灯×15天）', l10A.curveUsage.find((u) => u.curveId === 'ECO').days, 120);
check('L10 重叠兜底：STD 360 灯·日（8灯×45天）', l10A.curveUsage.find((u) => u.curveId === 'STD').days, 360);

// ---- hand-computed lamp: SL-0080 (commissioned 2024-12-01 -> all 60 days), scheme B fixed ECO ----
const lamp80 = lampsData.lamps.find((l) => l.id === 'SL-0080');
const lb80 = resB.lamps.find((l) => l.id === 'SL-0080');
const expect80 = (lamp80.powerW / 1000) * 7.5 * 60;
check('SL-0080 在运 60 天', lb80.activeDays, 60);
approx('SL-0080 方案B 能耗手算一致', lb80.kwh, expect80);
approx('SL-0080 电费 = 能耗×0.62', lb80.cost, expect80 * 0.62);
approx('SL-0080 亮灯率 100%（全亮 12h）', lb80.litRate, 1);

// ---- lamp commissioned inside window: SL-0020 on 2025-03-01 -> 15 days ----
const lb20 = resB.lamps.find((l) => l.id === 'SL-0020');
check('SL-0020 在运 15 天（含投运首日）', lb20.activeDays, 15);
const lamp20 = lampsData.lamps.find((l) => l.id === 'SL-0005');
const lb5 = resB.lamps.find((l) => l.id === 'SL-0005');
// 2025-02-10 .. 2025-03-15 inclusive: Feb 19 days + Mar 15 = 34
check('SL-0005 在运 34 天（2/10 起含首日）', lb5.activeDays, 34);

// ---- monthly breakdown keys for SL-0005 ----
check('SL-0005 月份键', [...lb5.byMonth.keys()], ['2025-02', '2025-03']);
check('SL-0005 2 月 19 灯日', lb5.byMonth.get('2025-02').lampDays, 19);
check('SL-0005 3 月 15 灯日', lb5.byMonth.get('2025-03').lampDays, 15);

// ---- totals: sum of circuits ----
approx('A 合计 = 各回路之和', resA.total.kwh, resA.circuits.reduce((s, c) => s + c.kwh, 0), 1e-7);
approx('B 合计 = 各回路之和', resB.total.kwh, resB.circuits.reduce((s, c) => s + c.kwh, 0), 1e-7);
approx('A 电费 = 能耗×0.62', resA.total.cost, resA.total.kwh * 0.62, 1e-7);

// ---- acceptance: change one circuit's curve -> totals move, per-circuit moves ----
const beforeL01B = resB.circuits.find((c) => c.circuitId === 'L01').kwh;
state.schemeB.overrides.set('L01', 'DEEP');
const resB2 = api.computeScheme(state.schemeB);
const afterL01B = resB2.circuits.find((c) => c.circuitId === 'L01').kwh;
const afterL02B = resB2.circuits.find((c) => c.circuitId === 'L02').kwh;
const l01 = lampsData.lamps.filter((l) => l.circuitId === 'L01');
void l01;
// exact check: L01 energy with DEEP vs ECO scales 6.3/7.5 (all L01 lamps predate window)
approx('L01 改 DEEP 后能耗按 6.3/7.5 缩放', afterL01B, beforeL01B * (6.3 / 7.5), 1e-7);
approx('L02 不受影响', afterL02B, resB.circuits.find((c) => c.circuitId === 'L02').kwh, 1e-9);

// ---- February-only window: 28 days flat ----
api.loadForTest(lampsData, curvesData, '2025-02-01', '2025-02-28');
const resFeb = api.computeScheme({ mode: 'fixed', fixedCurveId: 'STD', overrides: new Map() });
const lamp80f = lampsData.lamps.find((l) => l.id === 'SL-0080');
const got80f = resFeb.lamps.find((l) => l.id === 'SL-0080');
approx('整窗 2 月：SL-0080 按 28 天', got80f.kwh, (lamp80f.powerW / 1000) * 9.0 * 28);

// leap-year February: pick a lamp commissioned before 2024-02
api.loadForTest(lampsData, curvesData, '2024-02-01', '2024-02-29');
const resLeap = api.computeScheme({ mode: 'fixed', fixedCurveId: 'STD', overrides: new Map() });
const earlyLamp = lampsData.lamps.find((l) => l.commissionDate <= '2024-01-31');
const gotLeap = resLeap.lamps.find((l) => l.id === earlyLamp.id);
approx(`闰年 2 月：${earlyLamp.id} 按 29 天`, gotLeap.kwh, (earlyLamp.powerW / 1000) * 9.0 * 29);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
