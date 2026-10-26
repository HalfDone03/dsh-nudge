/**
 * dsh-nudge 自测：不依赖真实 DSH 会话，直接驱动插件逻辑与弹窗 helper。
 *
 * 用法（node 不在 PATH）：
 *   & "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts\selftest.mjs
 *
 * 参数：
 *   --no-live         只跑逻辑、快照与静态约束，不起真实 helper 窗口（CI 用）
 *   --update-baseline 重新生成 tools/snapshot-baseline.json（改了版式之后手动跑一次）
 *
 * 覆盖：
 *   1. 配置校验与默认值
 *   2. 静音时间段判定
 *   3. AlertCenter 合并计数 / 严重度排序 / dispose
 *   4. PopupRunner 真起 helper：收到 {"type":"shown"}，坐标贴右下角，退出后无残留进程（--no-live 时跳过）
 *   5. 三种状态各渲染一张卡片快照，并与 tools/snapshot-baseline.json 的像素统计比对
 *   6. 源码静态约束（纯 ASCII、字号阶梯、单卡槽位、全屏抑制、调试开关）
 *   7. 单卡互斥真跑一遍 A/B 两张卡，顺带验证 payload 落盘调试开关（--no-live 时跳过）
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { AlertCenter, DEFAULTS, PopupRunner, buildConfigSchema, createPlugin, inMuteRange, isVolatileRef, liveConfig, normalizeConfig } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const popupScript = join(root, "lib", "popup.ps1");
const shotDir = join(root, "screenshots");
const baselineFile = join(root, "tools", "snapshot-baseline.json");

const argv = process.argv.slice(2);
const noLive = argv.includes("--no-live");
const updateBaseline = argv.includes("--update-baseline");

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

/**
 * 解出 PNG 像素。只处理弹窗脚本写出来的那种：8 位、非交错、RGB 或 RGBA。
 * @param {Buffer} bytes PNG 字节
 * @returns {{width: number, height: number, channels: number, pixels: Buffer}} 像素
 */
function decodePng(bytes) {
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	const bitDepth = bytes[24];
	const colorType = bytes[25];
	const interlace = bytes[28];
	if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
		throw new Error(`unsupported png: depth=${bitDepth}, colorType=${colorType}, interlace=${interlace}`);
	}
	const channels = colorType === 6 ? 4 : 3;
	const idat = [];
	let offset = 8;
	while (offset + 8 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
		if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
		offset += 12 + length;
		if (type === "IEND") break;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(width * height * channels);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		const out = pixels.subarray(y * stride, y * stride + stride);
		const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
		for (let x = 0; x < stride; x++) {
			const value = line[x];
			const left = x >= channels ? out[x - channels] : 0;
			const up = prev === null ? 0 : prev[x];
			const upLeft = prev === null || x < channels ? 0 : prev[x - channels];
			let recon;
			switch (filter) {
				case 0: recon = value; break;
				case 1: recon = value + left; break;
				case 2: recon = value + up; break;
				case 3: recon = value + ((left + up) >> 1); break;
				case 4: {
					const estimate = left + up - upLeft;
					const da = Math.abs(estimate - left);
					const db = Math.abs(estimate - up);
					const dc = Math.abs(estimate - upLeft);
					recon = value + (da <= db && da <= dc ? left : db <= dc ? up : upLeft);
					break;
				}
				default: throw new Error(`bad png filter ${filter}`);
			}
			out[x] = recon & 0xff;
		}
	}
	return { width, height, channels, pixels };
}

/**
 * 快照像素统计，基线就是拿这几个数比：
 *   distinct 不同颜色数、dark 亮度<40 的像素、text 亮度>150 的像素、accent 贴状态色的像素。
 * @param {Buffer} bytes PNG 字节
 * @param {[number, number, number]} accent 状态色 RGB
 * @returns {{width: number, height: number, distinct: number, dark: number, text: number, accent: number}} 统计
 */
function pngStats(bytes, accent) {
	const { width, height, channels, pixels } = decodePng(bytes);
	const colors = new Set();
	let dark = 0;
	let text = 0;
	let accentPixels = 0;
	for (let index = 0; index < width * height; index++) {
		const r = pixels[index * channels];
		const g = pixels[index * channels + 1];
		const b = pixels[index * channels + 2];
		colors.add((r << 16) | (g << 8) | b);
		const luma = 0.299 * r + 0.587 * g + 0.114 * b;
		if (luma < 40) dark++;
		if (luma > 150) text++;
		if (Math.abs(r - accent[0]) <= 24 && Math.abs(g - accent[1]) <= 24 && Math.abs(b - accent[2]) <= 24) accentPixels++;
	}
	return { width, height, distinct: colors.size, dark, text, accent: accentPixels };
}

/**
 * 把十六进制色转成 RGB 三元组。
 * @param {string} hex 形如 #2ECC71
 * @returns {[number, number, number]} RGB
 */
