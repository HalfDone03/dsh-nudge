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
 * 只依赖 node: 内置模块，不 import 任何 @deepseek-ai/* 包：
 * 既能被 DSH 以 ESM 源码装载，也能在纯 node 下被 scripts/selftest.mjs 驱动。
 *
 * @module dsh-nudge
 */

import { spawn } from "node:child_process";
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

/**
 * 一屏之内先回答"哪个任务/项目"，再回答"成没成、为什么"。
 * 所以 headline 永远是任务名（缺失才退到错误摘要），
 * 成败与原因走第二行，项目走第三行。
 */
function focusOf(item) {
	const kind = item.kind;
	const detail = condenseText(item.detail);
	const title = condenseText(item.title);
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
	staySeconds: 8,
	/** DSH 在前台时是否也弹 */
	showWhenFocused: true,
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
const ROW_KIND_LABEL = { completed: "完成", needs_choice: "待批准", failed: "失败" };

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

	for (const key of ["enabled", "showWhenFocused", "alertOnToolError"]) {
		if (typeof merged[key] !== "boolean") throw new TypeError(`nudge: ${key} must be a boolean`);
	}
	for (const key of Object.keys(DEFAULTS.kinds)) {
		if (typeof merged.kinds[key] !== "boolean") throw new TypeError(`nudge: kinds.${key} must be a boolean`);
	}
	if (!Array.isArray(merged.muteRanges)) {
		throw new TypeError('nudge: muteRanges must be an array of "HH:MM-HH:MM" strings');
	}
	for (const range of merged.muteRanges) {
		if (!/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u.test(String(range).trim())) {
			throw new TypeError(`nudge: muteRanges entry ${JSON.stringify(range)} is not "HH:MM-HH:MM"`);
		}
	}
	if (typeof merged.popupScript !== "string") throw new TypeError("nudge: popupScript must be a string");
	return merged;
}

/**
 * cordis Config 走 Standard Schema（`runtime.Config["~standard"].validate`），
 * 不必依赖 schemastery，这里手写一个同步校验器。
 */
