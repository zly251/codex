// Autonomous Job Search Agent
// M1: 职位详情页增补（JD 正文 + 福利标签 + 可能的坐标）。
// 不依赖浏览器：page 由调用方注入（puppeteer page 或假对象，需实现
// evaluate(fn) 返回序列化后的结果 / 或 content() 返回 HTML 文本）。
// routes 接线由主代理负责：抓详情页 -> enrichJobFromDetail(page) ->
// jobDb.updateEnrichment(jobId, res)。

const DORM_RE = /宿舍|住宿|包住|食宿|包吃住/;

function asText(v) {
  return typeof v === "string" ? v.trim() : "";
}

// 从 page.evaluate 的结果规整为统一结构；任何字段缺失都不报错。
export function normalizeEnrichPayload(payload) {
  payload = payload || {};
  const res = {
    description: asText(payload.description),
    requirements: asText(payload.requirements),
    hasDormitory: 0,
    dormitorySource: null,
  };
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  for (const t of tags) {
    const text = typeof t === "string" ? t : (t && (t.name || t.text) ? String(t.name || t.text) : "");
    if (text && DORM_RE.test(text)) { res.hasDormitory = 1; break; }
  }
  // 正文里出现宿舍关键词也算（JD 常写"提供食宿"），但标签优先级更高
  if (!res.hasDormitory && (DORM_RE.test(res.description) || DORM_RE.test(res.requirements) || DORM_RE.test(asText(payload.fullText)))) {
    res.hasDormitory = 1;
  }
  if (res.hasDormitory) res.dormitorySource = "detail";
  const lat = Number(payload.lat), lng = Number(payload.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) { res.lat = lat; res.lng = lng; }
  return res;
}

/**
 * 给 jobDb.updateEnrichment 的 patch：只带非空字段，空串不覆盖库内已有 JD。
 * @param {Awaited<ReturnType<typeof enrichJobFromDetail>>} enriched
 */
export function enrichmentPatch(enriched) {
  const out = {};
  if (!enriched) return out;
  if (enriched.description) out.description = enriched.description;
  if (enriched.requirements) out.requirements = enriched.requirements;
  if (enriched.lng != null) out.lng = enriched.lng;
  if (enriched.lat != null) out.lat = enriched.lat;
  out.hasDormitory = enriched.hasDormitory ? 1 : 0;
  out.dormitorySource = enriched.dormitorySource || null;
  return out;
}

/**
 * 在职位详情页 DOM 抓 JD 正文与福利标签。
 * page 契约（择一即可，测试用假对象）：
 *   - page.evaluate(fn) 返回对象 {description,requirements,tags,lat,lng,fullText}
 *   - 或 page.content() 返回 HTML 字符串（退化为正则粗提取）
 * @returns {{description:string, requirements:string, hasDormitory:0|1, dormitorySource:string|null, lng?:number, lat?:number}}
 */
export async function enrichJobFromDetail(page) {
  if (!page) throw new Error("enrichJobFromDetail: page 未注入");
  if (typeof page.evaluate === "function") {
    const payload = await page.evaluate(extractInPage).catch(function () { return null; });
    if (payload && typeof payload === "object") return normalizeEnrichPayload(payload);
    // evaluate 失败：若还有 content() 就退化，否则返回空结构（不炸调用方循环）
    if (typeof page.content !== "function") return normalizeEnrichPayload(null);
  }
  if (typeof page.content === "function") {
    const html = await page.content().catch(function () { return ""; });
    return normalizeEnrichPayload(extractFromHtml(html));
  }
  throw new Error("enrichJobFromDetail: page 需实现 evaluate 或 content");
}

// 浏览器上下文里执行的提取函数（不得闭包外部变量）。
function extractInPage() {
  function txt(el) { return el ? String(el.textContent || "").trim() : ""; }
  function q(sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && txt(el)) return el;
    }
    return null;
  }
  var descEl = q([".job-sec-text", ".job-detail-section .text", "[class*=job-desc]", ".job-keyword-list", "#job-detail .job-sec-text"]);
  var reqEl = q([".job-condition .text", ".requirements", "[class*=requirement]"]);
  var tagEls = document.querySelectorAll(".job-tags span, .tag-list li, [class*=label-item], .job-keyword-list li");
  var tags = [];
  for (var i = 0; i < tagEls.length; i++) tags.push(txt(tagEls[i]));
  var out = {
    description: txt(descEl),
    requirements: txt(reqEl),
    tags: tags,
    fullText: txt(document.body || document.documentElement),
    lat: null, lng: null,
  };
  if (!out.description && document.body) out.description = String(document.body.innerText || "").trim().slice(0, 8000);
  // 详情页若有坐标属性也捞（防御式，未见实证）
  try {
    var html = document.documentElement.outerHTML;
    var mLat = html.match(/"lat(?:itude)?"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    var mLng = html.match(/"(?:lng|lon|longitude)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (mLat && mLng) { out.lat = Number(mLat[1]); out.lng = Number(mLng[1]); }
  } catch (e) {}
  return out;
}

// content() 退化路径：从 HTML 字符串粗提取 .job-sec-text 段与标签词。
function extractFromHtml(html) {
  html = String(html || "");
  function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(); }
  var descMatch = html.match(/class="[^"]*job-sec-text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  var tagMatches = [];
  var re = /class="[^"]*(?:job-tags|tag-list|label-item)[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div|span)>/g;
  var m;
  while ((m = re.exec(html)) !== null) tagMatches.push(stripTags(m[1]));
  var latMatch = html.match(/"lat(?:itude)?"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  var lngMatch = html.match(/"(?:lng|lon|longitude)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  return {
    description: descMatch ? stripTags(descMatch[1]) : "",
    requirements: "",
    tags: tagMatches,
    fullText: stripTags(html).slice(0, 8000),
    lat: latMatch ? Number(latMatch[1]) : null,
    lng: lngMatch ? Number(lngMatch[1]) : null,
  };
}
