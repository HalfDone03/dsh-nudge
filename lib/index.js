/**
 * dsh-nudge — 会话状态提醒插件（Host 侧）。
 *
 * 会话里「任务完成 / 需要你选择 / 执行失败」时，在桌面右下角弹一张置顶、
 * 不抢焦点的小卡片，点一下回到 DeepSeek Harness。
 *
 * 事件来源（取证见 docs/api-notes.md）：
 *  - ctx.on('session/event')       turn/end（reason.kind: completed|blocked|max-tokens|error|aborted）
 *                                  session/title（会话标题）、tool/result（工具失败）
 *  - ctx.on('approval/request')    等待用户批准（waterfall，必须 return next() 放行）
 *  - ctx.get('userQuestions').ask  ask_user_question 挂起（包装原方法，原样转发）
 *
 * 只依赖 node: 内置模块，不硬性依赖任何 @deepseek-ai/* 包：
 * 既能被 DSH 以 ESM 源码装载，也能在纯 node 下被 scripts/selftest.mjs 驱动。
 * 唯一的例外是 `@deepseek-ai/schemastery`：设置界面只给「带 volatile 字段的
 * schemastery schema」生成表单，所以宿主里能 import 到它就用它生成 Config，
 * 纯 node 下 import 失败则退回手写的 StandardSchema（校验行为一样，只是设置里看不见）。
 *
 * @module dsh-nudge
 */

import { spawn } from "node:child_process";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件名（cordis 实例标识）。 */
export const name = "nudge";

/**
 * 把一段错误压成一行：去掉换行、堆栈尾巴和多余空白，超长截断。
 * 卡片上只放得下一行重点，原始堆栈留在会话里查。
 * @param {unknown} value 原始文本
 * @param {number} [limit] 最多保留的字符数
 * @returns {string} 压缩后的一行
 */
/** 标题行的上限：260 宽（窗口最小宽度）下三行装得下 42 个字，再长就带省略号截断。 */
const TITLE_LIMIT = 42;

function clipTitle(value) {
	const text = condenseText(value, TITLE_LIMIT);
	return text;
}

function condenseText(value, limit = 140) {
	const text = String(value ?? "").replace(/\s+/gu, " ").trim();
	if (text === "") return "";
	// Cut a real stack frame ("at fn (file:12:3)"); prose containing " at " stays.
	const frame = text.search(/\s+at\s+(?:async\s+)?[^\s(]*\s*\(?[^)]*:\d+:\d+/u);
	const head = (frame > 0 ? text.slice(0, frame) : text).trim();
	if (head === "") return "";
	return head.length > limit ? `${head.slice(0, limit - 1)}…` : head;
}

/**
 * 工具失败的一句话明细。
 *
 * `tool/result` 只有 HarnessError 才会把 `error.info` 放进 `data.error`；
 * 普通 Error 的 message 只存在于工具结果消息正文里，因此正文优先，
 * 结构化错误只作兜底。正文通常带 "Error: " 前缀，展示时去掉。
 * @param {any} data `tool/result` 事件体
 * @returns {string} 可直接上卡的明细
 */
function toolFailureDetail(data) {
	const blocks = Array.isArray(data?.message?.content) ? data.message.content : [];
	const text = blocks
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ")
		.replace(/^\s*error:\s*/iu, "")
		.trim();
	if (text !== "") return `工具调用失败：${text}`;
	const error = data?.error ?? {};
	const fallback = error.message ?? error.code ?? error.name ?? data?.name ?? "unknown";
	return `工具调用失败：${String(fallback)}`;
}

/**
 * 失败和待选择各给一层很淡的同色底，让"这条要处理"自己跳出来；完成不加。
 * @param {string} kind 类型
 * @returns {string} 颜色，空串表示不加底
 */
function tintOf(kind) {
	if (kind === "failed") return "#24E74C3C";
	if (kind === "needs_choice") return "#24F5A623";
	return "";
}

/**
 * 只剩一条提醒时，卡片只有一行主角：
 * 失败给错误摘要，待选择给要做的事，完成给任务名（有异常细节时优先给细节）。
 * @param {object} item 提醒条目
 * @returns {{headline: string, tint: string, context: string}} 主角行、底色、说明行
 */
const VERDICT_LABEL = { failed: "失败", needs_choice: "待你选择", completed: "完成" };

/** 这类明细没有信息量（成功本来就等于回合结束），别再占一行。 */
function isRedundantDetail(detail) {
	const text = String(detail ?? "").trim();
	return text === "" || text === "回合已完成";
}

/**
 * 一屏之内先回答"哪个项目"，再回答"哪个任务"，最后才是"成没成、为什么"。
 * 所以 headline 永远是任务名（缺失才退到错误摘要），项目走最上面一行，
 * 成败与原因走最后一行。
 */
function focusOf(item) {
	const kind = item.kind;
	const detail = condenseText(item.detail);
	const title = clipTitle(item.title);
	const project = condenseText(item.project);
	let headline = title;
	if (headline === "") headline = detail === "" ? (project === "" ? "未命名会话" : project) : detail;
	const redundant = detail === "" || detail === "回合已完成";
	const verdictText = kind === "completed" && redundant ? "" : detail;
	return {
		headline,
		tint: tintOf(kind),
		verdictKind: VERDICT_LABEL[kind] ?? "",
		verdictText,
		context: project
	};
}

/** 默认配置；实际配置来自 cordis.patch.yml，缺失字段落回这里。 */
export const DEFAULTS = {
	/** 总开关 */
	enabled: true,
	/** 卡片停留秒数（到点自动消失） */
	staySeconds: 15,
	/** DSH 在前台时是否也弹 */
	showWhenFocused: true,
	/** 前台是全屏应用（游戏 / 放映 / 演示）时不弹：遮罩会打断独占全屏，还会挡住画面 */
	suppressWhenFullscreen: true,
	/** 卡片与屏幕工作区右下角的边距（设备无关单位） */
	margin: 16,
	/** 事件合并窗口（毫秒）：窗口内的多条事件合并成一张卡片并累计计数 */
	mergeWindowMs: 1200,
	/** 一张卡片最多列出的条目数，超出显示 "+N more" */
	maxItems: 8,
	/** 关键工具调用失败是否也算「失败」提醒 */
	alertOnToolError: true,
	/** 静音时间段，`HH:MM-HH:MM`，支持跨零点 */
	muteRanges: [],
	/** 三类提醒各自开关 */
	kinds: { completed: true, needs_choice: true, failed: true },
	/** 卡片配色：`auto` 跟随 Windows 的应用深浅色，也可以固定 `dark` / `light` */
	theme: "auto",
	/** 调试开关：把每次弹出的 payload 追加落盘，便于回放「刚才弹的到底是什么」 */
	debugPayload: false,
	/** 调试落盘文件；留空用 %TEMP% 下的 dsh-nudge-payloads.jsonl */
	debugFile: "",
	/** 预览：卡片常驻不消失，可以拖动、缩放，关掉时把位置和大小记下来 */
	debugPreview: false,
	/** 记住用户拖过/缩过的位置：下次卡片回到那个位置，而不是回右下角 */
	rememberPosition: true,
	/** 位置记忆文件；留空用 %LOCALAPPDATA%\dsh-nudge\placement.json */
	placementFile: "",
	/** 自定义弹窗脚本路径；留空表示用包内 lib/popup.ps1 */
	popupScript: ""
};

/** 三类事件的外观与文案。 */
const KIND_META = {
	completed: { label: "任务完成", accent: "#2ECC71", glyph: "\u2714" },
	needs_choice: { label: "需要你选择", accent: "#F5A623", glyph: "?" },
	failed: { label: "执行失败", accent: "#E74C3C", glyph: "\u2716" }
};

/** 严重度：一张卡片里冲突时，标题取最高的一个。 */
const SEVERITY = { completed: 0, needs_choice: 1, failed: 2 };

/** 允许的配色取值：auto 跟随系统，dark / light 固定。 */
const THEMES = ["auto", "dark", "light"];
const ROW_KIND_LABEL = { completed: "完成", needs_choice: "待你选择", failed: "失败" };

/**
 * cosmokit 的 volatile 引用把自己挂在全局 symbol 上，靠它识别「引用」而不是普通对象。
 * 用 `Symbol.for` 取同一个 key，就不用为了一个判断去依赖 cosmokit。
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * 一个配置值是不是 cordis 的 volatile 引用。
 * @param {unknown} value 配置值
 * @returns {boolean} 是否引用
 */
export function isVolatileRef(value) {
	return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * 把可能带 volatile 引用的配置展开成普通数据。
 *
 * cordis 把标了 `.volatile()` 的字段解析成引用（`{ get() }`，见 cosmokit），
 * 插件拿到的配置里这些字段就不是值而是引用；不展开的话 `Number(ref)` 全是 NaN。
 * @param {unknown} value 配置值
 * @returns {unknown} 展开后的普通数据
 */
function plainValue(value) {
	let current = value;
	// 引用里套引用理论上不存在，加个上限只是不想在异常输入上转圈。
	let guard = 0;
	while (isVolatileRef(current) && guard < 8) {
		current = current.get();
		guard += 1;
	}
	if (Array.isArray(current)) return current.map((item) => plainValue(item));
	if (current !== null && typeof current === "object") {
		return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, plainValue(child)]));
	}
	return current;
}