function rgbOf(hex) {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * 统计值是否落在基线容差内：宽高必须一模一样，像素计数允许 ±2%（至少 ±3）。
 * @param {number} actual 实际
 * @param {number} expected 基线
 * @returns {boolean} 是否可接受
 */
function withinTolerance(actual, expected) {
	const slack = Math.max(3, Math.round(expected * 0.02));
	return Math.abs(actual - expected) <= slack;
}

/** 1. 配置校验 ---- */
const defaults = normalizeConfig(undefined);
// 真起窗口的几段不能看当前桌面是什么：前台是游戏、视频、甚至只剩桌面（Progman 的矩形
// 正好等于整块显示器）时，全屏抑制会让卡片整批不弹。所以 live 段显式关掉它，
// 抑制逻辑本身由第 6 组的源码断言兜着。
const liveDefaults = { ...defaults, suppressWhenFullscreen: false };
check("normalizeConfig 落默认值", defaults.staySeconds === DEFAULTS.staySeconds && defaults.enabled === true);
check("normalizeConfig 合并 kinds", normalizeConfig({ kinds: { failed: false } }).kinds.failed === false
	&& normalizeConfig({ kinds: { failed: false } }).kinds.completed === true);
checkThrows("staySeconds 越界抛错", () => normalizeConfig({ staySeconds: 0 }));
checkThrows("muteRanges 格式非法抛错", () => normalizeConfig({ muteRanges: ["8-9"] }));
checkThrows("muteRanges 小时越界抛错", () => normalizeConfig({ muteRanges: ["25:00-08:00"] }));
checkThrows("muteRanges 分钟越界抛错", () => normalizeConfig({ muteRanges: ["22:60-08:00"] }));
checkThrows("kinds 非对象抛错", () => normalizeConfig({ kinds: ["completed"] }));
check("默认全屏时不打扰", defaults.suppressWhenFullscreen === true, String(defaults.suppressWhenFullscreen));
checkThrows("suppressWhenFullscreen 非布尔抛错", () => normalizeConfig({ suppressWhenFullscreen: "yes" }));
check("默认配色跟随系统", defaults.theme === "auto", String(defaults.theme));
check("配色可固定为浅色", normalizeConfig({ theme: "light" }).theme === "light");
checkThrows("theme 非法值抛错", () => normalizeConfig({ theme: "blue" }));
check("调试落盘默认关闭", defaults.debugPayload === false, String(defaults.debugPayload));
check("调试落盘可打开并带路径", normalizeConfig({ debugPayload: true, debugFile: "C:\\temp\\x.jsonl" }).debugFile.endsWith("x.jsonl"));
checkThrows("debugPayload 非布尔抛错", () => normalizeConfig({ debugPayload: "yes" }));
checkThrows("debugFile 非字符串抛错", () => normalizeConfig({ debugFile: 1 }));

/** 1.6 实时配置：设置界面改完立刻生效 ---- */
// 照抄 dsh-settings/lib/types/schema.js 的 volatileForm 规则：只有 volatile 字段会被收进设置表单
function volatileFormNames(schema) {
	const names = Object.keys(schema.dict ?? {}).filter((key) => schema.dict[key].meta?.volatile === true);
	if (schema.meta?.volatile) names.push("(self)");
	for (const [key, node] of Object.entries(schema.dict ?? {})) {
		if (node.meta?.volatile !== true && node.type === "object" && node.dict) {
			if (Object.values(node.dict).some((child) => child.meta?.volatile === true)) names.push(key);
		}
	}
	return names;
}
const WRITE = Symbol.for("cosmokit.volatile.write");
const ref = (start) => {
	let current = start;
	return Object.freeze({ get: () => current, [WRITE]: (next) => { current = next; } });
};
const plainRaw = { enabled: true, staySeconds: 15, theme: "auto", kinds: { completed: true } };
const plainLive = liveConfig(plainRaw);
check("实时配置读到初始值", plainLive.staySeconds === 15 && plainLive.theme === "auto", `${plainLive.staySeconds}/${plainLive.theme}`);
plainRaw.staySeconds = 30;
plainRaw.theme = "light";
check("配置对象被改后立刻读到新值", plainLive.staySeconds === 30 && plainLive.theme === "light", `${plainLive.staySeconds}/${plainLive.theme}`);
plainRaw.staySeconds = 999;
check("非法值沿用上一次可用的配置", plainLive.staySeconds === 30, String(plainLive.staySeconds));
check("实时配置不污染 DEFAULTS", DEFAULTS.staySeconds === 15, String(DEFAULTS.staySeconds));

const refRaw = { enabled: true, staySeconds: ref(15), theme: ref("auto"), kinds: { completed: ref(true), needs_choice: ref(true), failed: ref(true) } };
const refLive = liveConfig(refRaw);
check("volatile 引用被 deref 成普通值", refLive.staySeconds === 15 && refLive.kinds.failed === true, `${refLive.staySeconds}/${refLive.kinds.failed}`);
refRaw.staySeconds[WRITE](42);
refRaw.theme[WRITE]("dark");
refRaw.kinds.failed[WRITE](false);
check("宿主就地更新引用后立刻生效", refLive.staySeconds === 42 && refLive.theme === "dark" && refLive.kinds.failed === false,
	`${refLive.staySeconds}/${refLive.theme}/${refLive.kinds.failed}`);

const schemasteryDir = process.env.DSH_NUDGE_SCHEMASTERY;
if (schemasteryDir) {
	const z = (await import(pathToFileURL(join(schemasteryDir, "schemastery", "lib", "index.mjs")).href)).default;
	const schema = buildConfigSchema(z);
	const rebuilt = new z(schema.toJSON());
	check("Config 是可重建的 schemastery schema", schema.type === "object" && rebuilt.type === "object", String(schema.type));
	const volatileKeys = Object.entries(rebuilt.dict).filter(([, node]) => node.meta?.volatile).map(([key]) => key);
	check("顶层 volatile 字段齐了", volatileKeys.length === 12, volatileKeys.join(","));
	check("kinds 子字段各自 volatile", Object.values(rebuilt.dict.kinds.dict).every((node) => node.meta?.volatile === true));
	check("popupScript 故意不 volatile", rebuilt.dict.popupScript.meta?.volatile !== true);
	const form = volatileFormNames(rebuilt);
	check("设置界面会收进表单", form.includes("theme") && form.includes("kinds"), form.join(","));
	const [liveResolved] = z.resolve({ staySeconds: 15, theme: "auto" }, schema, {});
	check("解析结果里 volatile 字段是引用", isVolatileRef(liveResolved.staySeconds));
	const schemaLive = liveConfig(liveResolved);
	liveResolved.staySeconds[WRITE](30);
	check("schema 解析出的配置也立刻生效", schemaLive.staySeconds === 30, String(schemaLive.staySeconds));
} else {
	check("schema 断言已跳过（设 DSH_NUDGE_SCHEMASTERY 才跑）", true, "skipped");
}

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

/** 3.5 卡片内容逻辑（主角行 / 摘要 / 多项目标签）---- */
const captured = [];
const probe = new PopupRunner({ ...defaults, mergeWindowMs: 0 }, () => {}, { onStatus: () => {} });
probe.spawnOnce = (payload) => {
	captured.push(payload);
	return true;
};
probe.show([{
	kind: "failed", sessionId: "p1", title: "构建前端", count: 1, at: "21:20", project: "dsh-nudge",
	detail: "vite build 失败：Could not resolve entry\n    at async PluginContainer.resolveId (file.js:1284:15)"
}]);
check("单条卡片不再列清单", captured[0]?.items.length === 0, `items=${captured[0]?.items.length}`);
check("失败卡片抬头是任务名（项目名另起一行且更大）", captured[0]?.headline === "构建前端", JSON.stringify(captured[0]?.headline));
check("失败第二行带淡红底", captured[0]?.headlineTint === "#24E74C3C", JSON.stringify(captured[0]?.headlineTint));
check("失败第二行是精简后的原因", captured[0]?.verdictKind === "失败" && captured[0]?.verdictText === "vite build 失败：Could not resolve entry", JSON.stringify([captured[0]?.verdictKind, captured[0]?.verdictText]));
check("点击复制用的摘要不为空", typeof captured[0]?.summary === "string" && captured[0].summary.includes("构建前端"), JSON.stringify(captured[0]?.summary));

probe.show([{ kind: "completed", sessionId: "p2", title: "写周报", detail: "回合已完成", count: 1, at: "21:21", project: "dsh-nudge" }]);
check("完成卡片抬头是任务名", captured[1]?.headline === "写周报", JSON.stringify(captured[1]?.headline));
check("完成不加底色", captured[1]?.headlineTint === "", JSON.stringify(captured[1]?.headlineTint));
check("完成第二行只写完成、不带冗余原因", captured[1]?.verdictKind === "完成" && captured[1]?.verdictText === "", JSON.stringify([captured[1]?.verdictKind, captured[1]?.verdictText]));

probe.show([{ kind: "needs_choice", sessionId: "p3", title: "部署", detail: "等待你批准：npm i", count: 1, at: "21:22" }]);
check("待选择卡片抬头是任务名、待决定的事在下一行", captured[2]?.headline === "部署" && captured[2]?.verdictKind === "待你选择" && captured[2]?.verdictText === "等待你批准：npm i", JSON.stringify([captured[2]?.headline, captured[2]?.verdictKind, captured[2]?.verdictText]));

probe.show([
	{ kind: "needs_choice", sessionId: "p4", title: "部署", detail: "等待批准", count: 1, at: "21:23", project: "dsh-nudge" },
	{ kind: "completed", sessionId: "p5", title: "跑测试", detail: "回合已完成", count: 1, at: "21:22", project: "web-console" }
]);
check("多条时逐条挂项目标签", captured[3]?.items.map((item) => item.rowProject).join(",") === "dsh-nudge,web-console",
	JSON.stringify(captured[3]?.items.map((item) => item.rowProject)));
check("多条时逐条挂中文 kind 标签",
	captured[3]?.items.map((item) => item.rowKind).join(",") === "待你选择,完成",
	JSON.stringify(captured[3]?.items.map((item) => item.rowKind)));
check("多条时不显示主角行", captured[3]?.headline === "", JSON.stringify(captured[3]?.headline));
check("完成的明细不再重复写在行里", captured[3]?.items[1]?.detail === "", JSON.stringify(captured[3]?.items[1]?.detail));

// 任务名过长：截到 42 字并带省略号，别让 WPF 在第三行中途切字
probe.show([{ kind: "failed", sessionId: "p6", title: "把弹窗脚本里所有硬编码的颜色常量统一抽成一个主题表并保证明暗两种背景都能读清楚同时把窗口缩放时的重排逻辑也理顺", detail: "锚点找不到", count: 1, at: "21:24" }]);
const clipped = captured[4]?.headline ?? "";
check("超长任务名截到 42 字且带省略号", [...clipped].length === 42 && clipped.endsWith("…"), `${[...clipped].length}字 ${JSON.stringify(clipped)}`);

// 停留时长：默认 15 秒，待你选择乘三且下限 30 秒。断言写成具体值，改动默认值时会红，
// 而不是靠「< 20」这种松阈值蒙过去。
check("默认停留 15 秒", DEFAULTS.staySeconds === 15, String(DEFAULTS.staySeconds));
check("完成卡片按基础时长", probe.stayFor({ kind: "completed", items: [] }) === 15, String(probe.stayFor({ kind: "completed", items: [] })));
check("待选择卡片最少停 30 秒", probe.stayFor({ kind: "needs_choice", items: [] }) === 45, String(probe.stayFor({ kind: "needs_choice", items: [] })));
check("条目越多停越久", probe.stayFor({ kind: "completed", items: [{}, {}, {}] }) === 19, String(probe.stayFor({ kind: "completed", items: [{}, {}, {}] })));
probe.dispose();

/** 3.6 createPlugin 事件接线 ---- */
/**
 * 造一个只够 createPlugin 用的 ctx。
 * @param {{questions?: object}} [deps] 可选服务
 * @returns {{ctx: object, handlers: Map<string, Function[]>, disposers: Function[]}} mock 上下文
 */
function makePluginContext(deps = {}) {
	const handlers = new Map();
	const disposers = [];
	const ctx = {
		on(type, handler) {
			handlers.set(type, [...(handlers.get(type) ?? []), handler]);
		},
		get(name) {
			if (name === "approval") return { id: "approval" };
			if (name === "userQuestions") return deps.questions;
			if (name === "sessionTitle") return deps.sessionTitle;
			return undefined;
		},
		effect(setup) {
			const dispose = setup();
			if (typeof dispose === "function") disposers.push(dispose);
		},
		logger: { info() {}, warn() {}, debug() {} }
	};
	return { ctx, handlers, disposers };
}

const wired = [];
const wiredRunner = {
	show(items) {
		wired.push(structuredClone(items));
		return true;
	},
	dispose() {}
};
const questions = {
	ask: async (request) => ({ answers: [{ id: request.questions[0].id, selected: [] }] })
};
const originalAsk = questions.ask;
const { ctx: pluginCtx, handlers, disposers } = makePluginContext({ questions });
const wiredPlugin = createPlugin(pluginCtx, { ...defaults, mergeWindowMs: 0, staySeconds: 5 }, { runner: wiredRunner });
const wiredSession = { header: { id: "wired-session", cwd: "C:/repo/dsh-nudge" } };
const emitOn = (session, type, data) => {
	for (const handler of handlers.get("session/event") ?? []) handler(session, { type, data });
};
const emitSession = (type, data) => emitOn(wiredSession, type, data);
const drain = () => {
	const before = wired.length;
	wiredPlugin.center.flush();
	return wired.length > before ? wired.at(-1) : [];
};

emitSession("session/title", { title: "修构建脚本" });
emitSession("turn/end", { reason: { kind: "completed" } });
let batch = drain();
check("turn/end completed 产生完成提醒", batch.length === 1 && batch[0].kind === "completed", JSON.stringify(batch));
check("会话标题从 session/title 缓存", batch[0]?.title === "修构建脚本", JSON.stringify(batch[0]?.title));
check("项目名取会话 cwd 末段", batch[0]?.project === "dsh-nudge", JSON.stringify(batch[0]?.project));

emitSession("turn/end", { reason: { kind: "error", error: { message: "boom" } } });
batch = drain();
check("turn/end error 产生失败提醒", batch[0]?.kind === "failed" && batch[0]?.detail === "boom", JSON.stringify(batch[0]));

emitSession("turn/end", { reason: { kind: "blocked" } });
batch = drain();
check("turn/end blocked 归为失败而非完成", batch[0]?.kind === "failed" && batch[0]?.detail === "回合被策略拦截", JSON.stringify(batch[0]));

emitSession("turn/end", { reason: { kind: "aborted" } });
check("turn/end aborted 不提醒", drain().length === 0);

emitOn({ header: { id: "child-session", cwd: "C:/repo/dsh-nudge", parentSession: "wired-session", delegationDepth: 1 } }, "turn/end", { reason: { kind: "completed" } });
check("子代理回合不单独提醒", drain().length === 0);

emitSession("tool/result", {
	message: {
		role: "tool",
		source: { kind: "tool", callId: "call-bare" },
		isError: true,
		content: [{ type: "text", text: "Error: permission denied" }]
	}
});
batch = drain();
check("tool/result 的 message.isError 触发失败提醒", batch[0]?.kind === "failed", JSON.stringify(batch[0]));
check("工具失败明细取结果正文", batch[0]?.detail === "工具调用失败：permission denied", JSON.stringify(batch[0]?.detail));

emitSession("tool/result", {
	message: {
		role: "tool",
		source: { kind: "tool", callId: "call-bare" },
		isError: true,
		content: [{ type: "text", text: "Error: permission denied" }]
	}
});
check("同一个 tool callId 只提醒一次", drain().length === 0);

emitSession("tool/result", {
	message: {
		role: "tool",
		source: { kind: "tool", callId: "call-ok" },
		isError: false,
		content: [{ type: "text", text: "ok" }]
	}
});
check("成功的 tool/result 不提醒", drain().length === 0);

const approval = handlers.get("approval/request")?.[0];
check("approval/request 监听器已注册", typeof approval === "function");
let nextCalls = 0;
const outcome = approval?.({
	agent: { id: "wired-session", session: wiredSession },
	toolName: "pwsh",
	reason: "run build",
	displayReason: "Run the build"
}, () => {
	nextCalls += 1;
	return "allowed-once";
});
check("审批放行：next() 被调用且返回值透传", nextCalls === 1 && outcome === "allowed-once", `next=${nextCalls}, outcome=${String(outcome)}`);
batch = drain();
check("审批明细优先用 displayReason", batch[0]?.kind === "needs_choice" && batch[0]?.detail === "Run the build", JSON.stringify(batch[0]?.detail));

approval?.({
	agent: { id: "wired-session", session: wiredSession },
	toolName: "pwsh",
	reason: "run build"
}, () => "allowed-once");
batch = drain();
check("没有 displayReason 时退回 reason", batch[0]?.detail === "run build", JSON.stringify(batch[0]?.detail));

approval?.({
	agent: { id: "wired-session", session: wiredSession },
	toolName: "pwsh"
}, () => "allowed-once");
batch = drain();
check("只有 toolName 时也不丢上下文", batch[0]?.detail === "pwsh", JSON.stringify(batch[0]?.detail));

const askRequest = {
	agent: { id: "wired-session", session: wiredSession },
	questions: [{ id: "q1", header: "部署确认", question: "现在部署吗？" }]
};
const answer = await questions.ask(askRequest);
check("userQuestions.ask 原样转发并返回原结果", answer?.answers?.[0]?.id === "q1", JSON.stringify(answer));
batch = drain();
check("提问提醒使用问题标题", batch[0]?.kind === "needs_choice" && batch[0]?.detail === "部署确认", JSON.stringify(batch[0]?.detail));

for (const dispose of disposers.reverse()) dispose();
check("dispose 后还原 userQuestions.ask", questions.ask === originalAsk);
emitSession("turn/end", { reason: { kind: "completed" } });
check("dispose 后不再产生提醒", drain().length === 0);

const rejectingQuestions = { ask: async () => { throw new Error("ASK_ABORTED"); } };
const rejecting = makePluginContext({ questions: rejectingQuestions });
createPlugin(rejecting.ctx, { ...defaults, mergeWindowMs: 0 }, { runner: wiredRunner });
let rejectionPropagated = false;
try {
	await rejectingQuestions.ask({ agent: { id: "reject-session", session: wiredSession }, questions: [{ id: "q2", question: "继续吗？" }] });
} catch (error) {
	rejectionPropagated = error instanceof Error && error.message === "ASK_ABORTED";
}
check("userQuestions.ask 的 rejection 不被吞掉", rejectionPropagated);
for (const dispose of rejecting.disposers.reverse()) dispose();

// 没有 session/title 事件时，标题应来自 sessionTitle 服务（0.2.1 的 SessionHeader 没有 title）。
const svcEvents = [];
const svcRunner = { show(items) { svcEvents.push(items); return true; }, dispose() {} };
const svc = makePluginContext({
	sessionTitle: { get: (session) => ({ title: session?.header?.id === "svc-session" ? "标题服务会话" : "" }) }
});
const svcPlugin = createPlugin(svc.ctx, { ...defaults, mergeWindowMs: 0 }, { runner: svcRunner });
const svcSession = { header: { id: "svc-session", cwd: "C:/repo/proj" } };
for (const handler of svc.handlers.get("session/event") ?? []) {
	handler(svcSession, { type: "turn/end", data: { reason: { kind: "completed" } } });
}
svcPlugin.center.flush();
check("没有 session/title 事件时走 sessionTitle 服务", svcEvents[0]?.[0]?.title === "标题服务会话", JSON.stringify(svcEvents[0]?.[0]?.title));
for (const dispose of svc.disposers.reverse()) dispose();

// 弹窗 runner 自己抛错时，flush 不能把异常带回事件循环。
const swallowed = [];
const throwingCenter = new AlertCenter(
	{ ...defaults, mergeWindowMs: 0 },
	{ runner: { show() { throw new Error("runner boom"); }, dispose() {} }, log: (level, message) => swallowed.push({ level, message }) }
);
throwingCenter.push("completed", { sessionId: "throw-session" });
let flushThrew = false;
try {
	throwingCenter.flush();
} catch {
	flushThrew = true;
}
check("runner.show 抛错不冒泡到宿主", flushThrew === false && swallowed.some((entry) => entry.level === "warn"), JSON.stringify(swallowed));
throwingCenter.dispose();

// stdout 的一行 JSON 可能被拆成两个 chunk。
const consumed = [];
const consuming = new PopupRunner({ ...defaults }, () => {}, { onStatus: (status) => consumed.push(status) });
consuming.consume('{"type":"sho');
check("半行状态不提前解析", consumed.length === 0);
consuming.consume('wn","count":1}\n');
check("跨 chunk 的状态行能拼回来", consumed[0]?.type === "shown" && consumed[0]?.count === 1, JSON.stringify(consumed));
consuming.dispose();

// 跨零点的排序：00:01 比 23:59 新，不能按 "HH:MM" 字符串排。
let sortedPayload = null;
const sortProbe = new PopupRunner({ ...defaults }, () => {});
sortProbe.spawnOnce = (payload) => { sortedPayload = payload; return true; };
sortProbe.show([
	{ kind: "completed", sessionId: "late", title: "跨零点前", detail: "", at: "23:59", atMs: 1000, count: 1 },
	{ kind: "completed", sessionId: "early", title: "跨零点后", detail: "", at: "00:01", atMs: 2000, count: 1 }
]);
check("跨零点按完整时间戳排序", sortedPayload?.items?.[0]?.title === "跨零点后", JSON.stringify(sortedPayload?.items?.map((item) => item.title)));
sortProbe.dispose();

/** 4. PopupRunner 真起 helper（--no-live 时跳过，CI 上没有交互桌面）---- */
if (noLive) {
	check("真起 helper 段", true, "--no-live 跳过（快照与静态约束仍然覆盖）");
} else {
const statuses = [];
const runner = new PopupRunner({ ...liveDefaults, staySeconds: 6 }, () => {}, { onStatus: (status) => statuses.push(status) });
const delivered = runner.show([{ kind: "needs_choice", sessionId: "session-selftest", title: "自测会话", detail: "等待你选择", at: "21:20", count: 2 }]);
check("PopupRunner.show 投递成功", delivered === true);
const shown = await waitFor(() => statuses.some((status) => status.type === "shown"), 12000);
check("helper 回报 shown", shown, JSON.stringify(statuses));
const shownStatus = statuses.find((status) => status.type === "shown");
if (shownStatus !== undefined) {
	check("卡片在屏幕右下半区", shownStatus.left >= shownStatus.width / 2 && shownStatus.top >= shownStatus.height / 2, `left=${shownStatus.left}, top=${shownStatus.top}, ${shownStatus.width}x${shownStatus.height}`);
	check("卡片计数透传", shownStatus.count === 2, `count=${shownStatus.count}`);
}
const child = runner.child;
runner.dispose();
// 被 kill 的进程 exitCode 为 null、signalCode 为 SIGTERM，两个都要看。
const exited = await waitFor(() => child === null || child.exitCode !== null || child.signalCode !== null, 4000);
check("dispose 后 helper 退出（无孤儿）", exited,
	child === null ? "child=null" : `exitCode=${child.exitCode}, signalCode=${child.signalCode}`);
}

/** 5. 三种状态快照 ---- */
mkdirSync(shotDir, { recursive: true });
const payloads = {
	completed: { kind: "completed", label: "任务完成", accent: "#2ECC71", glyph: "\u2714", count: 1, theme: "dark",
		headline: "写周报",
		headlineTint: "",
		verdictKind: "完成",
		verdictText: "",
		context: "dsh-nudge",
		items: [] },
	needs_choice: { kind: "needs_choice", label: "需要你选择", accent: "#F5A623", glyph: "?", count: 2, theme: "dark",
		verdictKind: "待你选择",
		verdictText: "等待你批准：npm install --production",
		headlineTint: "#24F5A623",
		context: "",
		items: [
			{ kind: "needs_choice", title: "部署到生产", detail: "等待你批准一个操作", at: "21:19", count: 1, rowProject: "dsh-nudge" },
			{ kind: "completed", title: "跑测试", detail: "回合已完成", at: "21:17", count: 1, rowProject: "web-console", rowKind: "完成" }
		] },
	failed: { kind: "failed", label: "执行失败", accent: "#E74C3C", glyph: "\u2716", count: 1, theme: "dark",
		headline: "TypeError: Cannot read property 'stdout' of undefined",
		headlineTint: "#24E74C3C",
		context: "dsh-nudge · 构建前端",
		items: [] },
	// 清单形态：4 条提醒、3 个项目，README 里当「合并后的样子」用，也顺便钉住清单行版式
	multi: { kind: "needs_choice", label: "需要你选择", accent: "#F5A623", glyph: "?", count: 4, theme: "dark",
		headline: "",
		headlineTint: "",
		verdictKind: "",
		verdictText: "",
		context: "",
		items: [
			{ kind: "needs_choice", title: "部署到生产", detail: "等待你批准：npm run deploy", at: "21:19", count: 1, rowProject: "dsh-nudge", rowKind: "待你选择" },
			{ kind: "failed", title: "构建前端", detail: "vite build failed: Could not resolve entry \"src/main.ts\"", at: "21:18", count: 1, rowProject: "web-console", rowKind: "失败" },
			{ kind: "completed", title: "跑测试", detail: "", at: "21:17", count: 1, rowProject: "dsh-nudge", rowKind: "完成" },
			{ kind: "completed", title: "写周报", detail: "", at: "21:15", count: 1, rowProject: "notes", rowKind: "完成" }
		] },
	// 浅色主题：同一张「需要你选择」，只把 payload.theme 换成 light，用来钉住浅色配色与 README 的对照图
	light: { kind: "needs_choice", label: "需要你选择", accent: "#F5A623", glyph: "?", count: 1,
		theme: "light",
		headline: "部署到生产",
		headlineTint: "#24F5A623",
		verdictKind: "待你选择",
		verdictText: "等待你批准：npm run deploy",
		context: "dsh-nudge",
		items: [] }
};

/**
 * 跑一次 snapshot 渲染。
 * @param {string} kind 类型
 * @param {string} out 输出 PNG
 * @returns {Promise<{code: number, out: string}>} 结果
 */
function renderSnapshot(kind, out, width = 0) {
	const b64 = Buffer.from(JSON.stringify(payloads[kind]), "utf8").toString("base64");
	const extra = width > 0 ? ["-SnapshotWidth", String(width)] : [];
	return new Promise((resolve) => {
		const child = spawn("powershell.exe", [
			"-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
			"-File", popupScript, "-Snapshot", out, ...extra, "-PayloadB64", b64
		], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let settled = false;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, out: stdout });
		};
		const timer = setTimeout(() => {
			try { child.kill(); } catch {}
			finish(-1);
		}, 30000);
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.on("error", () => finish(-1));
		child.on("exit", (code) => finish(code ?? -1));
	});
}

