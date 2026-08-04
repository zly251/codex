import { bossPlatform } from "./boss.js";

const PLATFORMS = {
  boss: bossPlatform,
};

export const DEFAULT_PLATFORM = process.env.JOB_PLATFORM || "boss";

export function getPlatform(name) {
  const id = name || DEFAULT_PLATFORM;
  const platform = PLATFORMS[id];
  if (!platform) throw new Error("Unknown platform: " + id);
  return platform;
}