/**
 * 实时配置视图。
 *
 * cordis 对 `.volatile()` 字段是**就地更新引用**：设置界面存一次，loader 只把值写进
 * 引用里，插件不会被重新 apply。所以不能在 apply 时拍一张快照（以前那样），
 * 否则设置改了要到下次重启才生效。这里返回一个只在读属性时才取值的视图：
 * 每次读都从原始配置（可能已变）重新展开 + 校验，值没变就复用上一次结果。
 * @param {unknown} raw cordis 传进来的（可能已解析成引用的）配置
 * @returns {typeof DEFAULTS} 可当普通配置用的视图
 */
export function liveConfig(raw) {
	let snapshot = normalizeConfig(plainValue(raw));
	let cacheKey = JSON.stringify(plainValue(raw));
	const current = () => {
		let next;
		try {
			next = plainValue(raw);
		} catch {
			return snapshot;
		}
		const nextKey = JSON.stringify(next);
		if (nextKey === cacheKey) return snapshot;
		cacheKey = nextKey;
		try {
			snapshot = normalizeConfig(next);
		} catch {
			// 设置界面写进一个还没通过校验的值（比如手改文件）：继续用上一次能用的配置，
			// 下次读取再试。一次坏输入不该让整个插件在下次弹卡时抛异常。
		}
		return snapshot;
	};
	const view = {};
	for (const field of Object.keys(DEFAULTS)) {
		Object.defineProperty(view, field, {
			enumerable: true,
			get: () => current()[field]
		});
	}
	return view;
}

/**
 * 用 schemastery 生成 `Config`。
 *
 * dsh-settings 的 `describe()` 只收「`Config` 是 schemastery schema、且至少一个字段带
 * `.volatile()`」的插件条目（命名空间就是 entry 的 id，也就是 `nudge`），表单会出现在
 * 「设置 → 插件」。字段默认值一律取自 `DEFAULTS`，避免两处数字各写一份。
 * `popupScript` 故意不标 volatile：它决定跑哪个脚本，属于要重启才敢换的项。
 * @param {any} z schemastery 入口
 * @returns {any} Config schema
 */