const snapshotStats = {};
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
	if (isPng) {
		const stats = pngStats(bytes, rgbOf(payloads[kind].accent));
		snapshotStats[kind] = stats;
		check(`快照 ${kind} 有内容（不是空白图）`, stats.distinct > 20 && stats.text > 50,
			`${stats.distinct} 色 / 亮像素 ${stats.text} / 状态色 ${stats.accent}`);
	}
}

/** 5.5 宽度自适应：窄宽与宽版都要出图，宽度严格跟随 ---- */
const widthStats = {};
for (const width of [300, 520]) {
	const out = join(shotDir, `width-${width}.png`);
	rmSync(out, { force: true });
	const result = await renderSnapshot("needs_choice", out, width);
	const bytes = existsSync(out) ? readFileSync(out) : Buffer.alloc(0);
	const isPng = bytes.length > 8 && bytes.subarray(1, 4).toString() === "PNG";
	const actual = isPng ? bytes.readUInt32BE(16) : 0;
	check(`快照宽度 ${width} 自适应`, result.code === 0 && actual === width + 52, `期望 ${width + 52}, 实际 ${actual}`);
	if (isPng) widthStats[String(width)] = pngStats(bytes, rgbOf("#F5A623"));
}

/**
 * 5.6 与 tools/snapshot-baseline.json 比对 ----
 * 版式一改，尺寸和像素统计一定会变；把「上一版长什么样」固化成基线，
 * 改完忘了同步就红，而不是让 README/VERIFY 里的数字自己漂。
 * 宽高必须完全一致；像素计数留 ±2%（字体抗锯齿在不同机器上会有几个像素出入）。
 */
