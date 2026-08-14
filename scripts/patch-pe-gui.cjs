'use strict';
/*
 * 把 PE optional header 的 Subsystem 改为 2（GUI），
 * 避免 SEA 打包的 exe 启动时弹出控制台窗口。
 *
 * 用法：node scripts/patch-pe-gui.cjs [exe 路径]
 * 默认目标：dist/求职助手.exe
 */
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] || path.join(__dirname, '..', 'dist', '求职助手.exe');
const file = path.resolve(target);

const buf = fs.readFileSync(file);
if (buf.length < 0x40) {
  throw new Error('文件过小，不是有效 PE：' + file);
}

// DOS header 的 e_lfanew 位于偏移 0x3C，指向 PE signature
const peOffset = buf.readUInt32LE(0x3c);
if (peOffset + 6 > buf.length || buf.toString('latin1', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
  throw new Error('不是有效 PE 文件：' + file);
}

// COFF header 20 字节之后是 Optional header
const optOffset = peOffset + 4 + 20;
if (optOffset + 2 > buf.length) {
  throw new Error('文件截断，缺少 PE Optional header（' + file + '）');
}
const magic = buf.readUInt16LE(optOffset);
if (magic !== 0x10b && magic !== 0x20b) {
  throw new Error('未知的 PE Optional header magic：0x' + magic.toString(16) + '（' + file + '）');
}

// Subsystem 字段位于 Optional header 偏移 68（PE32 / PE32+ 相同）
// 2 = GUI，3 = Console；读取前先做边界检查，避免截断文件时报 ERR_OUT_OF_RANGE
const subsystemOffset = optOffset + 68;
if (optOffset + 70 > buf.length) {
  throw new Error('文件截断，缺少 PE Subsystem 字段（' + file + '）');
}
const before = buf.readUInt16LE(subsystemOffset);
buf.writeUInt16LE(2, subsystemOffset);

fs.writeFileSync(file, buf);
console.log('[patch-pe-gui] ' + file + ' subsystem ' + before + ' -> 2 (GUI)');
