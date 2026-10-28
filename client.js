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
			".dsh-nudge-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
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

		/**
		 * 「设置 → 提醒弹窗」页面。
		 * @param {{configForm: object}} props slot 注入的属性
		 * @returns {import("react").ReactElement} 页面元素
		 */
		function NudgeSettingsSection(props) {
			const form = props.configForm;
			const snapshot = useConfigSnapshot(form);
			const [failure, setFailure] = React.useState("");
			const value = snapshot.value === undefined ? {} : snapshot.value;
			const ready = snapshot.status === "ready";
			const disabled = !ready || snapshot.writable !== true;

			React.useEffect(() => {
				ensureStyle();
			}, []);

			/**
			 * 写一个字段（支持 `a.b` 路径）。
			 * @param {string} key 字段路径
			 * @param {unknown} next 新值
			 */
			const write = (key, next) => {
				setFailure("");
				Promise.resolve(form.mutate([{ op: "set", path: key.split("."), value: next }], snapshot.revision))
					.then((ok) => {
						if (ok === false) setFailure("宿主没接受这次修改，已刷新成当前值。");
					})
					.catch((error) => {
						setFailure(`写入失败：${error instanceof Error ? error.message : String(error)}`);
					});
			};

			const bool = (key) => readField(value, key) === true;
			const num = (key) => {
				const current = readField(value, key);
				return typeof current === "number" ? current : 0;
			};
			const text = (key) => {
				const current = readField(value, key);
				return typeof current === "string" ? current : "";
			};
			const lines = (key) => {
				const current = readField(value, key);
				return Array.isArray(current) ? current.map((item) => String(item)) : [];
			};

			return h("div", { className: "dsh-nudge-settings" }, [
				h("h2", { key: "title" }, "提醒弹窗"),
				h(
					"p",
					{ className: "dsh-nudge-intro", key: "intro" },
					"这里改的是 nudge 插件的配置，存在当前 profile 的 cordis.patch.yml 里；改一项立刻生效，不用重启。",
				),
				!ready
					? h("p", { className: "dsh-nudge-warn", key: "loading" }, "正在读取配置…")
					: snapshot.writable !== true
						? h("p", { className: "dsh-nudge-warn", key: "readonly" }, "当前 profile 的配置是只读的，这里只能看不能改。")
						: null,
				failure === "" ? null : h("p", { className: "dsh-nudge-error", key: "failure", role: "alert" }, failure),

				h("div", { className: "dsh-nudge-group", key: "master" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "总开关"),
					h(SwitchRow, {
						key: "debugPreview",
						label: "预览弹窗（常驻，可拖动缩放）",
						hint: "打开后立刻弹一张卡片并一直留着；拖动或缩放它，关掉开关时位置和大小会记住。",
						checked: bool("debugPreview"),
						disabled,
						onChange: (next) => write("debugPreview", next),
					}),
					h(SwitchRow, {
						key: "enabled",
						label: "启用提醒弹窗",
						hint: "关掉之后不再弹任何卡片，其他设置保持不变。",
						checked: bool("enabled"),
						disabled,
						onChange: (next) => write("enabled", next),
					}),
				]),

				h("div", { className: "dsh-nudge-group", key: "kinds" }, [
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
				]),

				h("div", { className: "dsh-nudge-group", key: "when" }, [
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
				]),

				h("div", { className: "dsh-nudge-group", key: "look" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "样子与位置"),
					h(SelectRow, {
						key: "theme",
						label: "配色",
						hint: "auto 跟随 Windows 的深浅色设置。",
						value: text("theme") === "" ? "auto" : text("theme"),
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
				]),

				h("div", { className: "dsh-nudge-group", key: "merge" }, [
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
				]),

				// 字体只在开着预览时出现：没有常驻卡片当靶子，改字号全靠猜。
				bool("debugPreview")
					? h("div", { className: "dsh-nudge-group", key: "type" }, [
							h("p", { className: "dsh-nudge-group-title", key: "title" }, "每一项的字号和颜色"),
							h(
								"p",
								{ className: "dsh-nudge-intro", key: "hint" },
								"只有开着预览弹窗才显示这一组：改一格，卡片会重画一次，能立刻看到效果。留空 / 0 表示用默认。",
							),
							...FONT_ROLES.flatMap(([role, label, hint]) => [
								h(TextRow, {
									key: role + "-color",
									label: label + "颜色",
									hint: hint + "；写 #RRGGBB 或 #AARRGGBB，留空跟随主题。",
									value: text("typography." + role + ".color"),
									placeholder: "留空跟随主题",
									disabled,
									onCommit: (next) => write("typography." + role + ".color", next),
								}),
								h(NumberRow, {
									key: role + "-size",
									label: label + "字号",
									hint: "0 表示默认；常用范围 9–18。",
									value: num("typography." + role + ".size"),
									min: 0,
									max: 48,
									step: 0.5,
									disabled,
									onCommit: (next) => write("typography." + role + ".size", next),
								}),
							]),
						])
					: null,

				h("div", { className: "dsh-nudge-group", key: "debug" }, [
					h("p", { className: "dsh-nudge-group-title", key: "title" }, "调试"),
					h(SwitchRow, {
						key: "debugPayload",
						label: "把每次弹出的内容落盘",
						hint: "排查「为什么没弹 / 弹得不对」时打开。",
						checked: bool("debugPayload"),
						disabled,
						onChange: (next) => write("debugPayload", next),
					}),
					h(TextRow, {
						key: "debugFile",
						label: "落盘文件",
						hint: "留空就是 %TEMP%\\dsh-nudge-payloads.jsonl。",
						value: text("debugFile"),
						placeholder: "留空使用默认路径",
						disabled,
						onCommit: (next) => write("debugFile", next),
					}),
				]),
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
		exports.name = "dsh-nudge";
		return module.exports;
	},
});
