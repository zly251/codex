import { createWorker } from "tesseract.js";
import fs from "node:fs";
import { resolve } from "node:path";
import { DATA_ROOT } from "../paths.js";
const TESSDATA = (process.env.JOB_AGENT_TESSDATA || resolve(DATA_ROOT, "tessdata")) + "/";
const TESSDATA_GZIP =
  fs.existsSync(TESSDATA + "eng.traineddata.gz") ||
  fs.existsSync(TESSDATA + "chi_sim.traineddata.gz");
export async function ocrImage(filePath) {
    try {
        const options = { langPath: TESSDATA, gzip: TESSDATA_GZIP };
        if (process.env.JOB_AGENT_TESS_WORKER) options.workerPath = process.env.JOB_AGENT_TESS_WORKER;
        const w = await createWorker("chi_sim+eng", 1, options);
        const r = await w.recognize(filePath);
        await w.terminate();
        return r.data.text || "";
    }
    catch (e) {
        console.error("[ocr] " + e.message);
        return null;
    }
}