export function buildConfigSchema(z) {
	/**
	 * @param {boolean} fallback 默认值
	 * @returns {any} 布尔 schema
	 */
	const bool = (fallback) => z.boolean().default(fallback);
	/**
	 * @param {number} fallback 默认值
	 * @param {number} min 下限
	 * @param {number} max 上限
	 * @returns {any} 数字 schema
	 */
	const num = (fallback, min, max) => z.number().default(fallback).min(min).max(max);
	return z.object({
		enabled: bool(DEFAULTS.enabled).volatile().description("总开关：关掉后一张卡片都不弹"),
		staySeconds: num(DEFAULTS.staySeconds, 1, 600).volatile().description("卡片停留秒数，到点自动消失"),
		showWhenFocused: bool(DEFAULTS.showWhenFocused).volatile().description("DSH 在前台时也弹"),
		suppressWhenFullscreen: bool(DEFAULTS.suppressWhenFullscreen).volatile().description("前台是全屏应用（游戏 / 放映）时不弹"),
		margin: num(DEFAULTS.margin, 0, 400).volatile().description("卡片与工作区右下角的边距"),
		mergeWindowMs: num(DEFAULTS.mergeWindowMs, 0, 60000).volatile().description("事件合并窗口（毫秒）：窗口内的多条合并成一张卡"),
		maxItems: num(DEFAULTS.maxItems, 1, 20).volatile().description("一张卡片最多列几条，超出显示 +N more"),
		alertOnToolError: bool(DEFAULTS.alertOnToolError).volatile().description("工具调用失败也算「执行失败」提醒"),
		muteRanges: z.array(z.string()).default([]).volatile().description("静音时间段，写 HH:MM-HH:MM，可多条，支持跨零点"),
		kinds: z.object({
			completed: bool(DEFAULTS.kinds.completed).volatile().description("任务完成"),
			needs_choice: bool(DEFAULTS.kinds.needs_choice).volatile().description("需要你选择"),
			failed: bool(DEFAULTS.kinds.failed).volatile().description("执行失败")
		}).description("三类提醒各自的开关"),
		theme: z.string().default(DEFAULTS.theme).pattern(/^(auto|dark|light)$/u).volatile().description("auto 跟随系统深浅色，也可以固定 dark / light"),
		debugPayload: bool(DEFAULTS.debugPayload).volatile().description("调试：把每次弹出的 payload 追加落盘"),
		debugFile: z.string().default(DEFAULTS.debugFile).volatile().description("调试落盘路径，留空用 %TEMP%\\dsh-nudge-payloads.jsonl"),
		debugPreview: bool(DEFAULTS.debugPreview).volatile().description("调试：打开后卡片常驻，可以拖动缩放，关掉时记住位置与大小"),
		rememberPosition: bool(DEFAULTS.rememberPosition).volatile().description("记住你拖过或缩过的位置，下次卡片回到那里"),
	placementFile: z.string().default(DEFAULTS.placementFile).volatile().description("位置记忆文件，留空用 %LOCALAPPDATA%\\dsh-nudge\\placement.json"),
	popupScript: z.string().default(DEFAULTS.popupScript).description("自定义弹窗脚本路径，留空用包内 lib/popup.ps1")
	});
}

/**
 * 试着 import 宿主的 schemastery；纯 node 下没有这个包，返回 null 走手写 Config。
 * @returns {Promise<any>} schemastery 入口或 null
 */
async function loadSchemastery() {
	try {
		const mod = await import("@deepseek-ai/schemastery");
		const api = mod?.default ?? mod;
		return typeof api?.object === "function" ? api : null;
	} catch {
		return null;
	}
}

/**
 * 合并并校验配置；非法值抛错（cordis 会把它变成启动期 ValidationError）。
 * @param {unknown} raw 部署配置
 * @returns {typeof DEFAULTS} 完整配置
 */
export function normalizeConfig(raw) {
	if (raw !== undefined && raw !== null && typeof raw !== "object") {
		throw new TypeError("nudge: config must be an object");
	}
	const input = raw ?? {};
	if (input.kinds !== undefined && (input.kinds === null || typeof input.kinds !== "object" || Array.isArray(input.kinds))) {
		throw new TypeError("nudge: kinds must be an object");
	}
	const merged = { ...DEFAULTS, ...input };
	merged.kinds = { ...DEFAULTS.kinds, ...(input.kinds ?? {}) };

	/**
	 * 取一个数字字段并校验区间。
	 * @param {string} key 字段名
	 * @param {number} min 下限
	 * @param {number} max 上限
	 * @returns {number} 合法值
	 */
	const number = (key, min, max) => {
		const value = Number(merged[key]);
		if (!Number.isFinite(value) || value < min || value > max) {
			throw new RangeError(`nudge: ${key} must be a number in [${min}, ${max}], got ${String(merged[key])}`);
		}
		return value;
	};
	merged.staySeconds = number("staySeconds", 1, 600);
	merged.margin = number("margin", 0, 400);
	merged.mergeWindowMs = number("mergeWindowMs", 0, 60000);
	merged.maxItems = Math.round(number("maxItems", 1, 20));

	for (const key of ["enabled", "showWhenFocused", "suppressWhenFullscreen", "alertOnToolError"]) {
		if (typeof merged[key] !== "boolean") throw new TypeError(`nudge: ${key} must be a boolean`);
	}
	for (const key of Object.keys(DEFAULTS.kinds)) {
		if (typeof merged.kinds[key] !== "boolean") throw new TypeError(`nudge: kinds.${key} must be a boolean`);
	}
	if (!Array.isArray(merged.muteRanges)) {
		throw new TypeError('nudge: muteRanges must be an array of "HH:MM-HH:MM" strings');
	}
	for (const range of merged.muteRanges) {
		const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u.exec(String(range).trim());
		if (match === null) {
			throw new TypeError(`nudge: muteRanges entry ${JSON.stringify(range)} is not "HH:MM-HH:MM"`);
		}
		const [fromHour, fromMinute, toHour, toMinute] = match.slice(1).map(Number);
		if (fromHour > 23 || fromMinute > 59 || toHour > 23 || toMinute > 59) {
			throw new TypeError(`nudge: muteRanges entry ${JSON.stringify(range)} has an out-of-range hour/minute`);
		}
	}
	if (typeof merged.rememberPosition !== "boolean") throw new TypeError("nudge: rememberPosition must be a boolean");
	if (typeof merged.placementFile !== "string") throw new TypeError("nudge: placementFile must be a string");
	if (typeof merged.popupScript !== "string") throw new TypeError("nudge: popupScript must be a string");
	if (!THEMES.includes(merged.theme)) {
		throw new TypeError(`nudge: theme must be one of ${THEMES.join(", ")}, got ${JSON.stringify(merged.theme)}`);
	}
	if (typeof merged.debugPayload !== "boolean") throw new TypeError("nudge: debugPayload must be a boolean");
	if (typeof merged.debugFile !== "string") throw new TypeError("nudge: debugFile must be a string");
	if (typeof merged.debugPreview !== "boolean") throw new TypeError("nudge: debugPreview must be a boolean");
	return merged;
}

