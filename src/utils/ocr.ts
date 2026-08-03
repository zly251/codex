import { createWorker } from "tesseract.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESSDATA = resolve(__dirname, "../../tessdata") + "/";

export async function ocrImage(filePath) {
  try {
    const w = await createWorker("chi_sim+eng", 1, { langPath: TESSDATA, gzip: true });
    const r = await w.recognize(filePath);
    await w.terminate();
    return r.data.text || "";
  } catch(e) { console.error("[ocr] " + e.message); return null; }
}