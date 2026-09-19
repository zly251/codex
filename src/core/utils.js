// 平台无关内核：通用工具（M5 步骤 1 抽叶，来源 chatApply.js 15–19）
// 铁律（docs/05_MODULARIZATION_PLAN.md §5.2）：src/core/** 不得 import src/platforms/** 与 chatApply.js。

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randBetween = (min, max) => min + Math.random() * Math.max(0, max - min);
export const randSleep = (minMs, maxMs) => sleep(randBetween(minMs, maxMs));
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