/**
 * 纯 node 下用的 Config：cordis 只要求 Standard Schema
 * （`runtime.Config["~standard"].validate`），这里手写一个同步校验器。
 * 它没有 `toJSON` / volatile 字段，所以设置界面不会给它生成表单。
 */
const STANDARD_CONFIG = {
	"~standard": {
		version: 1,
		vendor: "dsh-nudge",
		/**
		 * @param {unknown} value 原始配置
		 * @returns {{value: typeof DEFAULTS} | {issues: {message: string, path: string[]}[]}} 结果
		 */
		validate(value) {
			try {
				return { value: normalizeConfig(plainValue(value)) };
			} catch (error) {
				return { issues: [{ message: messageOf(error), path: [] }] };
			}
		}
	}
};

/**
 * 宿主里拿得到 schemastery 就用 schemastery schema（设置界面靠它出表单），
 * 否则退回 `STANDARD_CONFIG`。用顶层 await 是为了拿到同一套解析规则——
 * 静态 import 在纯 node 下会直接让模块求值失败，连自测都跑不起来。
 */
const schemastery = await loadSchemastery();

/**
 * 插件配置 schema。cordis 在 apply 前用它解析并校验配置；
 * 顶层的 volatile/默认值定义见 `buildConfigSchema`。
 */
export const Config = schemastery === null ? STANDARD_CONFIG : buildConfigSchema(schemastery);

/**
 * 判断当前时刻是否落在静音时间段内。
 * @param {string[]} ranges `HH:MM-HH:MM` 列表，支持跨零点
 * @param {Date} [now] 当前时间
 * @returns {boolean} 是否静音
 */
export function inMuteRange(ranges, now = new Date()) {
	const minutes = now.getHours() * 60 + now.getMinutes();
	for (const range of ranges) {
		const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u.exec(String(range).trim());
		if (match === null) continue;
		const from = Number(match[1]) * 60 + Number(match[2]);
		const to = Number(match[3]) * 60 + Number(match[4]);
		if (from === to) continue;
		if (from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to) return true;
	}
	return false;
}

/**
 * 管理弹窗 helper 进程（`powershell.exe -STA -File popup.ps1`）。
 *
 * 每条提醒起一个一次性的 helper：payload 走命令行（base64），窗口到点或点击后
 * 自行退出。刻意不用「常驻进程 + stdin 管道」——实测 Windows PowerShell 5.1
 * 的 [Console]::In 在重定向管道下会把命令压到下一次写入才交付（延迟数秒乃至挂死）。
 */
export class PopupRunner {
	/**
	 * @param {typeof DEFAULTS} config 插件配置
	 * @param {(level: string, message: string) => void} log 日志
	 * @param {{onStatus?: (status: object) => void}} [deps] 测试/诊断注入点
	 */
	constructor(config, log, deps = {}) {
		this.config = config;
		this.log = log;
		this.onStatus = deps.onStatus ?? (() => {});
		/** @type {import('node:child_process').ChildProcess | null} */
		this.child = null;
		this.closed = false;
		this.warned = false;
		/** stdout 可能把一行 JSON 拆成多个 chunk，未收完的半行留在这里。 */
		this.buffer = "";
		/** 当前是不是预览卡（常驻、可以拖动缩放） */
		this.previewing = false;
		/** 预览卡的停止标记文件；非预览时为空串 */
		this.previewStopFile = "";
		/** 上一张预览卡结束的时间，用来给「开关开着但卡片刚被拖掉」留个冷却 */
		this.previewEndedAt = 0;
		this.onProcessExit = () => {
			const live = this.child;
			if (live === null) return;
			try {
				if (live.exitCode === null) live.kill();
			} catch {}
		};
		// DSH 被强杀时的兜底：宿主退出即杀掉 helper，不留孤儿窗口。
		process.once("exit", this.onProcessExit);
	}

	/**
	 * 弹窗脚本的绝对路径（默认取包内 lib/popup.ps1）。
	 * @returns {string} 路径
	 */
	scriptPath() {
		if (this.config.popupScript !== "") return this.config.popupScript;
		return join(dirname(fileURLToPath(import.meta.url)), "popup.ps1");
	}

	/**
	 * 解析 helper 的 stdout 状态行。
	 * @param {string} text 原始输出
	 */
	consume(text) {
		// chunk 边界和换行没有关系：helper 的一行状态可能被拆到两次 data 事件里。
		// 丢掉半行会让坐标/计数静默丢失，所以必须保留尾部再拼下一次。
		this.buffer += String(text);
		const lines = this.buffer.split(/\r?\n/u);
		this.buffer = lines.pop() ?? "";
		if (this.buffer.length > 65536) this.buffer = this.buffer.slice(-65536);
		for (const raw of lines) {
			const line = raw.trim();
			if (line === "") continue;
			let status;
			try {
				status = JSON.parse(line);
			} catch {
				this.log("debug", `popup: ${line}`);
				continue;
			}
			if (status?.type === "error") this.warnOnce(`popup: ${String(status.message)}`);
			this.onStatus(status);
		}
	}

	/**
	 * 只告警一次，避免刷日志。
	 * @param {string} message 文案
	 */
	warnOnce(message) {
		if (this.warned) return;
		this.warned = true;
		this.log("warn", message);
	}