if (updateBaseline) {
	const baseline = {
		note: "版式基线：宽高必须一致，像素计数允许 ±2%。改版式后跑 `node scripts/selftest.mjs --update-baseline` 重生成。",
		generatedAt: new Date().toISOString(),
		kinds: snapshotStats,
		widths: widthStats
	};
	mkdirSync(dirname(baselineFile), { recursive: true });
	writeFileSync(baselineFile, `${JSON.stringify(baseline, null, "\t")}\n`, "utf8");
	check("基线已重写", existsSync(baselineFile), baselineFile);
} else if (!existsSync(baselineFile)) {
	check("快照基线", true, "tools/snapshot-baseline.json 不存在，跳过像素比对（仓库里应当有）");
} else {
	const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
	for (const [key, expected] of Object.entries(baseline.kinds ?? {})) {
		const actual = snapshotStats[key];
		if (actual === undefined) {
			check(`基线 ${key} 对得上`, false, "本次没有渲染出这张");
			continue;
		}
		const same = actual.width === expected.width && actual.height === expected.height
			&& withinTolerance(actual.distinct, expected.distinct)
			&& withinTolerance(actual.dark, expected.dark)
			&& withinTolerance(actual.text, expected.text)
			&& withinTolerance(actual.accent, expected.accent);
		check(`基线 ${key} 对得上`, same,
			`${actual.width}x${actual.height} 色 ${actual.distinct}/${expected.distinct} 暗 ${actual.dark}/${expected.dark} 亮 ${actual.text}/${expected.text} 状态 ${actual.accent}/${expected.accent}`);
	}
	for (const [key, expected] of Object.entries(baseline.widths ?? {})) {
		const actual = widthStats[key];
		const same = actual !== undefined && actual.width === expected.width && actual.height === expected.height
			&& withinTolerance(actual.distinct, expected.distinct) && withinTolerance(actual.text, expected.text);
		check(`基线宽度 ${key} 对得上`, same,
			actual === undefined ? "没渲染" : `${actual.width}x${actual.height} 色 ${actual.distinct}/${expected.distinct}`);
	}
}

