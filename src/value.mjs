// 含金量计算器（V0 · 任务卡步骤 1）
// 原则：钱的数字全部代码算，LLM 不参与；每个口径可 env 覆盖；输出处处带「来源标签」。
// 用户 2026-09-22 拍板：砍掉「实际时薪」，到手为王 —— 本模块核心输出 = 月到手 + 扣通勤后月可支配。
// 纯函数，无 DB、无网络。

// —— 配置项（env 覆盖，默认示例城市经验值；全部是「估算」口径，见 §6 风险 1）——
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

// 社保个人缴费比例（占缴费基数）
export const SOCIAL_RATES = {
  pension: envNum("JOB_VALUE_PENSION", 0.08),      // 养老 8%
  medical: envNum("JOB_VALUE_MEDICAL", 0.02),      // 医疗 2%
  unemployment: envNum("JOB_VALUE_UNEMP", 0.005),  // 失业 0.5%
};
// 公积金个人比例（5%~12%，默认 8%）
export const FUND_RATE = envNum("JOB_VALUE_FUND", 0.08);
// 个税起征点（每月减除费用）
export const TAX_THRESHOLD = envNum("JOB_VALUE_TAX_THRESHOLD", 5000);

// 个税「月度换算」税率表（综合所得年度累进 ÷12 的等价档，忽略专项附加扣除除非显式传入）
// [应纳税所得额上限, 税率, 速算扣除数]
const TAX_BRACKETS = [
  [3000, 0.03, 0],
  [12000, 0.10, 210],
  [25000, 0.20, 1410],
  [35000, 0.25, 2660],
  [55000, 0.30, 4410],
  [80000, 0.35, 7160],
  [Infinity, 0.45, 15160],
];

// 通勤方式 → 单程花费（元）与单程耗时（分钟，仅供口径展示，不进出薪）
// 全部经验估算值，可 env 覆盖；未知方式一律走「估算」标签。
export const COMMUTE_MODES = {
  metro: { label: "地铁/市域铁路", perKm: envNum("JOB_VALUE_METRO_KM", 0.5), base: envNum("JOB_VALUE_METRO_BASE", 2), minPerKm: 3 },
  bus:   { label: "公交", perKm: envNum("JOB_VALUE_BUS_KM", 0.1), base: envNum("JOB_VALUE_BUS_BASE", 2), minPerKm: 4 },
  ebyke: { label: "电动车", perKm: envNum("JOB_VALUE_EBYKE_KM", 0.02), base: envNum("JOB_VALUE_EBYKE_BASE", 0.5), minPerKm: 3.5 },
  drive: { label: "自驾", perKm: envNum("JOB_VALUE_DRIVE_KM", 0.6), base: envNum("JOB_VALUE_DRIVE_BASE", 0), minPerKm: 2 },
  walk:  { label: "步行", perKm: 0, base: 0, minPerKm: 12 },
  none:  { label: "住得近/宿舍", perKm: 0, base: 0, minPerKm: 0 },
};

const MONTHS_PER_YEAR = 12;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// —— 五险一金（个人部分），基数默认=名义月薪，可被显式 base 覆盖，钳制到 [baseMin, baseMax] ——
export function computeInsurance(grossMonthly, opts = {}) {
  const baseMin = envNum("JOB_VALUE_SOCIAL_BASE_MIN", 4000);
  const baseMax = envNum("JOB_VALUE_SOCIAL_BASE_MAX", 24000);
  let base = opts.base != null ? Number(opts.base) : Number(grossMonthly);
  let baseSource = opts.base != null ? "HR明说" : "估算(基数=月薪)";
  if (!Number.isFinite(base) || base <= 0) {
    base = baseMin;
    baseSource = "估算(取基数下限)";
  }
  const clamped = Math.min(Math.max(base, baseMin), baseMax);
  if (clamped !== base) baseSource += "→钳制";
  base = clamped;

  const fundRate = opts.fundRate != null ? Number(opts.fundRate) : FUND_RATE;
  const items = {
    pension: round2(base * SOCIAL_RATES.pension),
    medical: round2(base * SOCIAL_RATES.medical),
    unemployment: round2(base * SOCIAL_RATES.unemployment),
    housing: round2(base * fundRate),
  };
  const total = round2(items.pension + items.medical + items.unemployment + items.housing);
  return {
    base: round2(base),
    baseSource,
    fundRate,
    items,
    total,
    // 公积金是「左口袋进右口袋」，可提取/抵房租，到手口径里单列出来供选择是否计入
    housing: items.housing,
  };
}