	/**
	 * 展示一批提醒；同一时间只保留一个弹窗（新的一批顶掉旧的）。
	 * @param {{kind: string, sessionId: string, title: string, detail: string, at: string, count: number}[]} items 待展示条目
	 * @returns {boolean} 是否成功投递
	 */
	show(items, options = {}) {
		if (items.length === 0) return false;
		// 卡片内的顺序：先按严重度，再按时间倒序（最新的在最上面）。
		// `atMs` 是 push 时留下的完整时间戳；跨零点时 "00:01" 不能靠字符串排在 "23:59" 后面。
		const severity = (item) => SEVERITY[item.kind] ?? 0;
		const stamp = (item) => (Number.isFinite(item.atMs) ? item.atMs : 0);
		const ordered = [...items].sort(
			(a, b) =>
				severity(b) - severity(a) ||
				stamp(b) - stamp(a) ||
				String(b.at ?? "").localeCompare(String(a.at ?? ""))
		);
		const top = KIND_META[ordered[0].kind] !== undefined ? ordered[0].kind : "completed";
		const meta = KIND_META[top];
		const limit = Math.max(1, Math.round(this.config.maxItems));
		const overflow = Math.max(0, ordered.length - limit);
		// 卡片要能直接看出是哪个项目/哪次会话：只有一个项目时放在抬头下面一行，
		// 出现多个项目时逐条挂在各自标题前面。
		const projects = [
			...new Set(ordered.map((item) => item.project).filter((value) => typeof value === 'string' && value !== ''))
		];
		// 单条：只留一行主角 + 一行项目说明；多条：抬头 + 清单。
		const single = ordered.length === 1 ? ordered[0] : null;
		const focus = single === null
			? { headline: "", tint: "", context: projects.length === 1 ? projects[0] : "" }
			: focusOf(single);
		const payload = {
			kind: top,
			label: meta.label,
			accent: meta.accent,
			glyph: meta.glyph,
			count: ordered.reduce((acc, item) => acc + Math.max(1, item.count), 0),
			items: single === null
				? ordered.slice(0, limit).map((item) => ({
						...item,
						title: clipTitle(item.title),
						// "回合已完成" 这种话在行里是废字：右侧已经写了「完成」。
						detail: isRedundantDetail(item.detail) ? "" : condenseText(item.detail),
						rowProject: item.project ?? '',
						rowKind: ROW_KIND_LABEL[item.kind] ?? ""
					}))
				: [],
			headline: focus.headline,
			headlineTint: focus.tint,
			verdictKind: focus.verdictKind,
			verdictText: focus.verdictText,
			context: focus.context,
			// 单条卡片不再列清单，点击时复制这段扁平摘要。只取前 20 条：
			// 摘要要随命令行参数一起传给 helper，不能无上限增长。
			summary: ordered
				.slice(0, 20)
				.map((item) => {
					const name = condenseText(item.title);
					const detail = condenseText(item.detail);
					const prefix = typeof item.project === 'string' && item.project !== '' ? `[${item.project}] ` : "";
					return detail === "" || detail === name ? `${prefix}${name}` : `${prefix}${name}：${detail}`;
				})
				.join(" | ") + (ordered.length > 20 ? ` | 还有 ${ordered.length - 20} 条` : ""),
			overflow,
			// 卡片上的说明文字由这里给出：popup.ps1 保持纯 ASCII 脚本。
			more: overflow > 0 ? `还有 ${overflow} 条未展开` : "",
			footer: "点击卡片回到 DeepSeek Harness",
			// 点击卡片时写进剪贴板的第一行。popup.ps1 保持纯 ASCII，中文只能从 payload 下发。
			clipboardHeader: "DeepSeek Harness · 会话提醒",
			// 配色：auto 由 popup.ps1 去读 Windows 的应用深浅色设置，dark/light 直接定死。
			theme: this.config.theme,
		rememberPosition: this.config.rememberPosition,
		placementFile: this.config.placementFile,
			at: ordered[0].at ?? ""
		};
		return this.spawnOnce(payload, options);
	}

	/**
	 * 为一批提醒起一个一次性 helper 进程。
	 * @param {object} payload 卡片数据
	 * @returns {boolean} 是否成功投递
	 */
	/**
	 * 一批提醒该停留多久：条目越多越久；「需要你选择」是要你动手的，给三倍且不少于 30 秒。
	 * @param {object} payload 卡片数据
	 * @returns {number} 秒
	 */
	stayFor(payload) {
		const rows = Array.isArray(payload?.items) ? payload.items.length : 0;
		const base = this.config.staySeconds + 2 * Math.max(0, rows - 1);
		return Math.round(payload?.kind === "needs_choice" ? Math.max(30, base * 3) : base);
	}