/**
 * 6. 源码静态约束 ----
 * 版式与协议里最容易悄悄回退的东西，用源码断言钉住：脚本必须保持纯 ASCII、
 * 项目名前面不能再出现图标字形、字号阶梯必须是「项目 > 任务 > 原因」，
 * 单卡槽位与剪贴板回报也不能被顺手删掉。这些不需要启动窗口，几毫秒跑完。
 */
const popupSource = readFileSync(popupScript, "utf8");
const popupBytes = readFileSync(popupScript);
check("popup.ps1 保持纯 ASCII", popupBytes.every((byte) => byte < 128),
	`非 ASCII 字节 ${popupBytes.filter((byte) => byte > 127).length} 个`);
check("popup.ps1 不再有图标字形", !popupSource.includes("0xE8B7") && !/[\u{1F300}-\u{1FAFF}]/u.test(popupSource),
	popupSource.includes("0xE8B7") ? "still 0xE8B7" : "clean");
check("项目名走 15.5，任务名走 12.5",
	popupSource.includes("$contextText -Size 15.5") && popupSource.includes("$headlineText -Size 12.5")
		&& popupSource.includes("$rowProject -Size 15"),
	"context/headline/row");
check("清单行的项目名排在任务名前面",
	popupSource.indexOf("$rowProject -Size 15") < popupSource.indexOf("$title = New-Text"),
	"order");
