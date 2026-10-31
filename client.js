// dsh-nudge 的浏览器半身：只注册一个「设置 → 提醒弹窗」页面。
//
// 卡片本身是 Host 侧 powershell 画的，这里不碰渲染进程 UI；这个 bundle 唯一的
// 职责是给 nudge 的配置提供一个自己的设置页（不依赖「插件」页里的自动表单）。
//
// 加载协议见 @deepseek-ai/dsh-client-modules：脚本只注册 factory，模块体在被
// 物化时才跑；require 只能解析共享模块表里的包（react / react-dom 等）。
window.__ModuleLoader__.load({
	id: "dsh-nudge",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Host 侧 Loader 条目 id，配置命名空间与它一致。 */
		const ENTRY = "nudge";
		/** 每一类文字：[配置里的名字, 页面上的名字, 一句说明]。顺序决定页面上控件的顺序。 */
		const FONT_ROLES = [
			["title", "标题", "顶行右侧那句「会话提醒」"],
			["project", "项目名", "卡片最醒目的那一行"],
			["task", "任务名", "每条提醒的标题行"],
			["reason", "原因", "标题下面那行小字"],
			["status", "状态词", "完成 / 待你选择 / 失败"],
			["time", "时间", "右上角和每条右侧的时刻"],
			["more", "展开提示", "「还有 N 条未展开」"],
			["footer", "底部提示", "「点击卡片回到 DeepSeek Harness」"],
		];
		/** 设置页注册的 slot 类型。 */
		const SECTION = "settings.section";
		/** 设置页在导航里的位置：排在「插件」(15) 后面。 */
		const ORDER = 20;
	/** 设置页的修订标记：这一页的界面改了就换一个，用来确认加载的是新代码。 */
	const PANEL_REVISION = "2026-11-01.2";
	/** 长页面的分组导航：id 与下面每个分组容器的 id 对得上。 */
	const NAV_GROUPS = [
		["peek", "长这样"],
		["preset", "预设"],
		["master", "开关"],
		["kinds", "提醒"],
		["when", "时机"],
		["look", "外观"],
		["merge", "合并"],
		["type", "字号"],
		["debug", "调试"],
	];

		const STYLE = [
			".dsh-nudge-settings{max-width:760px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-settings h2{margin:0;font-size:18px;font-weight:600}",
			".dsh-nudge-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-group{display:flex;flex-direction:column;gap:2px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:4px 14px}",
			".dsh-nudge-group-title{margin:10px 0 2px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-row{display:flex;align-items:center;gap:14px;padding:10px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}",
			".dsh-nudge-row:first-child{border-top:0}",
			".dsh-nudge-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
			".dsh-nudge-label{font-size:13px;line-height:20px}",
			".dsh-nudge-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-input{width:110px;flex:none;font:inherit;font-size:13px;padding:5px 8px;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-areas{width:260px;flex:none;font:inherit;font-size:13px;line-height:20px;padding:6px 8px;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);resize:vertical;min-height:64px}",
			".dsh-nudge-switch{flex:none;width:36px;height:20px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-nudge-group-toggle{margin:10px 0 2px;padding:0;border:0;background:none;font:inherit;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-align:left}",
	".dsh-nudge-group-toggle:hover{color:var(--dsw-alias-label-primary)}",
	".dsh-nudge-group-toggle[data-on=\"1\"]{color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
			".dsh-nudge-card{display:flex;flex-direction:column;gap:2px;border-radius:12px;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1)}",
			".dsh-nudge-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
			".dsh-nudge-card-line{display:flex;align-items:baseline;gap:8px;min-width:0}",
			".dsh-nudge-card-hit{padding:1px 4px;margin:0 -4px;border-radius:6px;cursor:pointer;border:0.5px solid transparent;white-space:pre-wrap}",
			".dsh-nudge-card-hit:hover{background:var(--dsw-alias-bg-l2)}",
			".dsh-nudge-card-hit[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-l2)}",
			".dsh-nudge-actions{display:flex;gap:8px;flex-wrap:wrap;padding:6px 0 10px}",
			".dsh-nudge-btn{font:inherit;font-size:13px;line-height:18px;padding:6px 12px;border-radius:8px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dsh-nudge-btn[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-applybar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:0.5px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-l1);box-shadow:0 2px 12px rgba(0,0,0,.12)}",
			".dsh-nudge-applytext{flex:1;font-size:13px;line-height:20px}",
			".dsh-nudge-applybar[data-dirty=\"0\"]{border-color:var(--dsw-alias-border-l2);box-shadow:none}",
			".dsh-nudge-group[data-dirty=\"1\"]{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-group[data-dirty=\"1\"] .dsh-nudge-group-title::after{content:\" ·\";color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-nav{display:flex;flex-wrap:wrap;gap:6px;margin:0}",
			".dsh-nudge-navbtn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-navbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-stamp{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);opacity:.75}",
			".dsh-nudge-swatches{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:2px 0 8px}",
			".dsh-nudge-swatch{font:inherit;font-size:11px;line-height:16px;padding:3px 9px;border-radius:999px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px}",
			".dsh-nudge-swatch:hover{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-swatch[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-swatchdot{width:10px;height:10px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l2);flex:none}",
		].join("");

		/** 把样式挂进 <head>，同一个文档只挂一次。 */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-dsh-nudge-settings]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.dshNudgeSettings = "";
			tag.textContent = STYLE;
			document.head.appendChild(tag);
		}

		/**
		 * 取嵌套字段值。
		 * @param {object} value 配置对象
		 * @param {string} key 形如 `kinds.completed`
		 * @returns {unknown} 字段值
		 */
		function readField(value, key) {
			let current = value;
			for (const part of key.split(".")) {
				if (current === undefined || current === null) return undefined;
				current = current[part];
			}
			return current;
		}

		/**
		 * 字段的新值和配置里的当前值是否等价（数组、对象按内容比）。
		 * @param {object} value 配置对象
		 * @param {string} key 字段路径
		 * @param {unknown} next 待比较的新值
		 * @returns {boolean} 是否相同
		 */
		function sameField(value, key, next) {
			return JSON.stringify(readField(value, key)) === JSON.stringify(next);
		}

		/**
		 * 单个开关行。
		 * @param {{label: string, hint?: string, checked: boolean, disabled: boolean, onChange: (next: boolean) => void}} props 行属性
		 * @returns {import("react").ReactElement} 行元素
		 */
		function SwitchRow(props) {
			return h("div", { className: "dsh-nudge-row" }, [
				h("div", { className: "dsh-nudge-text", key: "text" }, [
					h("span", { className: "dsh-nudge-label", key: "label" }, props.label),
					props.hint === undefined ? null : h("span", { className: "dsh-nudge-hint", key: "hint" }, props.hint),
				]),
				h("input", {
					key: "switch",
					className: "dsh-nudge-switch",
					type: "checkbox",
					checked: props.checked === true,
					disabled: props.disabled,
					"aria-label": props.label,
					onChange: (event) => props.onChange(event.target.checked === true),
				}),
			]);
		}

		/**
		 * 数字行：失焦才提交，避免边打字边写盘。
		 * @param {{label: string, hint?: string, value: number, min: number, max: number, step?: number, disabled: boolean, onCommit: (next: number) => void}} props 行属性
		 * @returns {import("react").ReactElement} 行元素
		 */
		function NumberRow(props) {
			const [draft, setDraft] = React.useState(String(props.value));
			React.useEffect(() => setDraft(String(props.value)), [props.value]);
			const commit = () => {
				const next = Number(draft);
				if (!Number.isFinite(next)) {
					setDraft(String(props.value));
					return;
				}
				const clamped = Math.min(props.max, Math.max(props.min, Math.round(next * 1000) / 1000));
				setDraft(String(clamped));
				if (clamped !== props.value) props.onCommit(clamped);
			};
			return h("div", { className: "dsh-nudge-row" }, [
				h("div", { className: "dsh-nudge-text", key: "text" }, [
					h("span", { className: "dsh-nudge-label", key: "label" }, props.label),
					props.hint === undefined ? null : h("span", { className: "dsh-nudge-hint", key: "hint" }, props.hint),
				]),
				h("input", {
					key: "input",
					className: "dsh-nudge-input",
					type: "number",
					value: draft,
					min: props.min,
					max: props.max,
					step: props.step === undefined ? 1 : props.step,
					disabled: props.disabled,
					"aria-label": props.label,
					onChange: (event) => setDraft(event.target.value),
					onBlur: commit,
				}),
			]);
		}

		/**
		 * 下拉选择行。
		 * @param {{label: string, hint?: string, value: string, options: {value: string, label: string}[], disabled: boolean, onChange: (next: string) => void}} props 行属性
		 * @returns {import("react").ReactElement} 行元素
		 */
		function SelectRow(props) {
			return h("div", { className: "dsh-nudge-row" }, [
				h("div", { className: "dsh-nudge-text", key: "text" }, [
					h("span", { className: "dsh-nudge-label", key: "label" }, props.label),
					props.hint === undefined ? null : h("span", { className: "dsh-nudge-hint", key: "hint" }, props.hint),
				]),
				h(
					"select",
					{
						key: "select",
						className: "dsh-nudge-input",
						value: props.value,
						disabled: props.disabled,
						"aria-label": props.label,
						onChange: (event) => props.onChange(event.target.value),
					},
					props.options.map((option) => h("option", { key: option.value, value: option.value }, option.label)),
				),
			]);
		}

		/**
		 * 单行文本行。
		 * @param {{label: string, hint?: string, value: string, placeholder?: string, disabled: boolean, onCommit: (next: string) => void}} props 行属性
		 * @returns {import("react").ReactElement} 行元素
		 */
		function TextRow(props) {
			const [draft, setDraft] = React.useState(props.value);
			React.useEffect(() => setDraft(props.value), [props.value]);
			return h("div", { className: "dsh-nudge-row" }, [
				h("div", { className: "dsh-nudge-text", key: "text" }, [
					h("span", { className: "dsh-nudge-label", key: "label" }, props.label),
					props.hint === undefined ? null : h("span", { className: "dsh-nudge-hint", key: "hint" }, props.hint),
				]),
				h("input", {
					key: "input",
					className: "dsh-nudge-input",
					type: "text",
					value: draft,
					placeholder: props.placeholder,
					disabled: props.disabled,
					"aria-label": props.label,
					onChange: (event) => setDraft(event.target.value),
					onBlur: () => {
						if (draft !== props.value) props.onCommit(draft);
					},
				}),
			]);
		}

		/**
		 * 多行列表行：一行一条，失焦提交。
		 * @param {{label: string, hint?: string, value: string[], placeholder?: string, disabled: boolean, onCommit: (next: string[]) => void}} props 行属性
		 * @returns {import("react").ReactElement} 行元素
		 */
		function LinesRow(props) {
			const joined = props.value.join("\n");
			const [draft, setDraft] = React.useState(joined);
			React.useEffect(() => setDraft(joined), [joined]);
			const commit = () => {
				const next = draft
					.split(/\r?\n/u)
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
				if (next.join("\n") !== joined) props.onCommit(next);
			};
			return h("div", { className: "dsh-nudge-row" }, [
				h("div", { className: "dsh-nudge-text", key: "text" }, [
					h("span", { className: "dsh-nudge-label", key: "label" }, props.label),
					props.hint === undefined ? null : h("span", { className: "dsh-nudge-hint", key: "hint" }, props.hint),
				]),
				h("textarea", {
					key: "areas",
					className: "dsh-nudge-areas",
					value: draft,
					placeholder: props.placeholder,
					disabled: props.disabled,
					"aria-label": props.label,
					onChange: (event) => setDraft(event.target.value),
					onBlur: commit,
				}),
			]);
		}

		/**
		 * 订阅一个配置表单。快照是不可变替换，引用变了才重渲染。
		 * @param {{getSnapshot: () => object, subscribe: (listener: () => void) => () => void}} form 配置表单
		 * @returns {object} 表单快照
		 */
		function useConfigSnapshot(form) {
			const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
			React.useEffect(() => {
				let alive = true;
				const sync = () => {
					if (!alive) return;
					const next = form.getSnapshot();
					setSnapshot((previous) => (previous === next ? previous : next));
				};
				const off = form.subscribe(sync);
				sync();
				return () => {
					alive = false;
					off();
				};
			}, [form]);
			return snapshot;
		}

		/** 每一类文字的默认字号：和 lib/popup.ps1 里 New-Text 的兜底值一致，样卡才画得像真的。 */
		const ROLE_SIZE = { title: 14, project: 15.5, task: 12.5, reason: 10.5, status: 10.5, time: 10, more: 10.5, footer: 10 };
		const COLOR_CHOICES = [["", "跟随主题"], ["#FFFFFF", "白"], ["#E6E6E6", "浅灰"], ["#9AA0A6", "灰"], ["#111111", "黑"], ["#FF6B6B", "红"], ["#FFA84D", "橙"], ["#FFD43B", "黄"], ["#51CF66", "绿"], ["#4DABF7", "蓝"], ["#B197FC", "紫"]];
		/** 样卡里每一行的示例文字。 */
		const ROLE_SAMPLE = {
			title: "会话提醒",
			project: "dsh-nudge",
			task: "把设置页的字体改成点选式",
			reason: "回合正常结束 · 用时 2 分 13 秒",
			status: "完成",
			time: "12:04",
			more: "还有 2 条未展开",
			footer: "点击卡片回到 DeepSeekRuntime",
		};
		/** 样卡里每一行的浓淡与字重：颜色留空时按这套走，贴近真卡片的层次。 */
		const ROLE_LOOK = {
			title: { opacity: 1, weight: 600 },
			project: { opacity: 1, weight: 600 },
			task: { opacity: 0.86, weight: 400 },
			reason: { opacity: 0.6, weight: 400 },
			status: { opacity: 1, weight: 600 },
			time: { opacity: 0.45, weight: 400 },
			more: { opacity: 0.55, weight: 400 },
			footer: { opacity: 0.45, weight: 400 },
		};
		/** 样卡配色：auto 跟着页面主题走，light / dark 强制成对应底色。 */
		const THEME_SKIN = {
			auto: null,
			light: { background: "#ffffff", color: "#1b1b1f", borderColor: "rgba(0,0,0,.12)" },
			dark: { background: "#1f2124", color: "#f2f3f5", borderColor: "rgba(255,255,255,.14)" },
		};
		/** 三个一键预设：一次写一组字段，写完之后还能逐项微调。 */
		const PRESETS = [
			{
				id: "quiet",
				label: "安静",
				hint: "只在需要你动手或出错时弹，晚上静音",
				entries: [
					{ path: "kinds.completed", value: false },
					{ path: "kinds.needs_choice", value: true },
					{ path: "kinds.failed", value: true },
					{ path: "showWhenFocused", value: false },
					{ path: "alertOnToolError", value: false },
					{ path: "staySeconds", value: 8 },
					{ path: "mergeWindowMs", value: 30000 },
					{ path: "maxItems", value: 3 },
					{ path: "muteRanges", value: ["22:00-08:00"] },
				],
			},
			{
				id: "normal",
				label: "标准",
				hint: "三类都提醒，走开一会儿也能叫回来",
				entries: [
					{ path: "kinds.completed", value: true },
					{ path: "kinds.needs_choice", value: true },
					{ path: "kinds.failed", value: true },
					{ path: "showWhenFocused", value: false },
					{ path: "alertOnToolError", value: true },
					{ path: "staySeconds", value: 15 },
					{ path: "mergeWindowMs", value: 1200 },
					{ path: "maxItems", value: 8 },
					{ path: "muteRanges", value: [] },
				],
			},
			{
				id: "chatty",
				label: "话多",
				hint: "什么都提醒，卡片留久一点，不合并",
				entries: [
					{ path: "kinds.completed", value: true },
					{ path: "kinds.needs_choice", value: true },
					{ path: "kinds.failed", value: true },
					{ path: "showWhenFocused", value: true },
					{ path: "alertOnToolError", value: true },
					{ path: "staySeconds", value: 25 },
					{ path: "mergeWindowMs", value: 0 },
					{ path: "maxItems", value: 20 },
					{ path: "muteRanges", value: [] },
				],
			},
		];

		/**
		 * 每一组「恢复默认」写回去的值。必须和 `lib/index.js` 的 `DEFAULTS` 一致，
		 * 自测会拿这份逐项比对（`exports.groupDefaults` 就是给它看的）。
		 */
		const GROUP_DEFAULTS = [
			["master", [["enabled", true]]],
			[
				"kinds",
				[
					["kinds.completed", true],
					["kinds.needs_choice", true],
					["kinds.failed", true],
				],
			],
			[
				"when",
				[
					["showWhenFocused", true],
					["suppressWhenFullscreen", true],
					["alertOnToolError", true],
				],
			],
			[
				"look",
				[
					["theme", "auto"],
					["staySeconds", 15],
					["margin", 16],
					["rememberPosition", true],
				],
			],
			[
				"merge",
				[
					["mergeWindowMs", 1200],
					["maxItems", 8],
					["muteRanges", []],
				],
			],
			["type", []],
			[
				"debug",
				[
					["debugPreview", false],
					["debugPayload", false],
					["debugFile", ""],
				],
			],
		];
		for (const [role] of FONT_ROLES) {
			GROUP_DEFAULTS[5][1].push(["typography." + role + ".color", ""], ["typography." + role + ".size", 0]);
		}

		/** 静音时段的写法：小时 0–23、分钟 0–59，中间允许空格。 */
		const RANGE_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u;

		/**
		 * 把静音时段拆成「能用的」和「写法不对的」两堆。
		 * @param {string[]} ranges 原始行
		 * @returns {{bad: string[], slots: {from: number, to: number}[]}} 结果
		 */
		function splitRanges(ranges) {
			const bad = [];
			const slots = [];
			for (const raw of ranges) {
				const line = String(raw).trim();
				if (line === "") continue;
				const match = RANGE_PATTERN.exec(line);
				if (match === null) {
					bad.push(line);
					continue;
				}
				const from = Number(match[1]) * 60 + Number(match[2]);
				const to = Number(match[3]) * 60 + Number(match[4]);
				if (from > 1439 || to > 1439) {
					bad.push(line);
					continue;
				}
				if (from === to) continue;
				slots.push({ from, to });
			}
			return { bad, slots };
		}

		/**
		 * 某一刻在不在静音里；规则和 `lib/index.js` 的 `inMuteRange` 一样（跨零点也算）。
		 * @param {{from: number, to: number}[]} slots 时间段
		 * @param {number} minutes 当天第几分钟
		 * @returns {boolean} 是否静音
		 */
		function insideSlots(slots, minutes) {
			for (const slot of slots) {
				const hit = slot.from < slot.to ? minutes >= slot.from && minutes < slot.to : minutes >= slot.from || minutes < slot.to;
				if (hit) return true;
			}
			return false;
		}

		/**
		 * 一组底下的「恢复默认」按钮。
		 * @param {{group: string, disabled: boolean, onReset: (entries: [string, unknown][]) => void}} props 行属性
		 * @returns {import("react").ReactElement} 一行按钮
		 */
		function ResetRow(props) {
			return h("div", { className: "dsh-nudge-actions" }, [
				h(
					"button",
					{
						key: "reset",
						type: "button",
						className: "dsh-nudge-btn",
						"data-group": props.group,
						disabled: props.disabled,
						onClick: () => {
							const found = GROUP_DEFAULTS.find((item) => item[0] === props.group);
							if (found !== undefined) props.onReset(found[1]);
						},
					},
					"恢复默认",
				),
			]);
		}

		/**
		 * 「设置 → 提醒弹窗」页面。
		 * @param {{configForm: object}} props slot 注入的属性
		 * @returns {import("react").ReactElement} 页面元素
		 */
		function NudgeSettingsSection(props) {
			const form = props.configForm;
			const snapshot = useConfigSnapshot(form);
			const [failure, setFailure] = React.useState("");
			/** 正在调字号和颜色的那一类文字；点样卡上的行会换。 */
			const [fontRole, setFontRole] = React.useState("project");
			/** 调试那组默认收着，一屏别全是排查用的开关。 */
			const [debugOpen, setDebugOpen] = React.useState(false);
			/** 导出 / 导入框里的文本。 */
			const [dump, setDump] = React.useState("");
			/** 每分钟加一，让「现在是否静音」跟着时间走。 */
			const [clock, setClock] = React.useState(0);
			/** 还没点「应用」的改动：字段路径 → 新值。空对象表示没有待应用的改动。 */
			const [draft, setDraft] = React.useState({});
			/** 字号那组是否展开成「8 行一起看」。 */
			const [allSizes, setAllSizes] = React.useState(false);
			/** 刚保存完的提示，两秒后自己消失。 */
			const [saved, setSaved] = React.useState(false);
			React.useEffect(() => {
				const timer = setInterval(() => setClock((count) => count + 1), 60000);
				if (typeof timer.unref === "function") timer.unref();
				return () => clearInterval(timer);
			}, []);
			const value = snapshot.value === undefined ? {} : snapshot.value;
			const ready = snapshot.status === "ready";
			const disabled = !ready || snapshot.writable !== true;

			React.useEffect(() => {
				ensureStyle();
			}, []);

			/**
			 * 改一项：先记进草稿，点「应用」才写进配置。
			 * @param {string} key 字段路径
			 * @param {unknown} next 新值
			 */
			const write = (key, next) => {
				setFailure("");
				setDraft((current) => {
					const merged = { ...current };
					merged[key] = next;
					return merged;
				});
			};

			/**
			 * 立刻写一项，不进草稿（弹预览卡这类动作要马上见效）。
			 * @param {string} key 字段路径
			 * @param {unknown} next 新值
			 */
			const writeNow = (key, next) => {
				setFailure("");
				Promise.resolve(form.mutate([{ op: "set", path: key.split("."), value: next }], snapshot.revision))
					.then((ok) => {
						if (ok === false) setFailure("宿主没接受这次修改，已刷新成当前值。");
					})
					.catch((error) => {
						setFailure(`写入失败：${error instanceof Error ? error.message : String(error)}`);
					});
			};

			/** 草稿里有几条还没应用。 */
			const draftPaths = Object.keys(draft);

			/** 这一项改过，而且改得和配置里的当前值不一样。 */
			const dirty = (key) => Object.hasOwn(draft, key) && !sameField(value, key, draft[key]);
			/** 真正待写回的项数：改过又改回原值的不算。 */
			const pending = draftPaths.filter((path) => dirty(path)).length;
			/** 某一组里有几项改过，用来给分组标题点个点。 */
			const groupDirty = (id) => {
				const found = GROUP_DEFAULTS.find((item) => item[0] === id);
				if (found === undefined) return 0;
				return found[1].filter((entry) => dirty(entry[0])).length;
			};
			/** 跳到某一组。 */
			const jumpTo = (id) => {
				if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
				const target = document.getElementById("dsh-nudge-g-" + id);
				if (target !== null && typeof target.scrollIntoView === "function")
					target.scrollIntoView({ block: "start", behavior: "smooth" });
			};

			/** 把草稿里与当前值不同的项一次性写回去。 */
			const applyDraft = () => {
				setFailure("");
				const ops = [];
				for (const path of draftPaths) {
					if (sameField(value, path, draft[path])) continue;
					ops.push({ op: "set", path: path.split("."), value: draft[path] });
				}
				setDraft({});
				if (ops.length === 0) return;
				Promise.resolve(form.mutate(ops, snapshot.revision))
					.then((ok) => {
						if (ok === false) {
							setFailure("宿主没接受这次修改，已刷新成当前值。");
							return;
						}
						setSaved(true);
						setTimeout(() => setSaved(false), 2000);
					})
					.catch((error) => {
						setFailure("写入失败：" + (error instanceof Error ? error.message : String(error)));
					});
			};

			/** 丢掉草稿，回到配置里的当前值。 */
			const discardDraft = () => {
				setFailure("");
				setDraft({});
			};

			/**
			 * 一次改多个字段（预设、恢复默认、导入都用它），同样先进草稿。
			 * @param {{path: string, value: unknown}[]} entries 字段路径与新值
			 */
			const writeMany = (entries) => {
				setFailure("");
				setDraft((current) => {
					const merged = { ...current };
					for (const entry of entries) merged[entry.path] = entry.value;
					return merged;
				});
			};

			/** 读一个字段：草稿里有就用草稿的，页面总是显示「改完会是什么样」。 */
			const raw = (key) => (Object.hasOwn(draft, key) ? draft[key] : readField(value, key));
			const bool = (key) => raw(key) === true;
			const num = (key) => {
				const current = raw(key);
				return typeof current === "number" ? current : 0;
			};
			const text = (key) => {
				const current = raw(key);
				return typeof current === "string" ? current : "";
			};
			const lines = (key) => {
				const current = raw(key);
				return Array.isArray(current) ? current.map((item) => String(item)) : [];
			};
			const mute = splitRanges(lines("muteRanges"));
			const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
			const muted = insideSlots(mute.slots, nowMinutes);

			/** 一组的「恢复默认」：把该组的默认值一次写回去。 */
			const resetGroup = (entries) => writeMany(entries.map(([path, next]) => ({ path, value: next })));

			/** 能导出、也能导入的配置项。 */
			const CONFIG_KEYS = [
				"enabled",
				"staySeconds",
				"showWhenFocused",
				"suppressWhenFullscreen",
				"margin",
				"mergeWindowMs",
				"maxItems",
				"alertOnToolError",
				"muteRanges",
				"kinds",
				"theme",
				"typography",
				"debugPreview",
				"debugPayload",
				"debugFile",
				"rememberPosition",
				"placementFile",
			];

			/** 把当前配置变成一段文本，塞进下面的框里。 */
			const exportText = () => {
				setFailure("");
				const picked = {};
				for (const key of CONFIG_KEYS) {
					if (value[key] !== undefined) picked[key] = value[key];
				}
				setDump(JSON.stringify(picked, null, 2));
			};

			/** 把框里的文本整段写回去。 */
			const importText = () => {
				setFailure("");
				let parsed;
				try {
					parsed = JSON.parse(dump);
				} catch (error) {
					setFailure("这段文本不是合法 JSON：" + (error instanceof Error ? error.message : String(error)));
					return;
				}
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					setFailure("最外层得是一个对象，里面按设置名写值。");
					return;
				}
				const keys = Object.keys(parsed).filter((key) => CONFIG_KEYS.includes(key));
				if (keys.length === 0) {
					setFailure("没认出任何一项能导入的设置。");
					return;
				}
				writeMany(keys.map((key) => ({ path: key, value: parsed[key] })));
			};

			const roleLabel = (role) => {
				const found = FONT_ROLES.find((item) => item[0] === role);
				return found === undefined ? role : found[1];
			};
			const roleHint = (role) => {
				const found = FONT_ROLES.find((item) => item[0] === role);
				return found === undefined ? "" : found[2];
			};
			/** 样卡里这一行实际用的字号：配置是 0 就落回默认。 */
			const roleSize = (role) => {
				const size = num("typography." + role + ".size");
				return size > 0 ? size : ROLE_SIZE[role];
			};
			/** 字号输入框底下那句话：现在是多少、默认是多少。 */
			const sizeHint = (role) => {
				const explicit = num("typography." + role + ".size");
				if (explicit > 0) { return "现在是 " + explicit + "；改成 0 就回到默认 " + ROLE_SIZE[role] + "。"; }
				return "现在跟着默认走（" + ROLE_SIZE[role] + "）；改了就一直用新值。";
			};
			/** 这一类现在用的颜色，留空表示跟随主题。 */
			const colorNow = (role) => text("typography." + role + ".color");
			/** 样卡里这一行的内联样式：颜色留空就按 ROLE_LOOK 的浓淡走。 */
			const cardFont = (role) => {
				const look = ROLE_LOOK[role];
				const color = text("typography." + role + ".color");
				return {
					fontSize: roleSize(role) + "px",
					fontWeight: look.weight,
					opacity: color === "" ? look.opacity : 1,
					color: color === "" ? undefined : color,
				};
			};
			const themeValue = text("theme") === "" ? "auto" : text("theme");
			const skin = Object.hasOwn(THEME_SKIN, themeValue) ? THEME_SKIN[themeValue] : null;
			/**
			 * 样卡里的一行：点一下就把它设为正在调的那一类。
			 * @param {string} role 文字类别
			 * @returns {import("react").ReactElement} 可点的一行
			 */
			const cardLine = (role) =>
				h(
					"span",
					{
						key: role,
						className: "dsh-nudge-card-hit",
						"data-role": role,
						"data-on": fontRole === role ? "1" : "0",
						style: cardFont(role),
						onClick: () => setFontRole(role),
						title: "点一下改「" + roleLabel(role) + "」",
					},
					ROLE_SAMPLE[role],
				);

			return h("div", { className: "dsh-nudge-settings" }, [
				h("h2", { key: "title" }, "提醒弹窗"),
				h(
					"p",
					{ className: "dsh-nudge-status", key: "status" },
					"配置状态：" +
						String(snapshot.status) +
						(snapshot.writable === true ? " · 可写" : " · 只读") +
						" · 待保存 " +
						pending +
						" 项",
				),
				h(
					"nav",
					{ className: "dsh-nudge-nav", key: "nav" },
					NAV_GROUPS.map(([id, label]) =>
						h(
							"button",
							{
								key: id,
								type: "button",
								className: "dsh-nudge-navbtn",
								onClick: () => jumpTo(id),
							},
							label,
						),
					),
				),
				h(
					"p",
					{ className: "dsh-nudge-intro", key: "intro" },
					"这里改的是 nudge 插件的配置，存在当前 profile 的 cordis.patch.yml 里；改完点最下面的「应用」存下来，不用重启。",
				),
				!ready
					? h("p", { className: "dsh-nudge-warn", key: "loading" }, "正在读取配置…")
					: snapshot.writable !== true
						? h("p", { className: "dsh-nudge-warn", key: "readonly" }, "当前 profile 的配置是只读的，这里只能看不能改。")
						: null,
				failure === "" ? null : h("p", { className: "dsh-nudge-error", key: "failure", role: "alert" }, failure),

				h("div", { className: "dsh-nudge-group", key: "peek", id: "dsh-nudge-g-peek" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "长这样"),
					h(
						"p",
						{ className: "dsh-nudge-intro", key: "hint" },
						"按现在的配色和字号画的一张样卡：点哪一行，下面就调哪一行。",
					),
					h("div", { className: "dsh-nudge-card", key: "card", style: skin === null ? undefined : skin }, [
						h("div", { className: "dsh-nudge-card-head", key: "head" }, [cardLine("title"), cardLine("time")]),
						h("div", { className: "dsh-nudge-card-line", key: "project" }, [cardLine("project")]),
						h("div", { className: "dsh-nudge-card-line", key: "status" }, [cardLine("status"), cardLine("task")]),
						h("div", { className: "dsh-nudge-card-line", key: "reason" }, [cardLine("reason")]),
						h("div", { className: "dsh-nudge-card-line", key: "more" }, [cardLine("more")]),
						h("div", { className: "dsh-nudge-card-line", key: "footer" }, [cardLine("footer")]),
					]),
					h("div", { className: "dsh-nudge-actions", key: "act" }, [
						h(
							"button",
							{
								key: "try",
								type: "button",
								className: "dsh-nudge-btn",
								disabled,
								onClick: () => writeNow("debugPreview", !bool("debugPreview")),
							},
							bool("debugPreview") ? "收起桌面上的卡片" : "在桌面上弹一张看看",
						),
					]),
				]),

				h("div", { className: "dsh-nudge-group", key: "preset", id: "dsh-nudge-g-preset" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "一键预设"),
					h("p", { className: "dsh-nudge-intro", key: "hint" }, "先挑一个最接近的，再往下微调；只动下面这些开关，不碰字体。"),
					h(
						"div",
						{ className: "dsh-nudge-actions", key: "row" },
						PRESETS.map((preset) =>
							h(
								"button",
								{
									key: preset.id,
									type: "button",
									className: "dsh-nudge-btn",
									disabled,
									title: preset.hint,
									onClick: () => writeMany(preset.entries),
								},
								preset.label,
							),
						),
					),
				]),

				h("div", { className: "dsh-nudge-group", key: "master", id: "dsh-nudge-g-master", "data-dirty": groupDirty("master") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "总开关"),
					h(SwitchRow, {
						key: "enabled",
						label: "启用提醒弹窗",
						hint: "关掉之后不再弹任何卡片，其他设置保持不变。",
						checked: bool("enabled"),
						disabled,
						onChange: (next) => write("enabled", next),
					}),
					h(ResetRow, { key: "reset", group: "master", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "kinds", id: "dsh-nudge-g-kinds", "data-dirty": groupDirty("kinds") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "提醒哪几类"),
					h(SwitchRow, {
						key: "completed",
						label: "任务完成",
						hint: "回合正常结束时提醒。",
						checked: bool("kinds.completed"),
						disabled,
						onChange: (next) => write("kinds.completed", next),
					}),
					h(SwitchRow, {
						key: "needs_choice",
						label: "需要你选择",
						hint: "回合在等你确认、或者提问时提醒。",
						checked: bool("kinds.needs_choice"),
						disabled,
						onChange: (next) => write("kinds.needs_choice", next),
					}),
					h(SwitchRow, {
						key: "failed",
						label: "执行失败",
						hint: "回合报错、被策略拦截、工具调用失败时提醒。",
						checked: bool("kinds.failed"),
						disabled,
						onChange: (next) => write("kinds.failed", next),
					}),
					h(ResetRow, { key: "reset", group: "kinds", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "when", id: "dsh-nudge-g-when", "data-dirty": groupDirty("when") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "什么时候弹"),
					h(SwitchRow, {
						key: "showWhenFocused",
						label: "DSH 在前台时也弹",
						hint: "关掉就只在 DSH 不是前台窗口时提醒。",
						checked: bool("showWhenFocused"),
						disabled,
						onChange: (next) => write("showWhenFocused", next),
					}),
					h(SwitchRow, {
						key: "suppressWhenFullscreen",
						label: "全屏时不打扰",
						hint: "看视频、打游戏、演示时整批吞掉，不弹卡。",
						checked: bool("suppressWhenFullscreen"),
						disabled,
						onChange: (next) => write("suppressWhenFullscreen", next),
					}),
					h(SwitchRow, {
						key: "alertOnToolError",
						label: "工具报错也提醒",
						hint: "单个工具调用出错时会单独弹一条失败提醒。",
						checked: bool("alertOnToolError"),
						disabled,
						onChange: (next) => write("alertOnToolError", next),
					}),
					h(ResetRow, { key: "reset", group: "when", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "look", id: "dsh-nudge-g-look", "data-dirty": groupDirty("look") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "样子与位置"),
					h(SelectRow, {
						key: "theme",
						label: "配色",
						hint: "auto 跟随 Windows 的深浅色设置。",
						value: themeValue,
						options: [
							{ value: "auto", label: "跟随系统" },
							{ value: "light", label: "浅色" },
							{ value: "dark", label: "深色" },
						],
						disabled,
						onChange: (next) => write("theme", next),
					}),
					h(NumberRow, {
						key: "staySeconds",
						label: "停留秒数",
						hint: "卡片自己消失前显示多久（1–600 秒）。",
						value: num("staySeconds"),
						min: 1,
						max: 600,
						disabled,
						onCommit: (next) => write("staySeconds", next),
					}),
					h(NumberRow, {
						key: "margin",
						label: "距屏幕边缘",
						hint: "可见卡片边框离工作区右下角的像素数（0–400）。",
						value: num("margin"),
						min: 0,
						max: 400,
						disabled,
						onCommit: (next) => write("margin", next),
					}),
					h(SwitchRow, {
						key: "rememberPosition",
						label: "记住拖过的位置",
						hint: "拖过或缩过之后，下次还出现在那儿；删掉位置文件就回到右下角。",
						checked: bool("rememberPosition"),
						disabled,
						onChange: (next) => write("rememberPosition", next),
					}),
					h(ResetRow, { key: "reset", group: "look", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "merge", id: "dsh-nudge-g-merge", "data-dirty": groupDirty("merge") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "合并"),
					h(NumberRow, {
						key: "mergeWindowMs",
						label: "合并窗口（毫秒）",
						hint: "这么近的多条提醒合并成一张清单卡（0–60000）。",
						value: num("mergeWindowMs"),
						min: 0,
						max: 60000,
						step: 100,
						disabled,
						onCommit: (next) => write("mergeWindowMs", next),
					}),
					h(NumberRow, {
						key: "maxItems",
						label: "清单最多几条",
						hint: "合并卡里最多列几条，多的收成「还有 N 条」（1–20）。",
						value: num("maxItems"),
						min: 1,
						max: 20,
						disabled,
						onCommit: (next) => write("maxItems", next),
					}),
					h(LinesRow, {
						key: "muteRanges",
						label: "静音时段",
						hint: "一行一段，写法是 22:00-08:00，可以跨零点；留空就是全天都提醒。",
						value: lines("muteRanges"),
						placeholder: "22:00-08:00",
						disabled,
						onCommit: (next) => write("muteRanges", next),
					}),
					mute.bad.length === 0
						? null
						: h(
								"p",
								{ className: "dsh-nudge-error", key: "mutebad", role: "alert" },
								"这几行写法不对，会被跳过：" + mute.bad.join("、") + "；写成 22:00-08:00 这样。",
							),
					mute.slots.length === 0 && mute.bad.length === 0
						? null
						: h(
								"p",
								{ className: "dsh-nudge-warn", key: "mutestate" + clock },
								muted ? "现在正处于静音时段，卡片不会弹。" : "现在不在静音时段。",
							),
					h(ResetRow, { key: "reset", group: "merge", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "type", id: "dsh-nudge-g-type", "data-dirty": groupDirty("type") > 0 ? "1" : "0" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "字号与颜色"),
					h(
						"p",
						{ className: "dsh-nudge-intro", key: "hint" },
						"点上面样卡里的某一行（或者下面这些名字）就切到那一行；留空 / 0 表示用默认。",
					),
					h(
						"div",
						{ className: "dsh-nudge-actions", key: "roles" },
						FONT_ROLES.map(([role, label]) =>
							h(
								"button",
								{
									key: role,
									type: "button",
									className: "dsh-nudge-btn",
									"data-role": role,
									"data-on": fontRole === role ? "1" : "0",
									disabled,
									onClick: () => setFontRole(role),
								},
								label,
							),
						),
					),
					h(
						"div",
						{ className: "dsh-nudge-actions", key: "alltoggle" },
						h(
							"button",
							{
								key: "all",
								type: "button",
								className: "dsh-nudge-btn",
								"data-on": allSizes ? "1" : "0",
								"aria-expanded": allSizes ? "true" : "false",
								disabled,
								onClick: () => setAllSizes(!allSizes),
							},
							allSizes ? "收起逐行字号" : "逐行设字号（8 行一起看）",
						),
					),
					allSizes
						? h(
								"div",
								{ className: "dsh-nudge-sizerows", key: "sizes" },
								FONT_ROLES.map(([role]) =>
									h(NumberRow, {
										key: role,
										label: roleLabel(role),
										hint: sizeHint(role),
										value: roleSize(role),
										min: 0,
										max: 48,
										step: 0.5,
										disabled,
										onCommit: (next) => write("typography." + role + ".size", next),
									}),
								),
							)
						: null,
					h("div", { className: "dsh-nudge-swatches", key: "colors" }, COLOR_CHOICES.map(([value, name]) =>
						h("button", {
							key: value === "" ? "auto" : value,
							type: "button",
							className: "dsh-nudge-swatch",
							"data-color": value === "" ? "auto" : value,
							"data-on": colorNow(fontRole) === value ? "1" : "0",
							disabled,
							onClick: () => write("typography." + fontRole + ".color", value),
							title: value === "" ? "不指定颜色，跟着主题走" : name + " " + value,
						}, [
							h("span", { key: "dot", className: "dsh-nudge-swatchdot", style: { background: value === "" ? "transparent" : value } }),
							name,
						]),
					)),
					h(TextRow, {
						key: "color",
						label: "颜色（" + roleLabel(fontRole) + "）",
						hint: roleHint(fontRole) + "；上面点一个现成的，或者自己写 #RRGGBB / #AARRGGBB，留空跟随主题。",
						value: text("typography." + fontRole + ".color"),
						placeholder: "留空跟随主题",
						disabled,
						onCommit: (next) => write("typography." + fontRole + ".color", next),
					}),
					h(NumberRow, {
						key: "size",
						label: "字号（" + roleLabel(fontRole) + "）",
						hint: sizeHint(fontRole),
						value: roleSize(fontRole),
						min: 0,
						max: 48,
						step: 0.5,
						disabled,
						onCommit: (next) => write("typography." + fontRole + ".size", next),
					}),
					h(ResetRow, { key: "reset", group: "type", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-group", key: "debug", id: "dsh-nudge-g-debug", "data-dirty": groupDirty("debug") > 0 ? "1" : "0" }, [
		h(
			"button",
			{
				key: "title",
				type: "button",
				className: "dsh-nudge-group-toggle",
				"data-on": debugOpen ? "1" : "0",
				"aria-expanded": debugOpen ? "true" : "false",
				onClick: () => setDebugOpen(!debugOpen),
			},
			debugOpen ? "调试（点一下收起）" : "调试（点一下展开）",
		),
				debugOpen ? h(SwitchRow, {
						key: "debugPreview",
						label: "预览弹窗（常驻，可拖动缩放）",
						hint: "打开后立刻弹一张卡片并一直留着；拖动或缩放它，关掉开关时位置和大小会记住。",
						checked: bool("debugPreview"),
						disabled,
						onChange: (next) => write("debugPreview", next),
					}) : null,
				debugOpen ? h(SwitchRow, {
						key: "debugPayload",
						label: "把每次弹出的内容落盘",
						hint: "排查「为什么没弹 / 弹得不对」时打开。",
						checked: bool("debugPayload"),
						disabled,
						onChange: (next) => write("debugPayload", next),
					}) : null,
				debugOpen ? h(TextRow, {
						key: "debugFile",
						label: "落盘文件",
						hint: "留空就是 %TEMP%\\dsh-nudge-payloads.jsonl。",
						value: text("debugFile"),
						placeholder: "留空使用默认路径",
						disabled,
						onCommit: (next) => write("debugFile", next),
					}) : null,
		debugOpen
			? h("div", { className: "dsh-nudge-row", key: "io" }, [
					h("div", { key: "text" }, [
						h("span", { className: "dsh-nudge-label", key: "label" }, "导出 / 导入"),
						h(
							"div",
							{ className: "dsh-nudge-hint", key: "hint" },
							"「导出」把当前配置写成一段文本；把一段配置粘进来点「导入」就整段覆盖。换机器、让别人复现问题都靠它。",
						),
					]),
					h("textarea", {
						key: "dump",
						className: "dsh-nudge-areas",
						"aria-label": "导出或导入的配置文本",
						value: dump,
						placeholder: "点「导出」把当前配置写到这里，或者把别处的配置粘进来再点「导入」。",
						spellCheck: false,
						onChange: (event) => setDump(event.target.value),
					}),
				])
			: null,
		debugOpen
			? h("div", { className: "dsh-nudge-actions", key: "iobtn" }, [
					h("button", { key: "dumpbtn", type: "button", className: "dsh-nudge-btn", disabled, onClick: exportText }, "导出"),
					h(
						"button",
						{
							key: "loadbtn",
							type: "button",
							className: "dsh-nudge-btn",
							disabled: disabled || dump.trim() === "",
							onClick: importText,
						},
						"导入",
					),
				])
			: null,
		h(ResetRow, { key: "reset", group: "debug", disabled, onReset: resetGroup }),
				]),

				h("div", { className: "dsh-nudge-applybar", key: "applybar", "data-dirty": pending > 0 ? "1" : "0", role: "status" }, [
					h(
						"span",
						{ className: "dsh-nudge-applytext", key: "text" },
						pending > 0
							? pending + " 项改动还没保存"
							: saved === true
								? "已保存"
								: "没有未保存的改动",
					),
					h(
						"button",
						{
							key: "apply",
							type: "button",
							className: "dsh-nudge-btn",
							"data-on": "1",
							disabled: disabled || pending === 0,
							onClick: applyDraft,
						},
						"应用",
					),
					h(
						"button",
						{
							key: "discard",
							type: "button",
							className: "dsh-nudge-btn",
							disabled: disabled || pending === 0,
							onClick: discardDraft,
						},
						"放弃",
					),
				]),
				h("p", { className: "dsh-nudge-stamp", key: "stamp" }, "提醒弹窗设置页 · 修订 " + PANEL_REVISION),
			]);
		}

		/**
		 * 注册设置页；把表单控制器注入给页面组件。
		 * @param {object} ctx 客户端插件上下文
		 */
		function apply(ctx) {
			const form = ctx.configForms.get(ENTRY);
			ctx.slots.inject(SECTION, () =>
				ctx.slots.register(
					{
						name: SECTION,
						id: ENTRY,
						order: ORDER,
						label: () => "提醒弹窗",
						inject: () => ({ configForm: form }),
					},
					NudgeSettingsSection,
				),
			);
		}

		/** 只依赖插件页需要的两个服务；宿主没组合设置界面时本插件不会被激活。 */
		const inject = ["slots", "configForms"];

		exports.apply = apply;
		exports.inject = inject;
		/** 给自测比对用的分组默认值。 */
		exports.groupDefaults = GROUP_DEFAULTS;
		exports.name = "dsh-nudge";
		return module.exports;
	},
});
