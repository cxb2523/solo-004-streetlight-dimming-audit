#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const core = require('../web/core.js');

const root = path.join(__dirname, '..');
const lampsDoc = JSON.parse(fs.readFileSync(path.join(root, 'data/lamps.json'), 'utf8'));
const curvesDoc = JSON.parse(fs.readFileSync(path.join(root, 'data/curves.json'), 'utf8'));
const data = { ...curvesDoc, ...lampsDoc };
const price = lampsDoc.pricePerKwh;

let failures = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-9;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (期望 ${expected})`}`);
  if (!ok) failures++;
}

// 1) 月历：2026 不是闰年，各月天数正确
check('2026/2 天数', core.daysInMonth(2026, 2), 28);
check('2024/2 天数(闰年)', core.daysInMonth(2024, 2), 29);
check('2026/1 天数', core.daysInMonth(2026, 1), 31);
check('2026/4 天数', core.daysInMonth(2026, 4), 30);

const chunks = core.monthChunks('2026-01-01', '2026-12-31');
check('月块数', chunks.length, 12);
check('全年天数合计', chunks.reduce((s, c) => s + c.days, 0), 365);

// 2) 投运日 2026-07-01 到年底 = 7~12 月
const daysH2 = core.activeDays('2026-07-01', '2026-01-01', '2026-12-31');
check('7/1 投运生效天数', daysH2, 31 + 31 + 30 + 31 + 30 + 31);
check('3/1 投运生效天数', core.activeDays('2026-03-01', '2026-01-01', '2026-12-31'),
  365 - (31 + 28));
check('2027 年投运生效 0 天', core.activeDays('2027-02-01', '2026-01-01', '2026-12-31'), 0);

// 3) 曲线每日加权分钟（线性折算，分钟分辨率）
const byId = Object.fromEntries(data.curves.map((c) => [c.id, c]));
// K1: 270min*100 + 420min*70
check('K1 加权分钟', core.dailyStats(byId.K1).weightedMinutes, 270 * 100 + 420 * 70);
// K2: 210*100 + 480*60
check('K2 加权分钟', core.dailyStats(byId.K2).weightedMinutes, 210 * 100 + 480 * 60);
// K4: 18:00~06:30 共 750 分钟；加权 120*90+150*70+390*35+90*75
check('K4 加权分钟', core.dailyStats(byId.K4).weightedMinutes,
  120 * 90 + 150 * 70 + 390 * 35 + 90 * 75);
check('K4 点亮分钟', core.dailyStats(byId.K4).litMinutes, 750);

// 4) 单灯手算：0.1kW、K2、365 天
//    日加权小时 = 49800/100/60 = 8.3；年 kWh = 0.1*8.3*365 = 302.95
const k2 = core.dailyStats(byId.K2);
const handKwh = 0.1 * k2.weightedHours * 365;
check('0.1kW/K2/365天 kWh', handKwh, 302.95);
check('对应电费(0.62)', handKwh * price, 302.95 * 0.62);

// 5) 方案总额 = 全部灯行求和；换曲线后差额与手算一致
const base = core.baselineMapping(data, '2026-07-01');
const s1 = core.computeScheme(data, base, '2026-01-01', '2026-12-31', price);
const sumFromLamps = s1.lamps.reduce((s, r) => s + r.kwh, 0);
check('总额=灯行之和', s1.totalKwh, sumFromLamps);
check('回路数', s1.circuits.length, 12);

// 挑 C1（基准 K2），改成 K5 后：
// 差额只来自 C1 的灯、且只来自 365 天生效的灯
const alt = { ...base, C1: 'K5' };
const s2 = core.computeScheme(data, alt, '2026-01-01', '2026-12-31', price);
const c1Base = s1.circuits.find((c) => c.circuitId === 'C1');
const c1Alt = s2.circuits.find((c) => c.circuitId === 'C1');
const k5 = core.dailyStats(byId.K5);
let manualDelta = 0;
for (const lamp of data.lamps.filter((l) => l.circuitId === 'C1')) {
  const days = core.activeDays(lamp.commissionDate, '2026-01-01', '2026-12-31');
  manualDelta += lamp.powerKw * (k5.weightedHours - k2.weightedHours) * days;
}
check('C1 改档后回路差额', c1Alt.kwh - c1Base.kwh, manualDelta);
check('总差额=C1差额', s2.totalKwh - s1.totalKwh, manualDelta);

// 6) 亮灯率 = 加权分钟 / (点亮分钟*100)（K5: (150*85+450*20+90*60)/690/100）
check('K5 亮灯率', k5.weightedMinutes / k5.litMinutes / 100,
  (150 * 85 + 450 * 20 + 90 * 60) / 690 / 100);

// 7) 审计
const issues = core.audit(data);
check('审计问题总数', issues.length, 6);
check('几何异常数', issues.filter((i) => i.type === 'geometry').length, 5);
check('生效重叠数', issues.filter((i) => i.type === 'assignment-overlap').length, 1);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
