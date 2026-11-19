// P0-C6：确认「全部恢复默认」覆盖 popupScript 与 placementFile。
// 注意：typography.* / visible.* / kinds.* 是运行时 push 进 GROUP_DEFAULTS 的
// （见 client.js 的循环与 CARD_PARTS），静态源码里 grep 不到，显式算作已覆盖。
// placementFile 不是设置项，走 allDefaults 里的 MACHINE_LOCAL_KEYS，也要算上。
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../lib/index.js";

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const start = src.indexOf("const GROUP_DEFAULTS = [");
const end = src.indexOf("];", start) + 2;
if (start < 0 || end < 2) {
	console.log("FAIL: 找不到 GROUP_DEFAULTS");
	process.exit(1);
}
const block = src.slice(start, end);
const paths = new Set([...block.matchAll(/\["([\w.]+)",/g)].map((m) => m[1]));

const dynamic = ["typography", "visible", "kinds"];
const covered = new Set();
for (const p of paths) covered.add(p.split(".")[0]);
for (const key of dynamic) covered.add(key);

// allDefaults 里显式补齐的机器本地键
const machineLocal = /const MACHINE_LOCAL_KEYS = \[(.*?)\]/u.exec(src);
if (machineLocal) {
	for (const key of [...machineLocal[1].matchAll(/"([\w]+)"/gu)].map((m) => m[1])) covered.add(key);
}

const missing = Object.keys(DEFAULTS).filter((key) => !covered.has(key));
if (missing.length > 0) {
	console.log("FAIL: 全部恢复默认覆盖不到 →", missing.join(", "));
	process.exit(1);
}
console.log(
	"OK: 全部 " +
		Object.keys(DEFAULTS).length +
		" 个顶层键都被覆盖（GROUP_DEFAULTS + 动态生成的 " +
		dynamic.join("/") +
		" + MACHINE_LOCAL_KEYS）",
);