	spawnOnce(payload, options = {}) {
		if (this.closed) return false;
		const preview = options.preview === true;
		const previous = this.child;
		this.child = null;
		this.buffer = "";
		this.terminate(previous);
		const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		const staySeconds = this.stayFor(payload);
		const args = [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-STA",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			this.scriptPath(),
			"-PayloadB64",
			b64,
			"-StaySeconds",
			String(staySeconds),
			"-Margin",
			String(Math.round(this.config.margin)),
			"-DsProcess",
			dsProcessName()
		];
		if (!this.config.showWhenFocused) args.push("-SuppressWhenForeground");
		if (this.config.suppressWhenFullscreen) args.push("-SuppressWhenFullscreen");
		if (preview) {
			// 预览卡不自己收场：宿主写一个 stop 文件，卡片看到就关窗并把位置尺寸落盘。
			this.previewStopFile = join(tmpdir(), `dsh-nudge-preview-${process.pid}.txt`);
			try {
				rmSync(this.previewStopFile, { force: true });
			} catch {}
			args.push("-Preview", "-StopFile", this.previewStopFile);
			this.previewing = true;
		}
		debugPayload(payload, this.log, this.config);
		let child;
		try {
			child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			this.warnOnce(`popup spawn failed: ${messageOf(error)}`);
			return false;
		}
		child.on("error", (error) => {
			this.warnOnce(`popup unavailable: ${messageOf(error)}`);
			if (this.child === child) this.child = null;
		});
		child.on("exit", () => {
			if (this.child === child) this.child = null;
			if (preview) {
				// 卡片已经关掉：清掉标记，并记下时间，避免开关还开着时立刻又弹一张。
				this.previewing = false;
				this.previewEndedAt = Date.now();
				this.previewStopFile = "";
			}
		});
		child.stdout?.on("data", (chunk) => {
			if (this.child === child) this.consume(String(chunk));
		});
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text !== "") this.log("debug", `popup stderr: ${text}`);
		});
		this.child = child;
		return true;
	}

	/**
	 * 这个 runner 现在显示的是不是预览卡。
	 * @returns {boolean} true 表示卡片常驻中
	 */
	isPreviewing() {
		return this.previewing;
	}

	/**
	 * 让预览卡自己收场：写个停止标记，卡片 250ms 内看到就关窗，关之前会把
	 * 位置和大小存进 placement 文件。返回后并不等它真的退出。
	 * @returns {boolean} 是否有卡片在收
	 */
	stopPreview() {
		if (!this.previewing) return false;
		const target = this.previewStopFile;
		this.previewing = false;
		if (target === "") return false;
		try {
			writeFileSync(target, "stop", "utf8");
		} catch (error) {
			this.log("warn", `nudge: preview stop failed: ${messageOf(error)}`);
			return false;
		}
		return true;
	}

	/**
	 * 结束一个 helper 进程（含其子进程）。
	 *
	 * Windows 上 `child.kill()` 偶尔不能立刻带走进程树，因此补一刀
	 * `taskkill /T /F`；两者都失败也只吞掉错误，绝不影响宿主。
	 * @param {import("node:child_process").ChildProcess | null} child 进程句柄
	 */
	terminate(child) {
		if (child === null || child.exitCode !== null) return;
		const pid = child.pid;
		try {
			child.kill();
		} catch {}
		if (typeof pid !== "number") return;
		const timer = setTimeout(() => {
			if (child.exitCode !== null) return;
			try {
				spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
			} catch {}
		}, 300);
		timer.unref?.();
	}

	/** 关闭 helper；幂等，且保证不留孤儿进程。 */
	dispose() {
		this.closed = true;
		this.buffer = "";
		process.removeListener("exit", this.onProcessExit);
		const child = this.child;
		this.child = null;
		this.terminate(child);
	}
}

/**
 * 提醒中心：收集事件、去重合并、按窗口批量投递。
 */
export class AlertCenter {
	/**
	 * @param {typeof DEFAULTS} config 插件配置
	 * @param {{log?: (level: string, message: string) => void, runner?: object, now?: () => Date}} [deps] 注入点（测试用）
	 */
	constructor(config, deps = {}) {
		this.config = config;
		this.log = deps.log ?? (() => {});
		// onStatus 必须透传给 PopupRunner，否则 createPlugin 注入的状态回调会被丢掉。
		this.runner = deps.runner ?? new PopupRunner(config, this.log, { onStatus: deps.onStatus });
		this.clock = deps.now ?? (() => new Date());
		/** @type {Map<string, object>} */
		this.pending = new Map();
		this.timer = null;
		this.disposed = false;
		/** 最近一次投递的条目，点击/日志可回读 */
		this.lastShown = [];
	}

	/**
	 * 记录一条提醒。
	 * @param {'completed'|'needs_choice'|'failed'} kind 类型
	 * @param {{sessionId?: string, title?: string, detail?: string, project?: string}} [detail] 内容
	 * @returns {boolean} 是否被接受
	 */
	push(kind, detail = {}) {
		if (this.disposed) return false;
		if (!this.config.enabled) return false;
		if (this.config.kinds?.[kind] !== true) return false;
		const now = this.clock();
		if (inMuteRange(this.config.muteRanges, now)) return false;
		const sessionId = detail.sessionId ?? "unknown";
		const key = `${kind}|${sessionId}`;
		const at = this.formatTime(now);
		const atMs = now.getTime();
		const existing = this.pending.get(key);
		if (existing !== undefined) {
			existing.count += 1;
			existing.at = at;
			existing.atMs = atMs;
			existing.detail = detail.detail ?? existing.detail;
			existing.project = detail.project ?? existing.project;
		} else {
			this.pending.set(key, {
				kind,
				sessionId,
				title: detail.title ?? String(sessionId).slice(0, 8),
				project: detail.project ?? "",
				detail: detail.detail ?? "",
				at,
				atMs,
				count: 1
			});
		}
		this.schedule();
		return true;
	}

	/**
	 * 时间格式化成 HH:MM。
	 * @param {Date} date 时间
	 * @returns {string} 时间串
	 */
	formatTime(date) {
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	/**
	 * 当前时间，格式 HH:MM。
	 * @returns {string} 时间串
	 */
	time() {
		return this.formatTime(this.clock());
	}

	/** 合并窗口到期后统一投递一次。 */
	schedule() {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, Math.max(0, this.config.mergeWindowMs));
		this.timer.unref?.();
	}

	/**
	 * 立即投递当前全部提醒。
	 * @returns {number} 投递条数
	 */
	flush() {
		// 手动 flush 或定时器到期都从这里走；先把挂着的定时器取消，
		// 否则紧接着 push 的新条目会被旧定时器提前投递。
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.size === 0) return 0;
		const items = [...this.pending.values()].sort((a, b) => (SEVERITY[b.kind] ?? 0) - (SEVERITY[a.kind] ?? 0));
		this.pending.clear();
		this.lastShown = items;
		// 弹窗失败不能把插件（乃至宿主的 turn）带崩；这里吞掉并记一条 warn。
		try {
			this.runner.show(items);
		} catch (error) {
			this.log("warn", `nudge: popup show failed: ${messageOf(error)}`);
		}
		return items.length;
	}

	/** 释放资源：清定时器 + 关弹窗。 */
	dispose() {
		this.disposed = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.pending.clear();
		this.runner.dispose();
	}
}