// —— 个税（月度，简化累进）—— taxable = gross - 五险一金 - 起征点 - 专项附加 ——
export function computeTax(taxableBase) {
  let taxable = Number(taxableBase) - TAX_THRESHOLD;
  if (!Number.isFinite(taxable) || taxable <= 0) {
    return { taxable: Math.max(0, round2(taxableBase - TAX_THRESHOLD)), rate: 0, deduction: 0, tax: 0 };
  }
  for (const [cap, rate, quick] of TAX_BRACKETS) {
    if (taxable <= cap) {
      const tax = round2(taxable * rate - quick);
      return { taxable: round2(taxable), rate, deduction: quick, tax: Math.max(0, tax) };
    }
  }
  // 理论不可达（末档 Infinity）
  return { taxable: round2(taxable), rate: 0.45, deduction: 15160, tax: 0 };
}

// —— 通勤 ——
export function computeCommute(mode, oneWayKm, opts = {}) {
  const key = String(mode || "").toLowerCase();
  const m = COMMUTE_MODES[key];
  const km = Number(oneWayKm);
  const workdays = Number(opts.workdays) > 0 ? Number(opts.workdays) : 22;
  if (!m) {
    return {
      mode: key || "unknown", modeLabel: "未知方式", known: false,
      perOneWay: null, monthly: null, monthlyMinutes: null, workdays,
      source: "待确认(未识别通勤方式)",
    };
  }
  if (!Number.isFinite(km) || km < 0) {
    return {
      mode: key, modeLabel: m.label, known: true,
      perOneWay: null, monthly: null, monthlyMinutes: null, workdays,
      source: "待确认(缺单程距离)",
    };
  }
  const perOneWay = round2(m.base + m.perKm * km);
  let oneWayMin;
  if (m.minPerKm != null && m.minPerKm > 0) {
    oneWayMin = round2(m.minPerKm * km);
  } else if (m.base === 0 && m.perKm === 0) {
    oneWayMin = 0;                       // walk / none：真零成本零耗时
  } else {
    oneWayMin = null;                    // 电动车 base 0.5 但 perKm=0 之类：距离未知，耗时不臆造
  }
  return {
    mode: key, modeLabel: m.label, known: true,
    perOneWay,
    monthly: round2(perOneWay * 2 * workdays),           // 往返 × 工作日
    oneWayMinutes: oneWayMin,
    monthlyMinutes: oneWayMin != null ? round2(oneWayMin * 2 * workdays) : null,
    workdays,
    source: "估算(通勤方式经验价)",
  };
}