check("单卡槽位与替换事件都在", popupSource.includes("Local\\dsh-nudge-card") && popupSource.includes("Local\\dsh-nudge-replace"),
	"Mutex + Event");
check("点击后回报剪贴板是否写成", popupSource.includes("clipboard = [bool]$script:clipboardOk"), "closed.clipboard");
check("payload 带剪贴板抬头", captured[0]?.clipboardHeader === "DeepSeek Harness · 会话提醒", JSON.stringify(captured[0]?.clipboardHeader));
check("payload 带配色", captured[0]?.theme === "auto", JSON.stringify(captured[0]?.theme));
check("弹窗脚本有深浅两套配色",
	popupSource.includes("function Set-CardTheme") && popupSource.includes("function Resolve-Theme")
		&& popupSource.includes("AppsUseLightTheme") && popupSource.includes("$script:FrameBg"),
	"Set-CardTheme + Resolve-Theme");
check("主题来自 payload，状态行也回报",
	popupSource.includes("$payload.theme") && popupSource.includes("theme = $script:ThemeName"),
	"payload.theme -> shown.theme");

const indexSource = readFileSync(join(root, "lib", "index.js"), "utf8");
check("全屏抑制：shell 查询与前景矩形两道判断都在",
	popupSource.includes("SHQueryUserNotificationState")
		&& popupSource.includes("[switch]$SuppressWhenFullscreen")
		&& popupSource.includes("$script:QuietNotificationStates")
		&& popupSource.includes("function Test-ForegroundFullscreen"),
	"fullscreen guard");
