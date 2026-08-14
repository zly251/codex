// 临时验证辅助（非交付物）：无阻塞启动桌面 exe，输出重定向到 temp/exe-*.log
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const exe = "C:\\Users\\asus\\Desktop\\求职助手.exe";
const logDir = path.join(__dirname, "..", "temp");
fs.mkdirSync(logDir, { recursive: true });
const out = fs.openSync(path.join(logDir, "exe-out.log"), "w");
const err = fs.openSync(path.join(logDir, "exe-err.log"), "w");
const p = spawn(exe, [], {
  detached: true,
  stdio: ["ignore", out, err],
  cwd: path.join(__dirname, ".."),
  windowsHide: false,
});
p.on("error", (e) => console.error("spawn error:", e.message));
p.unref();
console.log("spawned pid:", p.pid);