// —— 算式明细（用户 2026-09-25 要求：含金量必须写清怎么算出来的）——
// 每行 {label, formula, value, note}：formula 是带真实数字的算式，note 是口径来源。
// 只做字符串组装，不引入新数字——全部取自 card 已有字段，保证与卡片显示一致。
export function buildBreakdown(card) {
  if (!card || !card.ok) return [];
  const f = (n) => (Number.isFinite(n) ? round2(n).toFixed(2) : "—");
  const pct = (r) => `${round2(r * 10000) / 100}%`;
  const ins = card.insurance || {};
  const items = ins.items || {};
  const tax = card.tax || {};
  const com = card.commute || {};
  const rows = [];

  rows.push({
    label: "税前月薪",
    formula: card.grossSource === "职位卡自报" ? "职位卡薪资区间取中值" : "页面识别到的月薪",
    value: card.grossRange ? `${f(card.grossRange[0])} ~ ${f(card.grossRange[1])}` : f(card.gross),
    note: card.grossRange ? "职位卡标区间，按两端分别测算" : card.grossSource,
  });

  const rateParts = [
    `养老${pct(SOCIAL_RATES.pension)}`,
    `医疗${pct(SOCIAL_RATES.medical)}`,
    `失业${pct(SOCIAL_RATES.unemployment)}`,
    `公积金${pct(ins.fundRate)}`,
  ].join(" + ");
  rows.push({
    label: "五险一金（个人）",
    formula: `基数${f(ins.base)} × (${rateParts})`,
    value: `-${f(ins.total)}`,
    note: ins.baseSource,
  });
  rows.push({
    label: "  其中",
    formula: `养老${f(items.pension)} + 医疗${f(items.medical)} + 失业${f(items.unemployment)} + 公积金${f(items.housing)}`,
    value: f(ins.total),
    note: "公积金进个人账户，不计入到手",
  });

  rows.push({
    label: "个税",
    formula: `(${f(card.gross)} − ${f(ins.total)} − ${f(TAX_THRESHOLD)}起征) × ${pct(tax.rate)} − ${f(tax.deduction)}速算`,
    value: `-${f(tax.tax)}`,
    note: card.sources?.tax || "估算(月度累进)",
  });

  rows.push({
    label: "月到手",
    formula: `${f(card.gross)} − ${f(ins.total)} − ${f(tax.tax)}`,
    value: card.netRange ? `${f(card.netRange[0])} ~ ${f(card.netRange[1])}` : f(card.net),
    note: card.netRange ? "按区间两端分别算；算式为中值示例。到手为王：不含公积金入账" : "到手为王：不含公积金入账",
  });

  if (Number.isFinite(com.monthly) && com.monthly > 0) {
    rows.push({
      label: "通勤费",
      formula: `${com.modeLabel}单程${f(com.perOneWay)} × 2 × ${com.workdays}工作日`,
      value: `-${f(com.monthly)}`,
      note: com.source,
    });
    rows.push({
      label: "月可支配",
      formula: `${f(card.net)} − ${f(com.monthly)}`,
      value: card.disposableRange ? `${f(card.disposableRange[0])} ~ ${f(card.disposableRange[1])}` : f(card.disposable),
      note: card.disposableRange ? "按区间两端分别算；算式为中值示例" : "到手扣掉通勤花费",
    });
  } else {
    rows.push({
      label: "月可支配",
      formula: com.source || "通勤未确认，暂按 0 计",
      value: f(card.disposable),
      note: "在设置里填通勤方式/距离会更准",
    });
  }

  if (card.annual && card.annual.monthsSalary !== 12) {
    rows.push({
      label: "年薪口径",
      formula: `月到手${f(card.net)} × ${card.annual.monthsSalary}薪`,
      value: f(card.annual.annualNet),
      note: "页面标注几薪",
    });
  }
  return rows;
}

// 给定名义月薪，算出「个人五险一金 / 个税 / 到手 / 可支配」。通勤费与月薪无关，单独传入。
// 抽出来是为了能对薪资区间的两端各算一次，得到「到手区间」——职位卡标的是区间
// （如 6-10K），只取中值报一个到手数字是假精确（2026-09-25 用户指出「税前对不上」）。
function netAtGross(grossMonthly, input, commuteCost) {
  const ins = computeInsurance(grossMonthly, { base: input.socialBase, fundRate: input.fundRate });
  const special = Number(input.specialDeduct) > 0 ? Number(input.specialDeduct) : 0;
  const taxableBase = round2(grossMonthly - ins.total - special);
  const tax = computeTax(taxableBase);
  const net = round2(grossMonthly - ins.total - tax.tax);
  return { ins, tax, special, net, disposable: round2(net - commuteCost) };
}