check("全屏抑制开关由宿主按配置传给 helper",
	indexSource.includes('if (this.config.suppressWhenFullscreen) args.push("-SuppressWhenFullscreen")'),
	"spawn args");
check("桌面、任务栏与最大化窗口不算全屏",
	popupSource.includes("$script:ShellWindowClasses") && popupSource.includes("'Progman'")
		&& popupSource.includes("'WorkerW'") && popupSource.includes("IsZoomed($hwnd)")
		&& popupSource.includes("GetShellWindow()"),
	"shell/maximized excluded");
check("调试开关既能用环境变量也能用插件配置",
	indexSource.includes("DSH_NUDGE_DEBUG_PAYLOAD") && indexSource.includes("DSH_NUDGE_DEBUG_FILE")
		&& indexSource.includes("config.debugPayload === true") && indexSource.includes("config.debugFile"),
	"env + config");

/**
 * 7. 单卡互斥与 payload 落盘（--no-live 时跳过）----
 * 同一时刻只留一张卡：A 先占位，B 上来时 A 必须收到 replaced 并退场。
 * 同一段流程顺手验证调试开关：设了 DSH_NUDGE_DEBUG_PAYLOAD 就该把每次
 * payload 追加成一行 JSON，事后能核对「卡片上到底写了什么」。
 */
