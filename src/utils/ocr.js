import { createWorker } from "tesseract.js";
import fs from "node:fs";
import { resolve } from "node:path";
import { DATA_ROOT } from "../paths.js";
const TESSDATA = (process.env.JOB_AGENT_TESSDATA || resolve(DATA_ROOT, "tessdata")) + "/";
const TESSDATA_GZIP =
  fs.existsSync(TESSDATA + "eng.traineddata.gz") ||
  fs.existsSync(TESSDATA + "chi_sim.traineddata.gz");
function cleanOcrText(text) {
  let out = String(text || "");
  // Tesseract 对中文经常在汉字之间插入空格，这里把汉字之间的空格去掉。
  out = out.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1");
  // 中文标点前后不留空格。
  out = out.replace(/\s+([，。；：！？、）】》])/g, "$1");
  out = out.replace(/([（【《])\s+/g, "$1");
  return out.trim();
}

export async function ocrImage(filePath) {
    try {
        const options = { langPath: TESSDATA, gzip: TESSDATA_GZIP };
        if (process.env.JOB_AGENT_TESS_WORKER) options.workerPath = process.env.JOB_AGENT_TESS_WORKER;
        const w = await createWorker("chi_sim+eng", 1, options);
        try {
            await w.setParameters({
                tessedit_pageseg_mode: "6",
                preserve_interword_spaces: "0",
            });
        } catch (e) {}
        const r = await w.recognize(filePath);
        await w.terminate();
        return cleanOcrText(r.data.text || "");
    }
    catch (e) {
        console.error("[ocr] " + e.message);
        return null;
    }
}
