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

function jobSalary(job) {
  const min = toNumber(job?.salaryMin);
  const max = toNumber(job?.salaryMax);
  if (min != null || max != null) return { min, max };
  const parsed = parseMonthlySalaryK(job?.salaryRaw);
  if (parsed == null) return { min: null, max: null };
  if (typeof parsed === "number") return { min: parsed, max: parsed };
  return { min: parsed.min, max: parsed.max };
}

function expectedFloor(expectedSalary) {
  const parsed = typeof expectedSalary === "number"
    ? expectedSalary
    : parseMonthlySalaryK(expectedSalary);
  if (parsed == null) return null;
  if (typeof parsed === "number") return parsed;
  return parsed.min;
}

export function salaryRankForJob(job, expectedSalary) {
  const expected = expectedFloor(expectedSalary);
  if (expected == null) return 1;

  const { min, max } = jobSalary(job);
  if (min == null && max == null) return 1;

  if (min != null && min > expected) return 0;
  if (max != null && max < expected) return 2;
  return 1;
}

export function sortJobsForApply(jobs, expectedSalary) {
  const ranked = Array.from(jobs || []).map(function (item) {
    const rank = Number.isFinite(item?.salaryRank)
      ? item.salaryRank
      : salaryRankForJob(item?.job || item, expectedSalary);
    return Object.assign({}, item, { salaryRank: rank });
  });
  return ranked.sort(function (a, b) {
    const aRank = a.salaryRank;
    const bRank = b.salaryRank;
    if (aRank !== bRank) return aRank - bRank;

    const aMatch = Number.isFinite(a?.match)
      ? a.match
      : Number.isFinite(a?.score)
        ? a.score / 100
        : 0;
    const bMatch = Number.isFinite(b?.match)
      ? b.match
      : Number.isFinite(b?.score)
        ? b.score / 100
        : 0;
    return bMatch - aMatch;
  });
}