if (noLive) {
	check("单卡互斥与 payload 落盘段", true, "--no-live 跳过");
} else {
const dumpFile = join(tmpdir(), `dsh-nudge-selftest-${process.pid}.jsonl`);
rmSync(dumpFile, { force: true });
process.env.DSH_NUDGE_DEBUG_PAYLOAD = "1";
process.env.DSH_NUDGE_DEBUG_FILE = dumpFile;
const slotStatusesA = [];
const slotStatusesB = [];
const runnerA = new PopupRunner({ ...liveDefaults, staySeconds: 12 }, () => {}, { onStatus: (status) => slotStatusesA.push(status) });
const runnerB = new PopupRunner({ ...liveDefaults, staySeconds: 2 }, () => {}, { onStatus: (status) => slotStatusesB.push(status) });
runnerA.show([{ kind: "completed", sessionId: "selftest-slot-a", title: "抢卡 A", detail: "先来的那张", at: "10:00", count: 1 }]);
const aShown = await waitFor(() => slotStatusesA.some((status) => status.type === "shown"), 15000);
const aShownStatus = slotStatusesA.find((status) => status.type === "shown");
check("单卡：先来的拿到槽位", aShown && aShownStatus?.slot === "owner", JSON.stringify(aShownStatus ?? null));
const takeoverStart = Date.now();
runnerB.show([{ kind: "completed", sessionId: "selftest-slot-b", title: "抢卡 B", detail: "后来的顶掉上一张", at: "10:01", count: 1 }]);
const bShown = await waitFor(() => slotStatusesB.some((status) => status.type === "shown"), 15000);
const bShownStatus = slotStatusesB.find((status) => status.type === "shown");
check("单卡：后来的标记为 replaced", bShown && bShownStatus?.slot === "replaced", JSON.stringify(bShownStatus ?? null));
const aClosed = await waitFor(() => slotStatusesA.some((status) => status.type === "closed"), 10000);
const aClosedStatus = slotStatusesA.find((status) => status.type === "closed");
check("单卡：上一张收到 replaced 后自己退场", aClosed && aClosedStatus?.reason === "replaced", JSON.stringify(aClosedStatus ?? null));
check("单卡：顶替在 3 秒内完成", Date.now() - takeoverStart < 3000, `${Date.now() - takeoverStart}ms`);
const bClosed = await waitFor(() => slotStatusesB.some((status) => status.type === "closed"), 15000);
check("单卡：新卡按自己的停留时间退场",
	Boolean(bClosed) && slotStatusesB.find((status) => status.type === "closed")?.reason === "timeout",
	JSON.stringify(slotStatusesB.find((status) => status.type === "closed") ?? null));
runnerA.dispose();
runnerB.dispose();
delete process.env.DSH_NUDGE_DEBUG_PAYLOAD;
delete process.env.DSH_NUDGE_DEBUG_FILE;
const dumpLines = existsSync(dumpFile) ? readFileSync(dumpFile, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
check("调试开关把每次 payload 落盘", dumpLines.length === 2, `lines=${dumpLines.length}`);
const dumpTitles = dumpLines.map((line) => {
	try {
		const payload = JSON.parse(line)?.payload ?? {};
		// 单条卡片的标题在 headline 上，多条才在 items[].title 上。
		return payload.headline || payload.items?.[0]?.title || "";
	} catch {
		return "";
	}
});
check("落盘的正是这两张卡", dumpTitles.every((title) => /^抢卡/u.test(title)), JSON.stringify(dumpTitles));
rmSync(dumpFile, { force: true });

// 不想设环境变量的人可以在插件配置里打开同一个开关（debugPayload + debugFile）。
const cfgDumpFile = join(tmpdir(), `dsh-nudge-selftest-cfg-${process.pid}.jsonl`);
rmSync(cfgDumpFile, { force: true });
const runnerC = new PopupRunner(
	{ ...liveDefaults, staySeconds: 1, debugPayload: true, debugFile: cfgDumpFile },
	() => {},
	{ onStatus: () => {} }
);
runnerC.show([{ kind: "completed", sessionId: "selftest-cfg-dump", title: "配置落盘", detail: "由 debugPayload 打开", at: "10:02", count: 1 }]);
await waitFor(() => existsSync(cfgDumpFile), 15000);
runnerC.dispose();
const cfgLines = existsSync(cfgDumpFile) ? readFileSync(cfgDumpFile, "utf8").split("\n").filter((line) => line.trim() !== "") : [];
check("调试开关也能由插件配置打开", cfgLines.length >= 1 && cfgLines[0].includes("配置落盘"), `lines=${cfgLines.length}`);
rmSync(cfgDumpFile, { force: true });
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