/**
 * 挂载插件：注册事件钩子，返回可手动释放的句柄（测试用）。
 * @param {any} ctx cordis 上下文
 * @param {object} rawConfig 部署配置
 * @param {{onStatus?: (status: object) => void, runner?: object, now?: () => Date}} [deps] 注入点
 * @returns {{center: AlertCenter, dispose: () => void}} 句柄
 */
export function createPlugin(ctx, rawConfig, deps = {}) {
	// 用实时视图而不是快照：设置界面改的 volatile 字段是就地生效的，插件不会重新 apply。
	const config = liveConfig(rawConfig);
	const log = makeLog(ctx);
	// nudge 自带设置页（浏览器半身 client.js 注册的「设置 → 提醒弹窗」），
	// 所以告诉设置服务别在「插件」页再自动生成一份重复表单。拿不到设置服务
	// （旧宿主、纯 node 自测）时静默跳过。
	if (typeof ctx.inject === "function" && ctx.fiber !== undefined) {
		ctx.inject(["settings"], (child) => {
			child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
		});
	}
	// 卡片是 powershell.exe + WPF 画的，插件只处理 Windows。package.json 的 os 字段
	// 只在安装期生效，开发态或容器里跑 selftest / 打包脚本时照样会被加载，所以这里
	// 直接不注册监听：否则每个回合都会 spawn 失败一次并刷一条 warn。
	if (process.platform !== "win32") {
		log("info", `nudge: 跳过 -- 只支持 Windows 通知（当前 ${process.platform}）`);
		return { center: null, dispose() {} };
	}
	const center = new AlertCenter(config, { log, onStatus: deps.onStatus, runner: deps.runner, now: deps.now });
	/** 预览开关的轮询句柄；开起来之后一直跑，直到插件卸载 */
	let previewWatch = null;
	const startPreviewWatch = () => {
		if (previewWatch !== null) return;
		previewWatch = setInterval(() => {
			try {
				const wants = config.debugPreview === true;
				const running = center.runner.isPreviewing?.() === true;
				if (wants && !running) {
					// 刚被关掉（或者刚手动拖走）就等两秒，否则开关还开着时会连弹。
					if (Date.now() - (center.runner.previewEndedAt ?? 0) < 3000) return;
					center.runner.show(
						[
							{
								kind: "completed",
								sessionId: "preview",
								title: "调试预览",
								detail: "拖动或缩放这张卡，关掉开关后位置会记住",
								at: "",
								count: 1
							}
						],
						{ preview: true }
					);
				} else if (!wants && running) {
					center.runner.stopPreview?.();
				}
			} catch (error) {
				log("warn", `nudge: preview watch failed: ${messageOf(error)}`);
			}
		}, 1000);
		previewWatch.unref?.();
	};
	startPreviewWatch();
	/** @type {Map<string, string>} 会话标题缓存 */
	const titles = new Map();
	/** @type {Set<string>} 已上报失败的工具调用，避免重复 */
	const reportedToolCalls = new Set();

	/**
	 * 项目名：取会话工作目录的最后一段。卡片只需要一个能认出来的短名字，
	 * 不把完整路径带进弹窗。
	 * @param {any} session 会话对象
	 * @returns {string} 项目名
	 */
	const projectOf = (session) => {
		const cwd = session?.header?.cwd;
		if (typeof cwd !== 'string' || cwd === '') return '';
		const parts = cwd.split(/[\\/]+/).filter((part) => part !== '');
		return parts.length > 0 ? parts[parts.length - 1] : '';
	};

	const titleOf = (session, sessionId) => {
		const id = sessionId ?? session?.header?.id ?? session?.id ?? "unknown";
		const cached = titles.get(id);
		if (cached !== undefined && cached !== "") return cached;
		// 0.2.1 的 SessionHeader 没有 title 字段；标题由 sessionTitle 服务折叠事件得出。
		// 服务是可选依赖，且可能晚于本插件就绪，所以在需要时再取，不能 apply 时缓存 undefined。
		let live = "";
		try {
			live = ctx.get("sessionTitle")?.get?.(session)?.title ?? "";
		} catch {}
		if (typeof live === "string" && live !== "") {
			if (titles.size > 400) titles.clear();
			titles.set(id, live);
			return live;
		}
		const inline = session?.header?.title;
		if (typeof inline === "string" && inline !== "") return inline;
		return String(id).slice(0, 8);
	};

	ctx.on("session/event", (session, raw) => {
		const type = raw?.type;
		const data = raw?.data ?? {};
		const header = session?.header;
		// 子代理的回合/工具错误会在父会话里汇总；单独弹一张只会制造噪音。
		if (header?.parentSession != null || Number(header?.delegationDepth) > 0) return;
		const sessionId = header?.id ?? "unknown";

		if (type === "session/title") {
			if (typeof data.title === "string" && data.title !== "") {
				// 标题缓存只用于显示，旧值没有价值：超过上限就整体丢掉，避免长期运行后无限增长。
				if (titles.size > 400) titles.clear();
				titles.set(sessionId, data.title);
			}
			return;
		}

		if (type === "tool/result" && config.alertOnToolError) {
			const callId = data?.message?.source?.callId ?? data?.callId;
			// 失败标记在工具结果消息上；data.error 只在 HarnessError 时出现，
			// 不能拿它当唯一判据，否则普通工具失败会全部漏报。
			const failed = data?.message?.isError === true || data?.error !== undefined || data?.isError === true;
			if (failed && typeof callId === "string" && !reportedToolCalls.has(callId)) {
				if (reportedToolCalls.size > 400) reportedToolCalls.clear();
				reportedToolCalls.add(callId);
				center.push("failed", {
					sessionId,
					title: titleOf(session, sessionId),
					project: projectOf(session),
					detail: toolFailureDetail(data)
				});
			}
			return;
		}

		if (type !== "turn/end") return;
		const reason = data.reason ?? {};
		if (reason.kind === "error") {
			const error = reason.error ?? reason.failure ?? {};
			center.push("failed", {
				sessionId,
				title: titleOf(session, sessionId),
				project: projectOf(session),
				detail: String(error.message ?? error.code ?? "回合异常结束")
			});
			return;
		}
		if (reason.kind === "aborted") return;
		if (reason.kind === "blocked") {
			// blocked 是「本回合没有执行」：归档会话、过期 goal 等。它不是完成，
			// 也不一定需要用户立刻选择，用失败色比绿色完成更接近事实。
			center.push("failed", {
				sessionId,
				title: titleOf(session, sessionId),
				project: projectOf(session),
				detail: "回合被策略拦截"
			});
			return;
		}
		let detail = "回合已完成";
		if (reason.kind === "max-tokens") detail = "输出被长度上限截断";
		center.push("completed", {
			sessionId,
			title: titleOf(session, sessionId),
			project: projectOf(session),
			detail
		});
	});

	if (ctx.get("approval") !== undefined) {
		ctx.on("approval/request", (request, next) => {
			try {
				center.push("needs_choice", {
					sessionId: request?.agent?.id ?? "unknown",
					title: titleOf(request?.agent?.session, request?.agent?.id),
					project: projectOf(request?.agent?.session),
					// ApprovalRequest 的字段是 displayReason / reason / toolName，
					// 没有 command / title / description；旧字段保留给自定义渠道。
					detail: String(
						request?.displayReason ??
							request?.reason ??
							request?.title ??
							request?.command ??
							request?.description ??
							request?.toolName ??
							"等待你批准一个操作"
					)
				});
			} catch {}
			// next 不是函数时返回 undefined 也能让审批链继续走；直接 next() 会抛 TypeError，
			// 那等于把用户的审批流程砸在弹窗插件手里。
			return typeof next === "function" ? next() : undefined;
		});
	}

	const questions = ctx.get("userQuestions");
	if (questions !== undefined && typeof questions.ask === "function" && !questions.__sessionAlertPatched) {
		const original = questions.ask;
		const forward = original.bind(questions);
		const patched = async (request) => {
			try {
				const first = Array.isArray(request?.questions) ? request.questions[0] : request?.questions;
				center.push("needs_choice", {
					sessionId: request?.agent?.id ?? "unknown",
					title: titleOf(request?.agent?.session, request?.agent?.id),
					project: projectOf(request?.agent?.session),
					detail: String(first?.header ?? first?.question ?? first?.title ?? "等待你回答问题")
				});
			} catch {}
			return forward(request);
		};
		questions.ask = patched;
		Object.defineProperty(questions, "__sessionAlertPatched", { value: true, configurable: true });
		ctx.effect?.(() => () => {
			// 还原成原函数而不是 bind 后的副本：否则服务对象上会永久留下一个
			// 绑定旧实现的 own property，其他插件再包装时无法干净卸载。
			if (questions.ask === patched) questions.ask = original;
			delete questions.__sessionAlertPatched;
		});
	}

	const dispose = () => {
		if (previewWatch !== null) {
			clearInterval(previewWatch);
			previewWatch = null;
		}
		try {
			center.runner.stopPreview?.();
		} catch {}
		center.dispose();
	};
	ctx.effect?.(() => dispose);

	return { center, dispose };
}

