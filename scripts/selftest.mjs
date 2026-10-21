/**
 * dsh-nudge 自测：不依赖真实 DSH 会话，直接驱动插件逻辑与弹窗 helper。
 *
 * 用法（node 不在 PATH）：
 *   & "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts\selftest.mjs
 *
 * 覆盖：
 *   1. 配置校验与默认值
 *   2. 静音时间段判定
 *   3. AlertCenter 合并计数 / 严重度排序 / dispose
 *   4. PopupRunner 真起 helper：收到 {"type":"shown"}，坐标贴右下角，退出后无残留进程
 *   5. 三种状态各渲染一张卡片快照（PNG 尺寸与非空校验）
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AlertCenter, DEFAULTS, PopupRunner, inMuteRange, normalizeConfig } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const popupScript = join(root, "lib", "popup.ps1");
const shotDir = join(root, "screenshots");

let failures = 0;
const results = [];

/**
 * 记录一条断言结果。
 * @param {string} label 断言名
 * @param {boolean} ok 是否通过
 * @param {string} [detail] 证据
 */
function check(label, ok, detail = "") {
	results.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  --  ${detail}`}`);
	if (!ok) failures++;
}

/**
 * 断言抛错。
 * @param {string} label 断言名
 * @param {() => void} fn 期望抛错的函数
 */
function checkThrows(label, fn) {
	let threw = false;
	try {
		fn();
	} catch {
		threw = true;
	}
	check(label, threw, "expected throw");
}

/**
 * 等一个条件成立。
 * @param {() => boolean} predicate 条件
 * @param {number} timeoutMs 超时
 * @returns {Promise<boolean>} 是否成立
 */
async function waitFor(predicate, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 80));
	}
	return predicate();
}

/** 1. 配置校验 ---- */
const defaults = normalizeConfig(undefined);
check("normalizeConfig 落默认值", defaults.staySeconds === DEFAULTS.staySeconds && defaults.enabled === true);
check("normalizeConfig 合并 kinds", normalizeConfig({ kinds: { failed: false } }).kinds.failed === false
	&& normalizeConfig({ kinds: { failed: false } }).kinds.completed === true);
checkThrows("staySeconds 越界抛错", () => normalizeConfig({ staySeconds: 0 }));
checkThrows("muteRanges 格式非法抛错", () => normalizeConfig({ muteRanges: ["8-9"] }));

/** 2. 静音时间段 ---- */
const at = (h, m) => new Date(2026, 0, 1, h, m);
check("静音 22:00-08:00 覆盖 23:30", inMuteRange(["22:00-08:00"], at(23, 30)));
check("静音 22:00-08:00 覆盖 07:00", inMuteRange(["22:00-08:00"], at(7, 0)));
check("静音 22:00-08:00 不覆盖 12:00", !inMuteRange(["22:00-08:00"], at(12, 0)));
check("同日区间 09:00-18:00 覆盖 10:15", inMuteRange(["09:00-18:00"], at(10, 15)));

/** 3. AlertCenter 合并与排序 ---- */
const sent = [];
const fakeRunner = { show: (items) => { sent.push(items); return true; }, dispose: () => {} };
const center = new AlertCenter({ ...defaults, mergeWindowMs: 0 }, { runner: fakeRunner });
center.push("completed", { sessionId: "s1", title: "会话一", detail: "回合已完成" });
center.push("completed", { sessionId: "s1", title: "会话一", detail: "回合已完成" });
center.push("failed", { sessionId: "s2", title: "会话二", detail: "boom" });
check("重复事件合并计数", center.pending.get("completed|s1")?.count === 2, JSON.stringify(center.pending.get("completed|s1")));
const flushed = center.flush();
check("flush 返回条目数", flushed === 2, `flushed=${flushed}`);
check("严重度排序（failed 在前）", sent[0]?.[0]?.kind === "failed", sent[0]?.map((i) => i.kind).join(","));
center.push("completed", { sessionId: "s3" });
check("kinds 关闭后不再收", new AlertCenter({ ...defaults, kinds: { completed: false, needs_choice: true, failed: true } }, { runner: fakeRunner })
	.push("completed", { sessionId: "s4" }) === false);
center.dispose();

