import { createWorker } from "tesseract.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = (function(){ try { return dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
const TESSDATA = (process.env.JOB_AGENT_TESSDATA || resolve(__dirname, "../../tessdata")) + "/";
export async function ocrImage(filePath) {
    try {
        const options = { langPath: TESSDATA, gzip: true };
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