export const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-nudge",
		/**
		 * @param {unknown} value 原始配置
		 * @returns {{value: typeof DEFAULTS} | {issues: {message: string, path: string[]}[]}} 结果
		 */
		validate(value) {
			try {
				return { value: normalizeConfig(value) };
			} catch (error) {
				return { issues: [{ message: messageOf(error), path: [] }] };
			}
		}
	}
};

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
		for (const raw of text.split(/\r?\n/u)) {
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
	show(items) {
		if (items.length === 0) return false;
		// 卡片内的顺序：先按严重度，再按时间倒序（最新的在最上面）。
		const ordered = [...items].sort(
			(a, b) => SEVERITY[b.kind] - SEVERITY[a.kind] || String(b.at ?? "").localeCompare(String(a.at ?? ""))
		);
		const top = ordered[0].kind;
		const limit = Math.max(1, Math.round(this.config.maxItems));
		const overflow = Math.max(0, ordered.length - limit);
		// 卡片要能直接看出是哪个项目/哪次会话：只有一个项目时放在抬头下面一行，
		// 出现多个项目时逐条挂在各自标题前面。
		const projects = [
			...new Set(ordered.map((item) => item.project).filter((value) => typeof value === 'string' && value !== ''))
		];
		const multiProject = projects.length > 1;
		// 单条：只留一行主角 + 一行项目说明；多条：抬头 + 清单。
		const single = ordered.length === 1 ? ordered[0] : null;
		const focus = single === null
			? { headline: "", tint: "", context: projects.length === 1 ? projects[0] : "" }
			: focusOf(single);
		const payload = {
			kind: top,
			label: KIND_META[top].label,
			accent: KIND_META[top].accent,
			glyph: KIND_META[top].glyph,
			count: ordered.reduce((acc, item) => acc + Math.max(1, item.count), 0),
			items: single === null
				? ordered.slice(0, limit).map((item) => ({
						...item,
						detail: condenseText(item.detail),
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
			at: ordered[0].at ?? ""
		};
		return this.spawnOnce(payload);
	}

	/**
	 * 为一批提醒起一个一次性 helper 进程。
	 * @param {object} payload 卡片数据
	 * @returns {boolean} 是否成功投递
	 */
	spawnOnce(payload) {
		if (this.closed) return false;
		const previous = this.child;
		this.child = null;
		this.terminate(previous);
		const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		// 条目越多停留越久，避免没看完就消失。
		const rows = Array.isArray(payload.items) ? payload.items.length : 0;
		const staySeconds = Math.round(this.config.staySeconds + 2 * Math.max(0, rows - 1));
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
		});
		child.stdout?.on("data", (chunk) => this.consume(String(chunk)));
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text !== "") this.log("debug", `popup stderr: ${text}`);
		});
		this.child = child;
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
		if (!this.config.kinds[kind]) return false;
		if (inMuteRange(this.config.muteRanges, this.clock())) return false;
		const sessionId = detail.sessionId ?? "unknown";
		const key = `${kind}|${sessionId}`;
		const existing = this.pending.get(key);
		if (existing !== undefined) {
			existing.count += 1;
			existing.at = this.time();
			existing.detail = detail.detail ?? existing.detail;
			existing.project = detail.project ?? existing.project;
		} else {
			this.pending.set(key, {
				kind,
				sessionId,
				title: detail.title ?? String(sessionId).slice(0, 8),
				project: detail.project ?? "",
				detail: detail.detail ?? "",
				at: this.time(),
				count: 1
			});
		}
		this.schedule();
		return true;
	}

	/**
	 * 当前时间，格式 HH:MM。
	 * @returns {string} 时间串
	 */
	time() {
		const date = this.clock();
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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
		if (this.pending.size === 0) return 0;
		const items = [...this.pending.values()].sort((a, b) => SEVERITY[b.kind] - SEVERITY[a.kind]);
		this.pending.clear();
		this.lastShown = items;
		this.runner.show(items);
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
	const config = normalizeConfig(rawConfig);
	const log = makeLog(ctx);
	const center = new AlertCenter(config, { log, onStatus: deps.onStatus, runner: deps.runner, now: deps.now });
	/** @type {Map<string, string>} 会话标题缓存 */
	const titles = new Map();
	/** @type {Set<string>} 已上报失败的工具调用，避免重复 */
	const reportedToolCalls = new Set();

	/**
	 * 会话标题：优先标题事件，其次会话头，最后 sessionId 前缀。
	 * @param {any} session 会话对象
	 * @param {string} [sessionId] 会话 id
	 * @returns {string} 标题
	 */
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
		const inline = session?.header?.title;
		if (typeof inline === "string" && inline !== "") return inline;
		return String(id).slice(0, 8);
	};

	ctx.on("session/event", (session, raw) => {
		const type = raw?.type;
		const data = raw?.data ?? {};
		const sessionId = session?.header?.id ?? "unknown";

		if (type === "session/title") {
			if (typeof data.title === "string" && data.title !== "") titles.set(sessionId, data.title);
			return;
		}

		if (type === "tool/result" && config.alertOnToolError) {
			const callId = data?.message?.source?.callId ?? data?.callId;
			const failed = data?.error !== undefined || data?.isError === true;
			if (failed && typeof callId === "string" && !reportedToolCalls.has(callId)) {
				reportedToolCalls.add(callId);
				const error = data.error ?? {};
				center.push("failed", {
					sessionId,
					title: titleOf(session, sessionId),
				project: projectOf(session),
					detail: `工具调用失败：${String(error.message ?? error.code ?? data?.name ?? "unknown")}`
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
		let detail = "回合已完成";
		if (reason.kind === "max-tokens") detail = "输出被长度上限截断";
		else if (reason.kind === "blocked") detail = "回合被策略拦截";
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
					detail: String(request?.command ?? request?.title ?? request?.description ?? "等待你批准一个操作")
				});
			} catch {}
			return next();
		});
	}

	const questions = ctx.get("userQuestions");
	if (questions !== undefined && typeof questions.ask === "function" && !questions.__sessionAlertPatched) {
		const original = questions.ask.bind(questions);
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
			return original(request);
		};
		questions.ask = patched;
		Object.defineProperty(questions, "__sessionAlertPatched", { value: true, configurable: true });
		ctx.effect?.(() => () => {
			if (questions.ask === patched) questions.ask = original;
			delete questions.__sessionAlertPatched;
		});
	}

	const dispose = () => center.dispose();
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
 * @param {unknown} error 任意异常
 * @returns {string} 可读消息
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