// —— 组装含金量卡 ——
// grossMonthly：名义月薪（元，税前）。传 salaryK 时自动 ×1000（salary.js 输出单位是 K）。
// monthsSalary：几薪（如 13 薪），影响「年薪口径」不影响「月到手」。
// includeHousingInNet：公积金是否计入「可支配」（默认 false=不计，因其锁定；单列展示）。
// lowK/highK：职位卡薪资区间两端（单位 K）。给了就额外产出 grossRange/netRange/disposableRange，
//   让「到手/可支配」如实显示为区间，而非中值假精确。中值 gross/net 仍保留，供逐步明细使用。
export function computeValueCard(input = {}) {
  let gross = input.grossMonthly != null ? Number(input.grossMonthly) : null;
  let grossSource = "HR明说";
  if (gross == null && input.salaryK != null) {
    const k = Number(input.salaryK);
    if (Number.isFinite(k)) { gross = k * 1000; grossSource = "职位卡自报"; }
  }
  if (!Number.isFinite(gross) || gross <= 0) {
    return { ok: false, reason: "缺有效名义月薪", grossSource };
  }

  // 通勤先算（与月薪无关），供区间两端复用
  const commute = computeCommute(input.commuteMode, input.oneWayKm, { workdays: input.workdays });
  const commuteCost = Number.isFinite(commute.monthly) ? commute.monthly : 0;

  const mid = netAtGross(gross, input, commuteCost);
  const ins = mid.ins;
  const special = mid.special;
  const tax = { ...mid.tax, special };
  const net = mid.net;
  const netWithHousing = round2(net + ins.housing);
  const disposable = mid.disposable;
  const disposableWithHousing = round2(netWithHousing - commuteCost);

  // 薪资区间 → 到手/可支配区间（两端各算一次，社保/个税按各自基数与税率档）
  const lowK = Number(input.lowK);
  const highK = Number(input.highK);
  let grossRange = null, netRange = null, disposableRange = null;
  if (Number.isFinite(lowK) && Number.isFinite(highK) && lowK > 0 && highK > 0) {
    const gLo = round2(Math.min(lowK, highK) * 1000);
    const gHi = round2(Math.max(lowK, highK) * 1000);
    if (gHi > gLo) {
      const lo = netAtGross(gLo, input, commuteCost);
      const hi = netAtGross(gHi, input, commuteCost);
      grossRange = [gLo, gHi];
      netRange = [lo.net, hi.net];
      disposableRange = [lo.disposable, hi.disposable];
    }
  }

  // 年薪口径（含几薪）
  const monthsSalary = Number(input.monthsSalary) > 0 ? Number(input.monthsSalary) : MONTHS_PER_YEAR;
  const annualNet = round2(net * monthsSalary);

  const card = {
    ok: true,
    gross: round2(gross), grossSource,
    grossRange,                // 职位卡薪资区间两端 [低,高]（元/月）；单值/HR明说 → null
    netRange,                  // 对应到手区间 [低,高]；无区间 → null
    disposableRange,           // 对应可支配区间 [低,高]；无区间 → null
    insurance: ins,
    tax,
    net,                       // 月到手（按中值，供逐步明细使用）
    netWithHousing,            // 到手 + 公积金
    commute,
    disposable,                // 月可支配 = 到手 − 通勤话费
    disposableWithHousing,
    annual: { monthsSalary, annualNet },
    // 来源标签汇总，前端「口径自曝」直接用这块
    sources: {
      gross: grossSource,
      insuranceBase: ins.baseSource,
      fundRate: input.fundRate != null ? "HR明说" : `估算(默认${round2(FUND_RATE * 100)}%)`,
      specialDeduct: special > 0 ? "HR明说/用户填" : "未计(估算偏保守)",
      commute: commute.source,
      tax: "估算(月度累进,忽略部分专项附加)",
    },
  };
  card.breakdown = buildBreakdown(card); // 算式明细，随卡一起下发
  return card;
}
