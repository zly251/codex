// V0 测试：含金量计算器（value.mjs）
// 对应任务卡 §7 断言表：13薪 / 包食宿 / 公积金5%~12%两档 / 电动车vs公交通勤。
// 纯函数测试，无 DB、无网络。所有期望值为手算对照。
let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; failures.push(msg); console.error("  ✗ " + msg); }
}
function assertClose(a, b, msg, eps = 0.01) {
  assert(Number.isFinite(a) && Math.abs(a - b) <= eps, msg + ` (得 ${a}, 期望 ${b})`);
}

const { computeValueCard, computeInsurance, computeTax, computeCommute } = await import("../src/value.mjs");

console.log("\n[组1] 月薪8000 · 基数=月薪 · 公积金8% · 电动车5km");
{
  const c = computeValueCard({ grossMonthly: 8000, commuteMode: "ebyke", oneWayKm: 5 });
  assert(c.ok === true, "计算成功");
  assertClose(c.insurance.total, 1480, "五险一金=1480 (640+160+40+640)");
  assertClose(c.tax.tax, 45.6, "个税=45.6 (应税1520×3%)");
  assertClose(c.net, 6474.4, "月到手=6474.4");
  assertClose(c.commute.monthly, 26.4, "电动车月通勤=26.4 (0.6×2×22)");
  assertClose(c.disposable, 6448.0, "月可支配=6448.0");
  assert(c.sources.gross === "HR明说", "月薪来源=HR明说");
  assert(c.sources.commute.includes("估算"), "通勤来源标注估算");
}

console.log("\n[组2] 月薪10000 · 公积金12%档（高）");
{
  const c = computeValueCard({ grossMonthly: 10000, fundRate: 0.12, commuteMode: "none", oneWayKm: 0 });
  assertClose(c.insurance.total, 2250, "五险一金=2250 (800+200+50+1200)");
  assertClose(c.tax.tax, 82.5, "个税=82.5 (应税2750×3%)");
  assertClose(c.net, 7667.5, "月到手=7667.5");
  assertClose(c.disposable, c.net, "住得近→可支配=到手(无通勤)");
  assert(c.sources.fundRate === "HR明说", "公积金比例来源=HR明说");
}

console.log("\n[组3] 月薪8000 · 13薪 → 年薪口径");
{
  const c = computeValueCard({ grossMonthly: 8000, monthsSalary: 13, commuteMode: "ebyke", oneWayKm: 5 });
  assertClose(c.annual.monthsSalary, 13, "几薪=13");
  assertClose(c.annual.annualNet, 6474.4 * 13, "年到手=月到手×13");
}

console.log("\n[组4] 月薪5000 · 公积金5%档（低）→ 起征点内不缴税");
{
  const c = computeValueCard({ grossMonthly: 5000, fundRate: 0.05, commuteMode: "bus", oneWayKm: 8 });
  assertClose(c.insurance.total, 775, "五险一金=775 (400+100+25+250)");
  assertClose(c.tax.tax, 0, "个税=0 (应税-775≤起征点)");
  assertClose(c.net, 4225, "月到手=4225");
  assertClose(c.commute.monthly, 123.2, "公交月通勤=123.2 (2.8×2×22)");
}

console.log("\n[组5] 电动车 vs 公交 · 同距离 8km 对比");
{
  const ebyke = computeCommute("ebyke", 8);
  const bus = computeCommute("bus", 8);
  assertClose(ebyke.perOneWay, 0.66, "电动车单程0.66 (0.5+0.02×8)");
  assertClose(bus.perOneWay, 2.8, "公交单程2.8 (2+0.1×8)");
  assert(ebyke.perOneWay < bus.perOneWay, "电动车单程 < 公交单程");
  assert(ebyke.oneWayMinutes < bus.oneWayMinutes, "电动车耗时 < 公交耗时");
}

console.log("\n[组6] 缺通勤方式 → 不崩、标注待确认、可支配仍=到手");
{
  const c = computeValueCard({ grossMonthly: 8000 });
  assert(c.ok === true, "无通勤仍计算成功");
  assert(c.commute.known === false, "通勤方式未知");
  assert(c.commute.source.includes("待确认"), "通勤来源标注待确认");
  assertClose(c.disposable, c.net, "缺通勤→可支配=到手(按0扣)");
}

console.log("\n[组7] 单位换算 · salaryK=8 → gross=8000（salary.js 输出单位K）");
{
  const c = computeValueCard({ salaryK: 8, commuteMode: "ebyke", oneWayKm: 5 });
  assertClose(c.gross, 8000, "salaryK 8 → 8000元");
  assert(c.grossSource === "职位卡自报", "来源=职位卡自报");
  assertClose(c.net, 6474.4, "与组1一致");
}

console.log("\n[组8] 无效输入 → 优雅失败，不抛异常");
{
  const c = computeValueCard({});
  assert(c.ok === false, "无月薪→ok=false");
  const c2 = computeValueCard({ grossMonthly: "面议" });
  assert(c2.ok === false, "非法月薪→ok=false");
}

console.log("\n[组9] 社保基数钳制 · 月薪30000 → 钳到上限24000");
{
  const c = computeValueCard({ grossMonthly: 30000, commuteMode: "ebyke", oneWayKm: 5 });
  assertClose(c.insurance.base, 24000, "缴费基数钳到上限24000");
  assert(c.insurance.baseSource.includes("钳制"), "基数来源标注钳制");
}

console.log("\n[单元] computeTax 累进边界");
{
  // taxableBase=8000 → 应税3000 → 3% 档 → 90
  assertClose(computeTax(8000).tax, 90, "应税3000→90");
  // taxableBase=18000 → 应税13000 → 落入20%档(>12000) → 13000*0.2-1410=1190
  assertClose(computeTax(18000).tax, 1190, "应税13000→1190 (20%档)");
}

console.log(`\n结果：${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("失败项：\n  - " + failures.join("\n  - "));
  process.exit(1);
}
