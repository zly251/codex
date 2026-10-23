// L1 core — 薪资文本解析纯函数（从 src/salary.js 下沉到 core，供 L2 复用且不违反 G4）
// 依赖方向：L1 不得 import 上层（modules / platforms / 旧链根目录文件）。
// 本文件只放「文本 → 数字」的纯解析，不碰排序/排名（那些留在旧链 src/salary.js）。

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function unknownSalary(value) {
  return /面议|薪资面议|协商|未知|未填|不限|暂无/i.test(String(value || ""));
}

function parseAmountToken(token) {
  const t = String(token || "").trim().toLowerCase();
  const match = t.match(/^(\d+(?:\.\d+)?)\s*(万|千|k)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "万") return amount * 10;
  if (unit === "千" || unit === "k") return amount;
  return /^\d{4,}$/.test(t.replace(/\D/g, "")) ? amount / 1000 : amount;
}

export function parseMonthlySalaryK(value) {
  const raw = String(value || "").trim();
  if (!raw || unknownSalary(raw)) return null;

  const lower = raw.toLowerCase();

  const daily = lower.match(
    /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*元(?:\/|／)\s*天/
  );
  if (daily) {
    return {
      min: (Number(daily[1]) * 22) / 1000,
      max: (Number(daily[2]) * 22) / 1000,
    };
  }

  const singleDaily = lower.match(/(\d+(?:\.\d+)?)\s*元(?:\/|／)\s*天/);
  if (singleDaily) return (Number(singleDaily[1]) * 22) / 1000;

  const hourly = lower.match(
    /(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*元(?:\/|／)\s*(?:小)?时/
  );
  if (hourly) {
    const perMonth = 8 * 22;
    return {
      min: (Number(hourly[1]) * perMonth) / 1000,
      max: (Number(hourly[2]) * perMonth) / 1000,
    };
  }

  const singleHourly = lower.match(
    /(\d+(?:\.\d+)?)\s*元(?:\/|／)\s*(?:小)?时/
  );
  if (singleHourly) return (Number(singleHourly[1]) * 8 * 22) / 1000;

  const annual = lower.match(
    /(\d+(?:\.\d+)?)\s*(?:万(?:元)?)?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*万(?:元)?\s*(?:\/|／)\s*年/
  ) || lower.match(
    /年薪\s*(\d+(?:\.\d+)?)\s*(?:万(?:元)?)?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*万(?:元)?/
  );
  if (annual) {
    return {
      min: (Number(annual[1]) * 10) / 12,
      max: (Number(annual[2]) * 10) / 12,
    };
  }

  const singleAnnual =
    lower.match(
      /^(?:年薪)?\s*(\d+(?:\.\d+)?)\s*万元?(?:\/|／)?\s*年$/
    ) || lower.match(/^年薪\s*(\d+(?:\.\d+)?)\s*万元?$/);
  if (singleAnnual) return (Number(singleAnnual[1]) * 10) / 12;

  const above = lower.match(
    /^(\d+(?:\.\d+)?)\s*(万|千|k)?\s*以上/
  );
  if (above) {
    return {
      min: parseAmountToken(`${above[1]}${above[2] || ""}`),
      max: null,
    };
  }

  const below = lower.match(
    /^(\d+(?:\.\d+)?)\s*(万|千|k)?\s*以下/
  );
  if (below) {
    return {
      min: null,
      max: parseAmountToken(`${below[1]}${below[2] || ""}`),
    };
  }

  const range = lower.match(
    /(\d+(?:\.\d+)?)\s*(万|千|k)?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*(万|千|k)?/
  );
  if (range) {
    return {
      min: parseAmountToken(`${range[1]}${range[2] || ""}`),
      max: parseAmountToken(`${range[3]}${range[4] || ""}`),
    };
  }

  const single = lower.match(/^(\d+(?:\.\d+)?)\s*(万|千|k)?/);
  if (single) return parseAmountToken(`${single[1]}${single[2] || ""}`);

  return null;
}

// —— 便捷包装：把任意岗位对象的薪资字段统一成 {min,max}（K/月）——
// job 字段优先级：显式 salaryMin/salaryMax > salaryRaw 文本解析。
export function jobSalaryRange(job) {
  const min = toNumber(job?.salaryMin);
  const max = toNumber(job?.salaryMax);
  if (min != null || max != null) return { min, max };
  const parsed = parseMonthlySalaryK(job?.salaryRaw);
  if (parsed == null) return { min: null, max: null };
  if (typeof parsed === "number") return { min: parsed, max: parsed };
  return { min: parsed.min, max: parsed.max };
}