/** 4. PopupRunner 真起 helper ---- */
const statuses = [];
const runner = new PopupRunner({ ...defaults, staySeconds: 6 }, () => {}, { onStatus: (status) => statuses.push(status) });
const delivered = runner.show([{ kind: "needs_choice", sessionId: "session-selftest", title: "自测会话", detail: "等待你选择", at: "21:20", count: 2 }]);
check("PopupRunner.show 投递成功", delivered === true);
const shown = await waitFor(() => statuses.some((status) => status.type === "shown"), 12000);
check("helper 回报 shown", shown, JSON.stringify(statuses));
const shownStatus = statuses.find((status) => status.type === "shown");
if (shownStatus !== undefined) {
	check("卡片贴右下角（left>屏宽*0.7）", shownStatus.left > 1400, `left=${shownStatus.left}, top=${shownStatus.top}`);
	check("卡片计数透传", shownStatus.count === 2, `count=${shownStatus.count}`);
}
const child = runner.child;
runner.dispose();
// 被 kill 的进程 exitCode 为 null、signalCode 为 SIGTERM，两个都要看。
const exited = await waitFor(() => child === null || child.exitCode !== null || child.signalCode !== null, 4000);
check("dispose 后 helper 退出（无孤儿）", exited,
	child === null ? "child=null" : `exitCode=${child.exitCode}, signalCode=${child.signalCode}`);

/** 5. 三种状态快照 ---- */
mkdirSync(shotDir, { recursive: true });
const payloads = {
	completed: { kind: "completed", label: "任务完成", accent: "#2ECC71", glyph: "\u2714", count: 1,
		context: "dsh-nudge",
		items: [{ kind: "completed", title: "写周报", detail: "回合已完成", at: "21:18", count: 1, rowProject: "" }] },
	needs_choice: { kind: "needs_choice", label: "需要你选择", accent: "#F5A623", glyph: "?", count: 2,
		context: "",
		items: [
			{ kind: "needs_choice", title: "部署到生产", detail: "等待你批准一个操作", at: "21:19", count: 1, rowProject: "dsh-nudge" },
			{ kind: "completed", title: "跑测试", detail: "回合已完成", at: "21:17", count: 1, rowProject: "web-console" }
		] },
	failed: { kind: "failed", label: "执行失败", accent: "#E74C3C", glyph: "\u2716", count: 1,
		context: "dsh-nudge",
		items: [{ kind: "failed", title: "构建前端", detail: "exit code 1", at: "21:20", count: 1, rowProject: "" }] }
};

/**
 * 跑一次 snapshot 渲染。
 * @param {string} kind 类型
 * @param {string} out 输出 PNG
 * @returns {Promise<{code: number, out: string}>} 结果
 */
function renderSnapshot(kind, out) {
	const b64 = Buffer.from(JSON.stringify(payloads[kind]), "utf8").toString("base64");
	return new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
			"-File", popupScript, "-Snapshot", out, "-PayloadB64", b64
		], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.on("exit", (code) => resolve({ code: code ?? -1, out: stdout }));
	});
}

for (const kind of Object.keys(payloads)) {
	const out = join(shotDir, `${kind}.png`);
	rmSync(out, { force: true });
	const result = await renderSnapshot(kind, out);
	const exists = existsSync(out);
	const bytes = exists ? readFileSync(out) : Buffer.alloc(0);
	const isPng = bytes.length > 8 && bytes.subarray(1, 4).toString() === "PNG";
	const width = isPng ? bytes.readUInt32BE(16) : 0;
	const height = isPng ? bytes.readUInt32BE(20) : 0;
	check(`快照 ${kind} 渲染成功`, result.code === 0 && isPng, `code=${result.code}, ${stdoutPlaceholder(result.out)}`);
	check(`快照 ${kind} 尺寸合理`, width === 436 && height >= 134, `${width}x${height}, bytes=${bytes.length}`);
}

/**
 * 把子进程输出压成一行证据。
 * @param {string} text 原始输出
 * @returns {string} 简短文本
 */
function stdoutPlaceholder(text) {
	return String(text).replace(/\s+/gu, " ").trim().slice(0, 160);
}

console.log(results.join("\n"));
console.log(failures === 0 ? `\nALL PASS (${results.length} checks)` : `\n${failures} FAILED of ${results.length}`);
process.exit(failures === 0 ? 0 : 1);
