// M2 value 模块测试 — calculator.js / adapter.js / types.js / index.js
// 纯本地：零 LLM、零网络、零 npm 依赖（只用 node:assert / node:fs / node:url）
// 金额断言全部为硬编码期望数字（手工按税率表/社保比例独立算出，非从实现抄回）。
// 运行：node tests/modules/value/test-value.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  SOCIAL_RATES,
  FUND_RATE,
  TAX_THRESHOLD,
  COMMUTE_MODES,
  computeInsurance,
  computeTax,
  computeCommute,
  buildBreakdown,
  computeValueCard,
  toValueCard,
  computeValueCardFromJob,
} from "../../../src/modules/value/index.js";
import { validateValueCard } from "../../../src/core/contracts/payloadContract.js";

let passed = 0;
let failed = 0;
function assertEqual(actual, expected, msg) {
  try {
    assert.deepEqual(actual, expected, msg);
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
function assertTrue(cond, msg) {
  assertEqual(!!cond, true, msg);
}

// ════════════════ 1. 常量与默认口径（台州经验值） ════════════════
assertEqual(SOCIAL_RATES.pension, 0.08, "养老比例默认 8%");
assertEqual(SOCIAL_RATES.medical, 0.02, "医疗比例默认 2%");
assertEqual(SOCIAL_RATES.unemployment, 0.005, "失业比例默认 0.5%");
assertEqual(FUND_RATE, 0.08, "公积金默认 8%");
assertEqual(TAX_THRESHOLD, 5000, "个税起征点默认 5000");
assertEqual(SCHEMA_VERSION, "1.0.0", "types.js 透传 L1 契约 SCHEMA_VERSION");
assertEqual(COMMUTE_MODES.metro.perKm, 0.5, "metro 每公里 0.5 元");
assertEqual(COMMUTE_MODES.metro.base, 2, "metro 起步 2 元");
assertEqual(COMMUTE_MODES.walk.perKm, 0, "walk 每公里 0 元");

// ════════════════ 2. computeInsurance ════════════════
{
  const i = computeInsurance(10000);
  assertEqual(i.base, 10000, "保险基数=月薪 10000");
  assertEqual(i.baseSource, "估算(基数=月薪)", "无显式 base 时来源=估算(基数=月薪)");
  assertEqual(i.items.pension, 800, "养老 10000×8%=800");
  assertEqual(i.items.medical, 200, "医疗 10000×2%=200");
  assertEqual(i.items.unemployment, 50, "失业 10000×0.5%=50");
  assertEqual(i.items.housing, 800, "公积金 10000×8%=800");
  assertEqual(i.total, 1850, "五险一金合计 1850");
  assertEqual(i.housing, 800, "housing 单列=800");
  assertEqual(i.fundRate, 0.08, "fundRate 回退默认 8%");
}
{
  const i = computeInsurance(30000);
  assertEqual(i.base, 24000, "30000 基数钳到上限 24000");
  assertEqual(i.baseSource, "估算(基数=月薪)→钳制", "钳制后来源标签追加→钳制");
  assertEqual(i.items.pension, 1920, "钳制后养老 24000×8%=1920");
  assertEqual(i.total, 4440, "钳制后合计 4440");
}
{
  const i = computeInsurance(3000);
  assertEqual(i.base, 4000, "3000 基数钳到下限 4000");
  assertEqual(i.baseSource, "估算(基数=月薪)→钳制", "低于下限也标钳制");
  assertEqual(i.total, 740, "下限基数合计 4000×18.5%=740");
}
{
  const i = computeInsurance("面议");
  assertEqual(i.base, 4000, "非法月薪→取基数下限 4000");
  assertEqual(i.baseSource, "估算(取基数下限)", "非法月薪来源=估算(取基数下限)");
  assertEqual(i.total, 740, "非法月薪按 4000 基数算合计 740");
}
{
  const i = computeInsurance(20000, { base: 12000, fundRate: 0.05 });
  assertEqual(i.base, 12000, "显式 base=12000（HR明说）");
  assertEqual(i.baseSource, "HR明说", "显式 base 来源=HR明说");
  assertEqual(i.fundRate, 0.05, "显式 fundRate=5%");
  assertEqual(i.items.pension, 960, "12000×8%=960");
  assertEqual(i.items.housing, 600, "12000×5%=600");
  assertEqual(i.total, 1860, "12000 基数合计 960+240+60+600=1860");
}
{
  // 非法公积金比例不能静默算成 0（到手虚高），必须回退默认档
  assertEqual(computeInsurance(10000, { fundRate: 0 }).fundRate, 0.08, "fundRate=0 回退 8%");
  assertEqual(computeInsurance(10000, { fundRate: -3 }).fundRate, 0.08, "fundRate 负数回退 8%");
  assertEqual(computeInsurance(10000, { fundRate: "abc" }).fundRate, 0.08, "fundRate 非数字回退 8%");
}

// ════════════════ 3. computeTax（月度累进，起征 5000） ════════════════
{
  const t = computeTax(8000); // taxable 3000 → 3% 档
  assertEqual(t.taxable, 3000, "8000 应纳税所得 3000");
  assertEqual(t.rate, 0.03, "3000 落在 3% 档");
  assertEqual(t.deduction, 0, "3% 档速算扣除 0");
  assertEqual(t.tax, 90, "3000×3%=90");
}
assertEqual(computeTax(8001).tax, 90.1, "8001: taxable 3001 跨入 10% 档 = 300.1-210=90.1");
assertEqual(computeTax(8001).rate, 0.1, "3001 落 10% 档");
assertEqual(computeTax(10000).tax, 290, "10000: 5000×10%-210=290");
assertEqual(computeTax(20000).tax, 1590, "20000: 15000×20%-1410=1590");
assertEqual(computeTax(30000).tax, 3590, "30000: 25000×20%-1410=3590");
assertEqual(computeTax(35000).tax, 4840, "35000: 30000×25%-2660=4840");
assertEqual(computeTax(50000).tax, 9090, "50000: 45000×30%-4410=9090");
assertEqual(computeTax(70000).tax, 15590, "70000: 65000×35%-7160=15590");
assertEqual(computeTax(100000).tax, 27590, "100000: 95000×45%-15160=27590");
{
  const t = computeTax(5000);
  assertEqual(t, { taxable: 0, rate: 0, deduction: 0, tax: 0 }, "恰起征点 → 全 0");
}
assertEqual(computeTax(4000).tax, 0, "低于起征点税 0");
assertEqual(computeTax(4000).taxable, 0, "低于起征点应纳税所得钳 0 不给负数");
assertEqual(computeTax(0).tax, 0, "0 输入税 0");
assertEqual(computeTax("面议"), { taxable: 0, rate: 0, deduction: 0, tax: 0 }, "不可解析输入不染 NaN，按不缴税");
assertEqual(computeTax(undefined).tax, 0, "undefined → 税 0");
assertEqual(Number.isNaN(computeTax(NaN).tax), false, "NaN 输入产出必须是有限数");

// ════════════════ 4. computeCommute ════════════════
{
  const c = computeCommute("metro", 10);
  assertEqual(c.perOneWay, 7, "metro 10km 单程 2+0.5×10=7");
  assertEqual(c.monthly, 308, "metro 月通勤 7×2×22=308");
  assertEqual(c.oneWayMinutes, 30, "metro 单程分钟 3×10=30");
  assertEqual(c.monthlyMinutes, 1320, "metro 月分钟 30×2×22=1320");
  assertEqual(c.workdays, 22, "默认 22 工作日");
  assertEqual(c.known, true, "metro 是已知方式");
  assertEqual(c.modeLabel, "地铁/市域铁路", "metro 中文标签");
  assertEqual(c.source, "估算(通勤方式经验价)", "已知方式来源=经验价");
}
{
  const c = computeCommute("bus", 8);
  assertEqual(c.perOneWay, 2.8, "bus 8km 单程 2+0.1×8=2.8");
  assertEqual(c.monthly, 123.2, "bus 月通勤 2.8×2×22=123.2");
  assertEqual(c.oneWayMinutes, 32, "bus 单程分钟 4×8=32");
  assertEqual(c.monthlyMinutes, 1408, "bus 月分钟 32×2×22=1408");
}
{
  const c = computeCommute("ebyke", 5);
  assertEqual(c.perOneWay, 0.6, "电动车 5km 单程 0.5+0.02×5=0.6");
  assertEqual(c.monthly, 26.4, "电动车月 0.6×2×22=26.4");
  assertEqual(c.oneWayMinutes, 17.5, "电动车分钟 3.5×5=17.5");
}
{
  const c = computeCommute("drive", 15);
  assertEqual(c.perOneWay, 9, "自驾 15km 单程 0+0.6×15=9");
  assertEqual(c.monthly, 396, "自驾月 9×2×22=396");
}
{
  const c = computeCommute("walk", 1);
  assertEqual(c.perOneWay, 0, "步行花费 0");
  assertEqual(c.monthly, 0, "步行月花费 0");
  assertEqual(c.oneWayMinutes, 12, "步行单程分钟 12×1=12");
  assertEqual(c.monthlyMinutes, 528, "步行月分钟 12×2×22=528");
}
{
  const c = computeCommute("none", 5);
  assertEqual(c.perOneWay, 0, "宿舍花费 0");
  assertEqual(c.oneWayMinutes, 0, "none 零耗时");
  assertEqual(c.monthlyMinutes, 0, "none 月分钟 0");
}
assertEqual(computeCommute("METRO", 10).perOneWay, 7, "方式大小写不敏感");
{
  const c = computeCommute("rocket", 5);
  assertEqual(c.known, false, "未识别方式 known=false");
  assertEqual(c.perOneWay, null, "未识别方式单程 null 不臆造");
  assertEqual(c.monthly, null, "未识别方式月费 null");
  assertEqual(c.modeLabel, "未知方式", "未识别方式中文标签");
  assertEqual(c.source, "待确认(未识别通勤方式)", "未识别方式来源=待确认");
}
{
  const c = computeCommute("metro", undefined);
  assertEqual(c.known, true, "方式已知但缺距离仍 known");
  assertEqual(c.perOneWay, null, "缺单程距离 → 单程 null");
  assertEqual(c.monthly, null, "缺单程距离 → 月费 null");
  assertEqual(c.source, "待确认(缺单程距离)", "缺距离来源=待确认(缺单程距离)");
}
assertEqual(computeCommute("metro", -3).monthly, null, "负距离按缺距离处理");
assertEqual(computeCommute("metro", "abc").monthly, null, "非数字距离按缺距离处理");
assertEqual(computeCommute("metro", 10, { workdays: 20 }).monthly, 280, "workdays=20 → 7×2×20=280");
assertEqual(computeCommute("metro", 10, { workdays: -1 }).workdays, 22, "非法 workdays 回退 22");

// ════════════════ 5. computeValueCard：异常输入 ════════════════
assertEqual(computeValueCard({}), { ok: false, reason: "缺有效名义月薪", grossSource: "HR明说" }, "空输入 → 失败卡");
assertEqual(computeValueCard({ grossMonthly: "面议" }).ok, false, "月薪不可解析 → 失败");
assertEqual(computeValueCard({ grossMonthly: -5000 }).ok, false, "负月薪 → 失败");
assertEqual(computeValueCard({ grossMonthly: 0 }).ok, false, "0 月薪 → 失败");
assertEqual(computeValueCard({ lowK: 0, highK: 0 }).ok, false, "0 区间 → 失败");

// ════════════════ 6. computeValueCard：单点薪资 ════════════════
{
  const c = computeValueCard({ grossMonthly: 10000 });
  assertEqual(c.ok, true, "10000 卡 ok");
  assertEqual(c.gross, 10000, "gross=10000");
  assertEqual(c.grossSource, "HR明说", "显式 grossMonthly 来源=HR明说");
  assertEqual(c.grossRange, null, "单点薪资无区间");
  assertEqual(c.netRange, null, "单点薪资到手无区间");
  assertEqual(c.insurance.total, 1850, "卡内五险一金 1850");
  assertEqual(c.tax.tax, 105, "税基 10000-1850=8150 → 3150×10%-210=105");
  assertEqual(c.net, 8045, "到手 10000-1850-105=8045");
  assertEqual(c.netWithHousing, 8845, "到手+公积金 8045+800=8845");
  assertEqual(c.disposable, 8045, "无通勤可支配=到手 8045");
  assertEqual(c.annual.monthsSalary, 12, "默认 12 薪");
  assertEqual(c.annual.annualNet, 96540, "年到手 8045×12=96540");
  assertEqual(c.distanceKm, undefined, "未传距离不下发 distanceKm");
  assertEqual(c.sources.fundRate, "估算(默认8%)", "未传 fundRate 来源=估算(默认8%)");
  assertEqual(c.sources.specialDeduct, "未计(估算偏保守)", "未传专项附加=未计");
}
{
  const c = computeValueCard({ salaryK: 8 });
  assertEqual(c.gross, 8000, "salaryK 8 → 8000 元");
  assertEqual(c.grossSource, "职位卡自报", "salaryK 来源=职位卡自报");
  assertEqual(c.insurance.total, 1480, "8000 基数五险一金 1480");
  assertEqual(c.tax.tax, 45.6, "税基 6520 → 1520×10%-210=45.6");
  assertEqual(c.net, 6474.4, "到手 8000-1480-45.6=6474.4");
  assertEqual(c.annual.annualNet, 77692.8, "年到手 6474.4×12=77692.8");
}
{
  const c = computeValueCard({ grossMonthly: 10000, monthsSalary: 13 });
  assertEqual(c.annual.monthsSalary, 13, "13 薪生效");
  assertEqual(c.annual.annualNet, 104585, "年到手 8045×13=104585");
  assertEqual(c.net, 8045, "几薪不影响月到手");
}
{
  const c = computeValueCard({ grossMonthly: 10000, specialDeduct: 1000 });
  assertEqual(c.tax.taxable, 2150, "专项附加 1000 → 税基 8150-1000=7150 → taxable 2150");
  assertEqual(c.tax.tax, 64.5, "2150×3%=64.5");
  assertEqual(c.net, 8085.5, "到手 10000-1850-64.5=8085.5");
  assertEqual(c.sources.specialDeduct, "HR明说/用户填", "专项附加来源=HR明说/用户填");
}
{
  const c = computeValueCard({ grossMonthly: 20000, socialBase: 12000, fundRate: 0.05 });
  assertEqual(c.insurance.total, 1860, "显式基数+比例组合 五险一金 1860");
  assertEqual(c.tax.tax, 1218, "税基 20000-1860=18140 → 13140×20%-1410=1218");
  assertEqual(c.net, 16922, "到手 20000-1860-1218=16922");
  assertEqual(c.sources.fundRate, "HR明说", "传了 fundRate 来源=HR明说");
}

// ════════════════ 7. computeValueCard：薪资区间 ════════════════
{
  const c = computeValueCard({ lowK: 6, highK: 10 });
  assertEqual(c.gross, 8000, "6-10K 中值 8000");
  assertEqual(c.grossSource, "职位卡自报(区间取中)", "区间中值来源标签");
  assertEqual(c.grossRange, [6000, 10000], "grossRange 两端(元)");
  assertEqual(c.netRange, [4890, 8045], "到手区间：低端 6000-1110-0=4890，高端=单点 10000 的 8045");
  assertEqual(c.disposableRange, [4890, 8045], "无通勤可支配区间=到手区间");
  assertEqual(c.insurance.total, 1480, "中值五险一金 1480");
}
{
  const c = computeValueCard({ lowK: 6, highK: 10, commuteMode: "metro", oneWayKm: 10 });
  assertEqual(c.commute.monthly, 308, "区间卡通勤 308");
  assertEqual(c.disposable, 6166.4, "中值可支配 6474.4-308=6166.4");
  assertEqual(c.disposableRange, [4582, 7737], "可支配区间 [4890-308, 8045-308]");
  assertEqual(c.distanceKm, 10, "distanceKm=10 下发");
}
{
  const c = computeValueCard({ lowK: 10, highK: 10 });
  assertEqual(c.gross, 10000, "两端相等取中 10000");
  assertEqual(c.grossRange, null, "两端相等不产出区间（假区间）");
}
{
  const c = computeValueCard({ lowK: 10, highK: 6 });
  assertEqual(c.grossRange, [6000, 10000], "区间乱序自动排序为 [低,高]");
}

// ════════════════ 8. buildBreakdown 算式明细 ════════════════
{
  assertEqual(buildBreakdown(null), [], "null 卡 → 空明细");
  assertEqual(buildBreakdown({ ok: false }), [], "失败卡 → 空明细");
  const c = computeValueCard({ grossMonthly: 10000, commuteMode: "metro", oneWayKm: 10 });
  const labels = c.breakdown.map((r) => r.label);
  assertEqual(labels, ["税前月薪", "五险一金（个人）", "  其中", "个税", "月到手", "通勤费", "月可支配"], "有通勤 7 行");
  assertEqual(c.breakdown[0].formula, "页面识别到的月薪", "HR明说单点卡 formula=页面识别到的月薪（缺陷2回归）");
  assertEqual(c.breakdown[0].value, "10000.00", "税前月薪显示 10000.00");
  assertEqual(c.breakdown[1].formula, "基数10000.00 × (养老8% + 医疗2% + 失业0.5% + 公积金8%)", "五险一金算式带真实数字");
  assertEqual(c.breakdown[1].value, "-1850.00", "五险一金行负号显示");
  assertEqual(c.breakdown[2].formula, "养老800.00 + 医疗200.00 + 失业50.00 + 公积金800.00", "其中行四项");
  assertEqual(c.breakdown[3].formula, "(10000.00 − 1850.00 − 5000.00起征) × 10% − 210.00速算", "个税算式（taxable 3150 落 10% 档）");
  assertEqual(c.breakdown[3].value, "-105.00", "个税负号");
  assertEqual(c.breakdown[4].value, "8045.00", "月到手行");
  assertEqual(c.breakdown[5].formula, "地铁/市域铁路单程7.00 × 2 × 22工作日", "通勤费算式");
  assertEqual(c.breakdown[5].value, "-308.00", "通勤费负号");
  assertEqual(c.breakdown[6].formula, "8045.00 − 308.00", "可支配算式");
  assertEqual(c.breakdown[6].value, "7737.00", "可支配数值");
}
{
  const c = computeValueCard({ lowK: 6, highK: 10 });
  assertEqual(c.breakdown[0].formula, "职位卡薪资区间取中值", "区间卡 formula=区间取中值（缺陷2回归）");
  assertEqual(c.breakdown[0].value, "6000.00 ~ 10000.00", "区间卡税前显示两端");
  assertEqual(c.breakdown[4].value, "4890.00 ~ 8045.00", "区间卡到手显示两端");
  const labels = c.breakdown.map((r) => r.label);
  assertEqual(labels, ["税前月薪", "五险一金（个人）", "  其中", "个税", "月到手", "月可支配"], "无通勤 6 行（通勤未确认走 else 分支）");
}
{
  const c = computeValueCard({ grossMonthly: 10000, monthsSalary: 13 });
  const last = c.breakdown[c.breakdown.length - 1];
  assertEqual(last.label, "年薪口径", "13 薪追加年薪口径行");
  assertEqual(last.formula, "月到手8045.00 × 13薪", "年薪算式");
  assertEqual(last.value, "104585.00", "年薪数值");
}

// ════════════════ 9. adapter.toValueCard → L1 契约 ════════════════
{
  const card = toValueCard(computeValueCard({ grossMonthly: 10000 }), "job1");
  assertEqual(card.schemaVersion, "1.0.0", "契约 schemaVersion");
  assertEqual(card.jobId, "job1", "jobId 透传");
  assertEqual(card.grossMonthlyK, 10, "名义月薪 10000 → 10K");
  assertEqual(card.grossAnnualK, 120, "年薪 10000×12=120K");
  assertEqual(card.insuranceMonthly, 1850, "月五险一金 1850");
  assertEqual(card.taxMonthly, 105, "月个税 105");
  assertEqual(card.netMonthly, 8045, "月到手 8045");
  assertEqual(card.netAnnual, 96540, "年到手 96540");
  assertEqual(card.disposableMonthly, 8045, "可支配 8045");
  assertEqual(card.sources.base, "估算(基数=月薪)", "sources.base 取内部 insuranceBase");
  assertEqual(card.sources.socialRates, "env默认值(养老8%医疗2%失业0.5%)", "socialRates 标签取自真实 SOCIAL_RATES（缺陷3回归）");
  assertEqual(card.sources.fundRate, "估算(默认8%)", "fundRate 标签");
  assertEqual(card.sources.warning, "通勤方式未确认; 未计入专项附加扣除(估算偏保守)", "警告拼接");
  assertEqual(validateValueCard(card), { valid: true, errors: [] }, "单点卡通过 L1 契约校验");
  assertEqual(card._validationErrors, undefined, "合法卡不带 _validationErrors");
  assertEqual(card.salaryMonths, undefined, "12 薪不下发 salaryMonths");
  assertEqual(card.commuteCostMonthly, undefined, "无通勤不下发 commuteCostMonthly");
}
{
  const card = toValueCard(computeValueCard({ lowK: 6, highK: 10, commuteMode: "metro", oneWayKm: 10, monthsSalary: 13 }), "j2");
  assertEqual(card.salaryMinK, 6, "区间下限 6K");
  assertEqual(card.salaryMaxK, 10, "区间上限 10K");
  assertEqual(card.salaryMonths, 13, "13 薪下发 salaryMonths");
  assertEqual(card.grossAnnualK, 104, "年薪 8000×13=104K");
  assertEqual(card.commuteCostMonthly, 308, "通勤费 308 下发");
  assertEqual(card.disposableMonthly, 6166.4, "可支配 6474.4-308=6166.4");
  assertEqual(card.commuteMode, "metro", "commuteMode 透传");
  assertEqual(card.commuteModeLabel, "地铁/市域铁路", "commuteModeLabel 透传");
  assertEqual(card.distanceKm, 10, "distanceKm 透传");
  assertEqual(card.netAnnual, 84167.2, "年到手 6474.4×13=84167.2");
  assertEqual(validateValueCard(card), { valid: true, errors: [] }, "区间+通勤+13薪卡通过契约");
}
{
  const card = toValueCard({ ok: false, reason: "缺有效名义月薪" }, "j3");
  assertEqual(card.grossMonthlyK, 0, "失败卡月薪 0");
  assertEqual(card.netMonthly, 0, "失败卡到手 0");
  assertEqual(card.netAnnual, 0, "失败卡年到手 0");
  assertEqual(card.sources.base, "计算失败", "失败卡 sources.base");
  assertEqual(card._error, "缺有效名义月薪", "失败卡带 _error");
  assertEqual(validateValueCard(card), { valid: true, errors: [] }, "失败卡结构仍合法（数字齐全）");
}
assertEqual(toValueCard(computeValueCard({ grossMonthly: 10000 })).jobId, "unknown", "缺 jobId → \"unknown\"");
{
  // 防御路径：内部卡带非法类型字段时自验证并挂 _validationErrors
  const card = toValueCard({ ok: true, commute: { mode: 123, modeLabel: "x", known: false, monthly: null } }, "j6");
  assertEqual(card._validationErrors, ["Field commuteMode must be a string"], "非法类型字段被自验证捕获");
}

// ════════════════ 10. computeValueCardFromJob（JobDraft 口径） ════════════════
{
  const card = computeValueCardFromJob({ jobId: "J1", salaryMinK: 6, salaryMaxK: 10 });
  assertEqual(card.jobId, "J1", "jobId 取 job.jobId");
  assertEqual(card.grossMonthlyK, 8, "6-10K → 中值 8K");
  assertEqual(card.salaryMinK, 6, "下限透传");
  assertEqual(card.salaryMaxK, 10, "上限透传");
  assertEqual(card.netMonthly, 6474.4, "中值到手 6474.4");
  assertEqual(validateValueCard(card), { valid: true, errors: [] }, "JobDraft 区间卡通过契约");
}
{
  // 缺陷4回归：distanceKm=0 是合法距离（宿舍），不得被 || 误吞成缺距离
  const card = computeValueCardFromJob({ id: "J9", grossMonthly: 10000, distanceKm: 0, commuteMode: "none", salaryMonths: 13 });
  assertEqual(card.jobId, "J9", "jobId 兼容 job.id");
  assertEqual(card.distanceKm, 0, "0km 保留不丢（缺陷4回归）");
  assertEqual(card.commuteCostMonthly, 0, "none 方式月通勤 0 且已下发");
  assertEqual(card.salaryMonths, 13, "salaryMonths 透传");
  assertEqual(card.netAnnual, 104585, "13 薪年到手 8045×13");
  assertEqual(validateValueCard(card), { valid: true, errors: [] }, "0km 卡通过契约");
}
{
  const card = computeValueCardFromJob({ grossMonthly: 10000, salaryMinK: 6, salaryMaxK: 10 });
  assertEqual(card.grossMonthlyK, 10, "grossMonthly 优先于区间中值");
  assertEqual(card.salaryMinK, 6, "区间仍透传");
  assertEqual(card.netMonthly, 8045, "按 10000 算到手");
}
{
  const card = computeValueCardFromJob({});
  assertEqual(card._error, "缺有效名义月薪", "空 job → 失败卡");
  assertEqual(card.jobId, "unknown", "空 job jobId=unknown");
  assertEqual(card.netMonthly, 0, "失败卡到手 0");
}

// ════════════════ 11. validateValueCard 拒非法卡 ════════════════
assertEqual(validateValueCard({}).valid, false, "空对象被拒");
assertEqual(validateValueCard(null).errors[0], "Payload must be an object", "null → 非对象错误");
assertEqual(
  validateValueCard({ schemaVersion: "2.0.0", jobId: "a", grossMonthlyK: 1, grossAnnualK: 1, insuranceMonthly: 0, taxMonthly: 0, netMonthly: 0, netAnnual: 0, sources: {} }).errors,
  ["Schema major version mismatch: expected 1, got 2"],
  "major 版本不匹配被拒",
);
assertEqual(
  validateValueCard({ schemaVersion: "1.0.0", jobId: "a", grossMonthlyK: NaN, grossAnnualK: 1, insuranceMonthly: 0, taxMonthly: 0, netMonthly: 0, netAnnual: 0, sources: {} }).errors,
  ["Field grossMonthlyK must be a number"],
  "NaN 金额被拒（Number.isFinite）",
);
assertEqual(
  validateValueCard({ schemaVersion: "1.0.0", grossMonthlyK: 1, grossAnnualK: 1, insuranceMonthly: 0, taxMonthly: 0, netMonthly: 0, netAnnual: 0, sources: {} }).errors,
  ["Missing required field: jobId"],
  "缺 jobId 被拒",
);
assertEqual(
  validateValueCard({ schemaVersion: "1.0.0", jobId: "a", grossMonthlyK: 1, grossAnnualK: 1, insuranceMonthly: 0, taxMonthly: 0, netMonthly: 0, netAnnual: 0 }).errors,
  ["Missing required field: sources"],
  "缺 sources 被拒",
);

// ════════════════ 12. 红线：源码零 LLM / 零网络调用 ════════════════
{
  const dir = fileURLToPath(new URL("../../../src/modules/value/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assertTrue(files.length >= 4, "value 目录至少 4 个源文件都被扫到");
  const banned = [
    [/\bfetch\s*\(/, "fetch() 调用"],
    [/\baxios\b/, "axios"],
    [/XMLHttpRequest/, "XMLHttpRequest"],
    [/node:https?/, "node:http(s)"],
    [/node:net\b|node:dgram/, "node:net/dgram"],
    [/child_process/, "child_process"],
    [/\bimport\s*\(/, "动态 import()"],
    [/WebSocket/, "WebSocket"],
    [/EventSource/, "EventSource"],
    [/\b(callLLM|llmCall|chat\.completions|openai|anthropic)\b/i, "LLM 调用"],
  ];
  for (const f of files) {
    const src = readFileSync(dir + f, "utf8");
    for (const [re, what] of banned) {
      assertTrue(!re.test(src), `${f} 不含 ${what}`);
    }
  }
}

console.log(`\nvalue 模块测试: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