/**
 * cordis 插件入口。
 * @param {any} ctx cordis 上下文
 * @param {object} rawConfig 部署配置
 */
export function apply(ctx, rawConfig) {
	createPlugin(ctx, rawConfig);
}

/**
 * 取宿主进程名，供 helper 聚焦窗口用。
 * @returns {string} 进程名（不含 .exe）
 */
function dsProcessName() {
	const base = process.execPath.split(/[\\/]/u).pop() ?? "";
	const stem = base.replace(/\.exe$/iu, "");
	// DSH 的 Host 是 Electron 的子进程（ELECTRON_RUN_AS_NODE），此时按产品名找窗口。
	if (stem === "" || /^(node|electron)$/iu.test(stem)) return "DeepSeek Harness";
	return stem;
}

/**
 * 构造一个 `(level, message)` 日志函数。
 * @param {any} ctx cordis 上下文
 * @returns {(level: string, message: string) => void} 日志函数
 */
function makeLog(ctx) {
	let logger;
	try {
		const base = ctx?.logger;
		logger = typeof base === "function" ? base.call(ctx, name) : base;
	} catch {
		logger = undefined;
	}
	return (level, message) => {
		const sink = logger?.[level] ?? logger?.info;
		if (typeof sink === "function") {
			try {
				sink.call(logger, message);
				return;
			} catch {}
		}
		if (level === "warn" || level === "error") console.warn(`[${name}] ${message}`);
	};
}

/**
 * 调试用：把每次要弹的 payload 追加成一行 JSON，便于事后核对「卡片上到底写了什么」。
 *
 * 只有设置了环境变量 `DSH_NUDGE_DEBUG_PAYLOAD`（任意非空值）才会动磁盘，
 * 落盘路径用 `DSH_NUDGE_DEBUG_FILE` 覆盖，默认是系统临时目录下的
 * `dsh-nudge-payloads.jsonl`。任何写入失败都只留一条 debug 日志，绝不影响弹卡。
 * @param {object} payload 卡片数据
 * @param {(level: string, message: string) => void} log 日志函数
 */
function debugPayload(payload, log, config = {}) {
	// 插件配置（debugPayload / debugFile）与环境变量都能打开；配置里写了路径就用配置的。
	const on = config.debugPayload === true || Boolean(process.env.DSH_NUDGE_DEBUG_PAYLOAD);
	if (!on) return;
	const configured = typeof config.debugFile === "string" ? config.debugFile.trim() : "";
	const file = configured !== ""
		? configured
		: process.env.DSH_NUDGE_DEBUG_FILE || join(tmpdir(), "dsh-nudge-payloads.jsonl");
	try {
		const line = JSON.stringify({ at: new Date().toISOString(), payload });
		appendFileSync(file, `${line}\n`, "utf8");
	} catch (error) {
		log("debug", `payload dump failed: ${messageOf(error)}`);
	}
}

/**
 * @param {unknown} error 任意异常
 * @returns {string} 可读消息
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
