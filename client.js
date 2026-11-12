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
	const PANEL_REVISION = "2026-11-10.7";
	/**
	 * 分组导航：id 与下面每个分组容器的 id 对得上。
	 * 顺序 = 你多久会动它一次：先看长什么样（预览），再调字、卡片、位置，
	 * 然后才是弹不弹、点了会怎样、什么时候别弹、怎么合并，最后是排查用的调试。
	 * 「预览」那一组不是配置项，只画样卡，所以没有「恢复默认」。
	 */
	const NAV_GROUPS = [
		["preview", "预览"],
		["type", "文字"],
		["card", "卡片"],
		["place", "位置"],
		["basic", "提醒"],
		["click", "点击"],
		["when", "时机"],
		["merge", "合并"],
		["debug", "调试"],
	];

		const STYLE = [
	/* 「哪一类」那一排：贴着样卡放，改哪一类不用来回滚。 */
	".dsh-nudge-roles{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}",
	".dsh-nudge-role{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:inherit;font:inherit;cursor:pointer}",
	".dsh-nudge-role[data-on=\"1\"]{border-color:var(--dsw-alias-border-l1,#888);background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14))}",
	".dsh-nudge-role:disabled{opacity:.5;cursor:not-allowed}",
	".dsh-nudge-rolename{font-size:12px;line-height:1.4}",
	".dsh-nudge-rolesize{font-size:11px;line-height:1.4;opacity:.65;font-variant-numeric:tabular-nums}",
	".dsh-nudge-parts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px}",
	".dsh-nudge-partslabel{font-size:11px;opacity:.65;margin-right:2px}",
			".dsh-nudge-settings{max-width:820px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-settings h2{margin:0;font-size:18px;font-weight:600}",
			".dsh-nudge-intro{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-group{display:flex;flex-direction:column;gap:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:0 16px 4px;scroll-margin-top:52px}",
			".dsh-nudge-group-title{margin:0;flex:1;font-size:13px;font-weight:600;line-height:20px;letter-spacing:0;color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-group-head{display:flex;align-items:center;gap:12px;padding:10px 0 7px;border-bottom:0.5px solid var(--dsw-alias-border-l2);position:sticky;top:38px;z-index:1;background:var(--dsw-alias-bg-l1)}",
			".dsh-nudge-group-head .dsh-nudge-actions{padding:0;margin:0}",
			".dsh-nudge-group-head .dsh-nudge-btn{font-size:12px;line-height:16px;padding:2px 9px;border-radius:6px;opacity:.8}",
			".dsh-nudge-group-head .dsh-nudge-btn:hover:not(:disabled){opacity:1}",
			".dsh-nudge-group-head .dsh-nudge-group-toggle{margin:0;flex:1}",
			".dsh-nudge-group .dsh-nudge-intro{padding:7px 0 1px}",
			".dsh-nudge-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:6px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}",
			/* 被别的开关压住的那一行：说明白，别让人以为开关坏了。 */
			".dsh-nudge-row[data-muted=\"1\"] .dsh-nudge-label{opacity:.6}",
			".dsh-nudge-row[data-muted=\"1\"] .dsh-nudge-hint{color:var(--dsw-alias-state-business-primary);opacity:.85}",
			".dsh-nudge-group-head + .dsh-nudge-row{border-top:0}",
			".dsh-nudge-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
			".dsh-nudge-label{font-size:13px;line-height:20px}",
			".dsh-nudge-hint{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-input{width:110px;flex:none;font:inherit;font-size:13px;padding:5px 8px;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-areas{width:260px;flex:none;font:inherit;font-size:13px;line-height:20px;padding:6px 8px;border-radius:7px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);resize:vertical;min-height:64px}",
			".dsh-nudge-switch{flex:none;width:36px;height:20px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
	".dsh-nudge-group-toggle{margin:10px 0 2px;padding:0;border:0;background:none;font:inherit;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-align:left}",
	".dsh-nudge-group-toggle:hover{color:var(--dsw-alias-label-primary)}",
	".dsh-nudge-group-toggle[data-on=\"1\"]{color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
			".dsh-nudge-card{position:relative;display:block;width:384px;max-width:100%;box-sizing:border-box;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1);font-family:\"Microsoft YaHei UI\",\"Microsoft YaHei\",\"Segoe UI\",Arial,sans-serif;line-height:1.25;padding:0}",
			".dsh-nudge-card-strip{position:absolute;left:1px;top:13px;bottom:13px;width:3px;border-radius:1.5px;background:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-card-body{display:flex;flex-direction:column;padding:14px 16px 14px 20px;min-width:0}",
			/* 关掉上面的块之后，顶上那块不该再带着自己的上边距（真卡里是同一个规则，见 popup.ps1 的 $firstCarrier）。 */
			".dsh-nudge-card-body > *:first-child{margin-top:0}",
			".dsh-nudge-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:2px}",
			".dsh-nudge-card-ctx{display:flex;align-items:baseline;margin-top:7px}",
			".dsh-nudge-card-task{display:flex;align-items:baseline;margin-top:2px;line-height:18px}",
			".dsh-nudge-card-verdict{margin-top:8px;border-radius:6px;padding:6px 9px;background:var(--dsw-alias-bg-l2);display:flex;flex-direction:column}",
			".dsh-nudge-card-verdictrow{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;line-height:15px}",
			".dsh-nudge-card-rule{height:1px;margin:11px 0 1px;background:var(--dsw-alias-border-l2)}",
			".dsh-nudge-card-more{display:flex;align-items:baseline;margin-top:8px}",
			".dsh-nudge-card-footer{display:flex;align-items:baseline;margin-top:12px}",
				".dsh-nudge-card-bar{display:flex;align-items:center;gap:10px;padding:9px 0 2px;margin-top:10px;border-top:0.5px solid color-mix(in srgb,currentColor 16%,transparent)}",
				".dsh-nudge-card-bar-space{flex:1}",
				".dsh-nudge-card-bar .dsh-nudge-btn{font-size:10.5px;padding:3px 8px;border-radius:6px;border:0.5px solid color-mix(in srgb,currentColor 20%,transparent);background:transparent;color:inherit;cursor:pointer;white-space:nowrap}",
				".dsh-nudge-card-bar .dsh-nudge-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}",
				".dsh-nudge-card-bar .dsh-nudge-btn:disabled{opacity:.45;cursor:not-allowed}",
			".dsh-nudge-card-hit{padding:0 2px;margin:0 -2px;border-radius:4px;cursor:pointer;border:0.5px solid transparent;white-space:pre-wrap}",
			".dsh-nudge-card-hit:hover{background:var(--dsw-alias-bg-l2)}",
			".dsh-nudge-card-hit[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent)}",
	".dsh-nudge-focusline{margin:10px 0 0;font-size:12px;line-height:1.5;opacity:.85}",
	".dsh-nudge-focusline b{font-weight:600;color:var(--dsw-alias-state-business-primary)}",
	".dsh-nudge-roles .dsh-nudge-role[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-actions{display:flex;gap:8px;flex-wrap:wrap;padding:6px 0 10px}",
			".dsh-nudge-btn{font:inherit;font-size:13px;line-height:18px;padding:6px 12px;border-radius:8px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
			".dsh-nudge-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-btn:disabled{opacity:.5;cursor:not-allowed}",
			".dsh-nudge-btn[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-applybar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:0.5px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-l1);box-shadow:0 2px 12px rgba(0,0,0,.12)}",
			".dsh-nudge-applytext{flex:1;font-size:13px;line-height:20px}",
			".dsh-nudge-applywhere{display:flex;align-items:center;flex-wrap:wrap;font-size:12px;line-height:18px;opacity:.75}",
			".dsh-nudge-applysep{opacity:.6}",
			".dsh-nudge-applylink{padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}",
			".dsh-nudge-applylink:hover{opacity:.8}",
			".dsh-nudge-applybar[data-dirty=\"0\"]{border-color:var(--dsw-alias-border-l2);box-shadow:none}",
			/* 全部恢复默认：靠边一条，不抢「应用」的位置。 */
			".dsh-nudge-resetall{display:flex;align-items:center;gap:10px;padding:2px 0 6px}",
			".dsh-nudge-resetall .dsh-nudge-btn[data-armed=\"1\"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".dsh-nudge-group[data-dirty=\"1\"]{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-group[data-dirty=\"1\"] .dsh-nudge-group-title::after{content:\" ·\";color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-nav{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:6px 0;background:var(--dsw-alias-bg-l1)}",
			".dsh-nudge-navbtn{font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:999px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-navbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}",
			/* 当前滚到的那一组：实心描边 + 主色文字，一眼知道自己在哪。 */
			".dsh-nudge-navbtn[data-on=\"1\"]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)}",
			".dsh-nudge-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dsh-nudge-stamp{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);opacity:.75}",
			".dsh-nudge-swatches{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 0 4px}",
			".dsh-nudge-swatch{display:inline-flex;align-items:center;padding:3px 4px;border-radius:999px}",
			".dsh-nudge-swatch:hover{border-color:var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-swatch[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}",
			".dsh-nudge-swatchdot{width:10px;height:10px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l2);flex:none}",
	".dsh-nudge-block{display:flex;flex-direction:column;gap:0;padding:6px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}",
	".dsh-nudge-anchors{display:grid;grid-template-columns:repeat(3,58px);gap:6px;margin-top:6px}",
	".dsh-nudge-anchor{position:relative;height:38px;padding:0;border-radius:8px;cursor:pointer;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary)}",
	".dsh-nudge-anchor:hover{border-color:var(--dsw-alias-state-business-primary)}",
	".dsh-nudge-anchor[data-on=\"1\"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}",
	".dsh-nudge-anchor:disabled{cursor:default;opacity:.6}",
	".dsh-nudge-anchorbar{position:absolute;width:18px;height:11px;border-radius:3px;background:currentColor;opacity:.5}",
	".dsh-nudge-anchor[data-on=\"1\"] .dsh-nudge-anchorbar{background:var(--dsw-alias-state-business-primary);opacity:.9}",
	".dsh-nudge-anchor[data-anchor$=\"-left\"] .dsh-nudge-anchorbar{left:5px}",
	".dsh-nudge-anchor[data-anchor$=\"-right\"] .dsh-nudge-anchorbar{right:5px}",
	".dsh-nudge-anchor[data-anchor$=\"-center\"] .dsh-nudge-anchorbar,.dsh-nudge-anchor[data-anchor=\"center\"] .dsh-nudge-anchorbar{left:50%;margin-left:-9px}",
	".dsh-nudge-anchor[data-anchor^=\"top\"] .dsh-nudge-anchorbar{top:5px}",
	".dsh-nudge-anchor[data-anchor^=\"bottom\"] .dsh-nudge-anchorbar{bottom:5px}",
	".dsh-nudge-anchor[data-anchor^=\"middle\"] .dsh-nudge-anchorbar,.dsh-nudge-anchor[data-anchor=\"center\"] .dsh-nudge-anchorbar{top:50%;margin-top:-5px}",
			"@media (max-width:680px){.dsh-nudge-row{grid-template-columns:minmax(0,1fr);row-gap:6px}.dsh-nudge-areas{width:100%}}",
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
		/**
 * 九宫格里挑一个落点：选中的那一格会亮起来，格子里的小条就代表卡片。
 * @param {object} props 组件属性
 * @returns {import("react").ReactElement} 九宫格
 */
function AnchorGrid(props) {
	return h(
		"div",
		{ className: "dsh-nudge-anchors", role: "group", "aria-label": "卡片落点" },
		ANCHOR_CELLS.map((cell) =>
			h(
				"button",
				{
					key: cell.id,
					type: "button",
					className: "dsh-nudge-anchor",
					"data-anchor": cell.id,
					"data-on": props.value === cell.id ? "1" : "0",
					disabled: props.disabled,
					title: cell.hint,
					onClick: () => props.onPick(cell.id),
				},
				[h("span", { key: "bar", className: "dsh-nudge-anchorbar" })],
			),
		),
	);
}

/**
 * 一排现成色块，第一颗是「跟随主题」。
 * @param {object} props 组件属性
 * @returns {import("react").ReactElement} 色块行
 */
function ColorSwatches(props) {
	return h(
		"div",
		{ className: "dsh-nudge-swatches" },
		COLOR_CHOICES.map(([value, name]) =>
			h(
				"button",
				{
					key: value === "" ? "auto" : value,
					type: "button",
					className: "dsh-nudge-swatch",
					"data-swatch": value === "" ? "auto" : value,
					"data-on": props.value === value ? "1" : "0",
					disabled: props.disabled,
					onClick: () => props.onPick(value),
					title: value === "" ? "不指定颜色，跟着主题走" : name + " " + value,
				},
				[
					h("span", { key: "dot", className: "dsh-nudge-swatchdot", style: { background: value === "" ? "transparent" : value } }),
				],
			),
		),
	);
}

function SwitchRow(props) {
			return h("div", { className: "dsh-nudge-row", "data-muted": props.muted === true ? "1" : "0" }, [
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
				// 清空输入框是编辑中的正常中间态，不是「想要最小值」：
				// Number("") 是 0，不拦住就会把停留秒数写成 1 秒、清单条数写成 1 条。
				if (String(draft).trim() === "") {
					setDraft(String(props.value));
					return;
				}
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
			// 宿主半身没装、被禁用、或者 id 对不上时 configForms.get 返回 undefined：
			// 这里必须给一个「不可用」的快照，而不是在渲染期解引用 undefined
			// （那会让承载它的整个设置面板崩掉，连一句说明都看不到）。
			const usable = form !== undefined && form !== null && typeof form.getSnapshot === "function";
			const [snapshot, setSnapshot] = React.useState(() =>
				usable ? form.getSnapshot() : { status: "unavailable", value: undefined, writable: false, revision: 0 },
			);
			React.useEffect(() => {
				if (!usable) return undefined;
				let alive = true;
				const sync = () => {
					if (!alive) return;
					const next = form.getSnapshot();
					setSnapshot((previous) => (previous === next ? previous : next));
				};
				const off = typeof form.subscribe === "function" ? form.subscribe(sync) : () => {};
				sync();
				return () => {
					alive = false;
					if (typeof off === "function") off();
				};
			}, [form, usable]);
			return snapshot;
		}

		/** 每一类文字的默认字号：和 lib/popup.ps1 里 New-Text 的兜底值一致，样卡才画得像真的。 */
		const ROLE_SIZE = { title: 14, project: 15.5, task: 12.5, reason: 10.5, status: 10.5, time: 10, more: 10.5, footer: 10 };
		/** 九宫格：九个位置，按 CSS 网格的顺序排成三行三列。 */
const ANCHOR_CELLS = [
	{ id: "top-left", hint: "左上角" },
	{ id: "top-center", hint: "上边中间" },
	{ id: "top-right", hint: "右上角" },
	{ id: "middle-left", hint: "左边中间" },
	{ id: "center", hint: "正中" },
	{ id: "middle-right", hint: "右边中间" },
	{ id: "bottom-left", hint: "左下角" },
	{ id: "bottom-center", hint: "下边中间" },
	{ id: "bottom-right", hint: "右下角（默认）" },
];

const COLOR_CHOICES = [["", "跟随主题"], ["#FFFFFF", "白"], ["#E6E6E6", "浅灰"], ["#9AA0A6", "灰"], ["#111111", "黑"], ["#FF6B6B", "红"], ["#FFA84D", "橙"], ["#FFD43B", "黄"], ["#51CF66", "绿"], ["#4DABF7", "蓝"], ["#B197FC", "紫"]];
		/**
		 * 样卡里每一行的示例文字：和宿主 `lib/index.js` 的 `PREVIEW_SAMPLE` 逐字一致。
		 * 自测两边对一遍——样卡上看到的，就是点「在桌面上弹一张看看」拿到的那张卡。
		 */
		const ROLE_SAMPLE = {
			title: "完成",
			time: "12:04",
			project: "dsh-nudge",
			task: "把设置页的样卡改成和真卡一样",
			status: "完成：",
			reason: "改完自测全过，顺手把提示文案也收了一档",
			more: "还有 2 条未展开",
			footer: "点击卡片回到 DeepSeek Harness",
		};
		/** 样卡里每一行的浓淡与字重：颜色留空时按这套走，贴近真卡片的层次。 */
		/** 每一类文字在真卡里的浓淡：颜色留空时按这个透明度走（对齐 popup.ps1 的 TextPrimary / TextBody / TextMuted 等）。 */
const ROLE_LOOK = {
	title: { opacity: 1, weight: 600 },
	project: { opacity: 1, weight: 600 },
	task: { opacity: 0.94, weight: 400 },
	reason: { opacity: 0.86, weight: 400 },
	status: { opacity: 1, weight: 600 },
	time: { opacity: 0.36, weight: 400 },
	more: { opacity: 0.46, weight: 400 },
	footer: { opacity: 0.35, weight: 400 },
};
		/** 样卡配色：auto 跟着页面主题走，light / dark 强制成对应底色。 */
		const THEME_SKIN = {
			auto: null,
			light: { background: "#ffffff", color: "#1b1b1f", borderColor: "rgba(0,0,0,.12)" },
			dark: { background: "#1f2124", color: "#f2f3f5", borderColor: "rgba(255,255,255,.14)" },
		};
		/**
		 * 每一组「恢复默认」写回去的值。必须和 `lib/index.js` 的 `DEFAULTS` 一致，
		 * 自测会拿这份逐项比对（`exports.groupDefaults` 就是给它看的）。
		 * 一组只管一件事：文字 / 卡片 / 位置 / 提醒 / 点击 / 时机 / 合并 / 调试。
		 * 「预览」那组只画样卡，没有配置项，所以不在这里。
		 */
		const GROUP_DEFAULTS = [
			["type", []],
			["card", [
				["width", 384],
				["cardColor", ""],
				["accentColor", ""],
				["theme", "auto"],
			]],
			["place", [
				["anchor", "bottom-right"],
				["staySeconds", 15],
				["margin", 16],
				["rememberPosition", true],
			]],
			["basic", [
				["enabled", true],
				["kinds.completed", true],
				["kinds.needs_choice", true],
				["kinds.failed", true],
			]],
			["click", [
				["clickToFocus", true],
				["clickThrough", false],
			]],
			["when", [
				["showWhenFocused", true],
				["suppressWhenFullscreen", true],
				["alertOnToolError", true],
				["quietToolErrors", true],
			]],
			["merge", [
				["mergeWindowMs", 1200],
				["maxItems", 8],
				["muteRanges", []],
			]],
			["debug", [
				["debugPreview", false],
				["debugPayload", false],
				["debugFile", ""],
			]],
		];
		for (const [role] of FONT_ROLES) {
			GROUP_DEFAULTS[0][1].push(["typography." + role + ".color", ""], ["typography." + role + ".size", 0]);
		}
		/** 卡片上可以关掉的那几块：键名与宿主 DEFAULTS.visible 一致。 */
		const CARD_PARTS = [
			["title", "标题行"],
			["project", "项目名"],
			["task", "任务名"],
			["status", "状态与原因"],
			["items", "提醒列表"],
			["more", "展开提示"],
			["footer", "底部提示"],
		];
		/* 「显示哪几块」是卡片本身的事，归「卡片」那一组。 */
		const cardGroup = GROUP_DEFAULTS.find((item) => item[0] === "card");
		for (const [part] of CARD_PARTS) cardGroup[1].push(["visible." + part, true]);

		/** 静音时段的写法：小时 0–23、分钟 0–59，中间允许空格。 */
		const RANGE_PATTERN = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u;

		/**
		 * 把静音时段拆成「能用的」「写法不对的」「写法能认但超出 24 小时的」三堆。
		 *
		 * 第三堆必须单独拎出来：宿主 `inMuteRange` 只跳过 `from === to`，没有 1439 上限，
		 * 所以 `25:00-08:00` 在宿主那边是**真的会静音**（按 from > to 走跨零点分支，
		 * 等于每天 00:00–08:00 不弹）。页面要是把它当「会被跳过」报出去，就是在骗人。
		 * @param {string[]} ranges 原始行
		 * @returns {{bad: string[], odd: {line: string, from: number, to: number}[], slots: {from: number, to: number}[]}} 结果
		 */
		function splitRanges(ranges) {
			const bad = [];
			const odd = [];
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
				if (from === to) continue;
				// 照样入 slots：页面的「现在是否静音」要和宿主算得一模一样。
				slots.push({ from, to });
				if (from > 1439 || to > 1439) odd.push({ line, from, to });
			}
			return { bad, odd, slots };
		}

		/**
		 * 把「当天第几分钟」写回 HH:MM，越界就按 24 小时取模，用来解释 odd 那几行实际怎么算。
		 * @param {number} minutes 分钟数
		 * @returns {string} HH:MM
		 */
		function clockText(minutes) {
			const wrapped = ((minutes % 1440) + 1440) % 1440;
			return String(Math.floor(wrapped / 60)).padStart(2, "0") + ":" + String(wrapped % 60).padStart(2, "0");
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
			/** 现在滚到哪一组：导航按钮靠它高亮。 */
			const [activeGroup, setActiveGroup] = React.useState("preview");
			/** 「全部恢复默认」是不是已经点过第一下（等第二下确认）。 */
			const [resetAllArmed, setResetAllArmed] = React.useState(false);
			/** 字号那组是否展开成「8 行一起看」。 */
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
			/**
			 * 改动的组名（按页面顺序）：页脚的应用栏靠它告诉人「改的是哪几组」，
			 * 九组之后光看「N 项」已经想不起来是在哪儿改的了。
			 */
			const dirtyGroupNames = GROUP_DEFAULTS.filter(([id]) => groupDirty(id) > 0).map(
				([id]) => (NAV_GROUPS.find(([navId]) => navId === id) ?? [id, id])[1],
			);
			/** 跳到某一组。 */
			const jumpTo = (id) => {
				if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
				const target = document.getElementById("dsh-nudge-g-" + id);
				if (target !== null && typeof target.scrollIntoView === "function")
					target.scrollIntoView({ block: "start", behavior: "smooth" });
				// 立刻点亮，不等滚动结束：点了按钮就该看见反馈。
				setActiveGroup(id);
			};
			/**
			 * 滚动时高亮「现在在哪一组」。
			 *
			 * 用 IntersectionObserver 而不是 scroll 事件：九组的分组标题是 sticky 的，滚动事件里
			 * 得自己算每一组相对 38px 导航条的位置，还要跟着窗口尺寸变；观察器只告诉我们
			 * 「哪些组还在视口里」，取其中最靠上的一组即可。
			 * 拿不到观察器（老浏览器、自测沙箱）就什么都不做，导航仍可点。
			 */
			React.useEffect(() => {
				if (typeof document === "undefined" || typeof IntersectionObserver !== "function") return undefined;
				const nodes = NAV_GROUPS.map(([id]) => document.getElementById("dsh-nudge-g-" + id)).filter(
					(node) => node !== null && node !== undefined,
				);
				if (nodes.length === 0) return undefined;
				/** 视口里还看得见的组：id → 顶部位置。 */
				const visible = new Map();
				const observer = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							const id = String(entry.target.id ?? "").replace("dsh-nudge-g-", "");
							if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
							else visible.delete(id);
						}
						if (visible.size === 0) return;
						// 最靠上（top 最小）的那一组就是「正在看」的；导航条挡住的也算进来。
						let best = "";
						let bestTop = Number.POSITIVE_INFINITY;
						for (const [id, top] of visible) {
							if (top < bestTop) {
								bestTop = top;
								best = id;
							}
						}
						if (best !== "") setActiveGroup((current) => (current === best ? current : best));
					},
					{ rootMargin: "-38px 0px -55% 0px", threshold: 0 },
				);
				for (const node of nodes) observer.observe(node);
				return () => observer.disconnect();
			}, []);

			/** 把草稿里与当前值不同的项一次性写回去。 */
			const applyDraft = () => {
				setFailure("");
				const ops = [];
				for (const path of draftPaths) {
					if (sameField(value, path, draft[path])) continue;
					ops.push({ op: "set", path: path.split("."), value: draft[path] });
				}
				if (ops.length === 0) {
					setDraft({});
					return;
				}
				// 先把草稿收起来，界面立刻干净；写回被拒或抛错再放回去，用户不用重填。
				const backup = { ...draft };
				setDraft({});
				/**
				 * 失败回滚：只把「这次提交的 path」放回草稿，而且用户在等待期间又改过的
				 * （当前草稿里已经有这个 path）保留新值——整块 setDraft(backup) 会把这几秒
				 * 里的新输入悄悄吃掉。
				 * @param {Record<string, unknown>} current 当前草稿
				 * @returns {Record<string, unknown>} 合并后的草稿
				 */
				const rollback = (current) => {
					const merged = { ...current };
					for (const item of ops) {
						const path = item.path.join(".");
						if (Object.hasOwn(merged, path)) continue;
						if (Object.hasOwn(backup, path)) merged[path] = backup[path];
					}
					return merged;
				};
				/**
				 * 取一个尽量新鲜的 revision：批量写被拒很可能是「别处刚改过」的冲突，
				 * 拿闭包里那份旧 revision 逐项重试，N 次必然全败。
				 * @returns {number} revision
				 */
				const revisionNow = () => {
					try {
						const fresh = form.getSnapshot?.();
						if (fresh !== undefined && Number.isFinite(fresh.revision)) return fresh.revision;
					} catch {}
					return snapshot.revision;
				};
				/** 一条条试：哪几项宿主不要，就把它们点出来。 */
				const retryOneByOne = (note) => {
					const bad = [];
					const step = (index) => {
						if (index >= ops.length) {
							// 走完一轮才说话：全部通过就清掉提示，有被拒的就把路径点出来。
							setFailure(bad.length === 0 ? "" : `${note}宿主没接受这几项：${bad.join("、")}`);
							return;
						}
						const item = ops[index];
						const path = item.path.join(".");
						Promise.resolve()
							.then(() => form.mutate([item], revisionNow()))
							.then((ok) => {
								if (ok === false) bad.push(path);
							})
							.catch(() => {
								bad.push(path);
							})
							.then(() => step(index + 1));
					};
					step(0);
					return bad;
				};

				let result;
				try {
					result = form.mutate(ops, snapshot.revision);
				} catch (error) {
					// 同步抛错：不能再走 retryOneByOne（它此时还没被初始化），直接说清楚。
					setSaved(false);
					setDraft(rollback);
					setFailure(`写入失败：${error instanceof Error ? error.message : String(error)}`);
					return;
				}
				// 「已保存」先亮起来：写回是本地调用，落盘由宿主负责；失败再翻回去。
				setSaved(true);
				// 两秒后自己熄掉。自测沙箱里没有定时器，取不到就跳过。
				const later = globalThis.setTimeout;
				if (typeof later === "function") later(() => setSaved(false), 2000);

				Promise.resolve(result)
					.then((ok) => {
						if (ok === false) {
							setSaved(false);
							setDraft(rollback);
							retryOneByOne("整批被拒（可能是别处刚改过，已按最新版本逐项重试）；");
						}
					})
					.catch((error) => {
						setSaved(false);
						setDraft(rollback);
						retryOneByOne(`写入失败：${error instanceof Error ? error.message : String(error)}；`);
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
			/**
			 * 所有组的默认值摊成一张 path → 值 的表，供「全部恢复默认」用。
			 * 同一个 path 出现在两组里时后者覆盖前者——GROUP_DEFAULTS 本身就是「一 field 一组」，
			 * 出现重复说明分组写错了，这里不额外报错，取最后一份即可。
			 * @returns {{ path: string, value: unknown }[]} 全部默认值
			 */
			const allDefaults = () => {
				const merged = new Map();
				for (const [, entries] of GROUP_DEFAULTS) {
					for (const [path, value] of entries) merged.set(path, value);
				}
				return [...merged].map(([path, value]) => ({ path, value }));
			};

			/**
			 * 把一层层嵌套的对象摊成 `a.b.c` 这样的路径。
			 * 宿主只认叶子上的 volatile 字段，整块写 kinds / typography 会被直接拒绝。
			 * @param {string} prefix 前缀路径
			 * @param {unknown} value 值
			 * @returns {{ path: string, value: unknown }[]} 摊平后的项
			 */
			const flattenConfig = (prefix, value) => {
				if (value === null || typeof value !== "object" || Array.isArray(value)) return [{ path: prefix, value }];
				const out = [];
				for (const [key, child] of Object.entries(value)) out.push(...flattenConfig(prefix + "." + key, child));
				return out;
			};

			/** 能导出、也能导入的配置项。 */
			const CONFIG_KEYS = [
				"enabled",
				"staySeconds",
				"showWhenFocused",
				"suppressWhenFullscreen",
				"clickToFocus",
				"clickThrough",
				"margin",
				"anchor",
				"width",
				"cardColor",
				"accentColor",
				"mergeWindowMs",
				"maxItems",
				"alertOnToolError",
				"quietToolErrors",
				"muteRanges",
				"kinds",
				"theme",
				"typography",
				"visible",
				"debugPreview",
				"debugPayload",
				"debugFile",
				"rememberPosition",
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
				const entries = [];
				for (const key of keys) entries.push(...flattenConfig(key, parsed[key]));
				writeMany(entries);
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
			/**
			 * 一个十六进制输入行：和字号组里那个同一个写法，只是绑定到别的键上。
			 * @param {string} path 配置键
			 * @param {string} label 显示名
			 * @param {string} placeholder 占位示例
			 * @returns {import("react").ReactElement} 输入行
			 */
			const focusedRow = (path, label, placeholder) =>
				h(TextRow, {
					key: path,
					label: label + "（十六进制）",
					hint: "写 #RRGGBB；留空跟随主题。",
					value: text(path),
					placeholder,
					disabled,
					onCommit: (next) => write(path, next),
				});
			/** 这一类现在用的颜色，留空表示跟随主题。 */
			const colorNow = (role) => text("typography." + role + ".color");
			/**
			 * 样卡里这一行的内联样式。
			 * 真卡用的是半透明颜色（正文 #F0FFFFFF 就是 94% 的白），不是给整块加 opacity——
			 * opacity 会把边框和底色一起压淡，所以之前样卡看着比真卡淡。
			 * @param {string} role 文字类别
			 * @returns {Record<string, string|number>} 可直接给 CSS 的样式
			 */
			const cardFont = (role) => {
				const look = ROLE_LOOK[role];
				const own = text("typography." + role + ".color");
				const accent = typeof look.accent === "string" ? look.accent : null;
				const tint =
					own !== ""
						? own
						: accent !== null
							? accent
							: "color-mix(in srgb, currentColor " + Math.round(look.opacity * 100) + "%, transparent)";
				return {
					fontSize: roleSize(role) + "px",
					fontWeight: look.weight,
					color: tint,
				};
			};
			/** 这组预设是不是正好等于现在的配置。 */
			const themeValue = text("theme") === "" ? "auto" : text("theme");
			/** 卡片现在用的宽度：0 表示用脚本里的默认 384。 */
			const cardWidth = num("width") > 0 ? num("width") : 384;
			/**
			 * 分组标题右边那行小字：一眼看清这组现在是什么状态，不用点开才知道。
			 * 全部从当前值算，草稿里改了就跟着变（还没点应用也算「改完会是什么样」）。
			 */
			const themeLabel = themeValue === "auto" ? "跟随系统" : themeValue === "light" ? "浅色" : "深色";
			const anchorNow = text("anchor") === "" ? "bottom-right" : text("anchor");
			const anchorLabel = (() => {
				const found = ANCHOR_CELLS.find((cell) => cell.id === anchorNow);
				return found === undefined ? anchorNow : found.hint.replace("（默认）", "");
			})();
			const kindsLabel = (() => {
				const names = [["completed", "完成"], ["needs_choice", "待选"], ["failed", "失败"]];
				const on = names.filter(([key]) => bool("kinds." + key)).map(([, label]) => label);
				if (!bool("enabled")) return "已关闭";
				if (on.length === names.length) return "三类都弹";
				return on.length === 0 ? "三类都不弹" : "只弹 " + on.join(" / ");
			})();
			const clickLabel = bool("clickThrough") ? "穿透：只当提示" : bool("clickToFocus") ? "点击回到 DSH" : "点击只收起";
			const whenLabel = (() => {
				const parts = [];
				if (!bool("showWhenFocused")) parts.push("前台不弹");
				if (bool("suppressWhenFullscreen")) parts.push("全屏不弹");
				if (bool("quietToolErrors")) parts.push("中途报错先忍");
				if (bool("alertOnToolError")) parts.push("工具报错单独弹");
				return parts.length === 0 ? "不设条件" : parts.join(" · ");
			})();
			const mergeLabel = (() => {
				const window = num("mergeWindowMs");
				const mute = lines("muteRanges").filter((line) => line.trim() !== "").length;
				const head = window <= 0 ? "不合并" : window + "ms 内合并 · 最多 " + num("maxItems") + " 条";
				return mute === 0 ? head : head + " · 静音 " + mute + " 段";
			})();
			const skin = (() => {
				const base = Object.hasOwn(THEME_SKIN, themeValue) ? Object.assign({}, THEME_SKIN[themeValue]) : {};
				base.width = cardWidth + "px";
				base.maxWidth = "100%";
				if (text("cardColor") !== "") base.background = text("cardColor");
				return Object.keys(base).length === 0 ? null : base;
			})();
			/** 竖条的颜色：留空就用 CSS 里那套按主题走的色。 */
			const stripStyle = text("accentColor") === "" ? undefined : { background: text("accentColor") };
			/**
			 * 样卡里的一行：点一下就把它设为正在调的那一类。
			 * @param {string} role 文字类别
			 * @returns {import("react").ReactElement} 可点的一行
			 */
			/** 这一块要不要画：没写过的键按显示处理。 */
			const partOn = (part) => raw("visible." + part) !== false;
			/**
			 * 样卡上这一行显示什么。底部那行说的是「点一下会怎样」，必须跟着点击开关走，
			 * 和宿主 `footerOf` 的三句话逐字一致——否则改完开关，样卡还在教一个不会发生的事。
			 * @param {string} role 文字类别
			 * @returns {string} 示例文字
			 */
			const roleSample = (role) => {
				if (role !== "footer") return ROLE_SAMPLE[role];
				if (bool("clickThrough")) return "仅提示 · 点击穿透，点得到后面的窗口";
				if (!bool("clickToFocus")) return "仅提示 · 点击不跳转，点一下收起";
				return "点击卡片回到 DeepSeek Harness";
			};
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
					roleSample(role),
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
								// 当前在看哪一组：滚动时由 IntersectionObserver 更新，
								// 浏览器不支持时这一项一直是 false，只是没有高亮，不影响跳转。
								"data-on": activeGroup === id ? "1" : "0",
								"aria-current": activeGroup === id ? "true" : "false",
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

				/* ---------------- 预览：只画样卡，没有配置项，所以没有「恢复默认」 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "preview", id: "dsh-nudge-g-preview" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "预览"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, "样卡，改完当场变"),
					]),
					h(
						"p",
						{ className: "dsh-nudge-intro", key: "intro" },
						"桌面上的卡片就是这个样子。点样卡上任一行，会跳到「文字」去调那一类的字号和颜色。",
					),
					h(
						"div",
						{ className: "dsh-nudge-card", key: "card", style: skin === null ? undefined : skin },
						[
							h("div", { className: "dsh-nudge-card-strip", key: "strip", style: stripStyle }),
							h("div", { className: "dsh-nudge-card-body", key: "body" }, [
								partOn("title") ? h("div", { className: "dsh-nudge-card-head", key: "head" }, [cardLine("title"), cardLine("time")]) : null,
								partOn("project") ? h("div", { className: "dsh-nudge-card-ctx", key: "ctx" }, [cardLine("project")]) : null,
								partOn("task") ? h("div", { className: "dsh-nudge-card-task", key: "task" }, [cardLine("task")]) : null,
								partOn("status")
									? h("div", { className: "dsh-nudge-card-verdict", key: "verdict" }, [
											// 真卡的「完成：」和原因是同一行的左右两列，样卡也照这个排。
											h("div", { className: "dsh-nudge-card-verdictrow", key: "row" }, [cardLine("status"), cardLine("reason")]),
										])
									: null,
								partOn("items") ? h("div", { className: "dsh-nudge-card-rule", key: "rule" }) : null,
								partOn("more") ? h("div", { className: "dsh-nudge-card-more", key: "more" }, [cardLine("more")]) : null,
								partOn("footer") ? h("div", { className: "dsh-nudge-card-footer", key: "footer" }, [cardLine("footer")]) : null,
							].filter((node) => node !== null)),
							h(
								"div",
								{ className: "dsh-nudge-card-bar", key: "bar" },
								[
									h("div", { className: "dsh-nudge-card-bar-space", key: "sp" }),
									h(
										"button",
										{
											key: "try",
											type: "button",
											className: "dsh-nudge-btn",
											disabled,
											title: "在桌面右下角真弹一张，拖边改尺寸、拖卡身换位置，都记在「位置」那一组里。",
											onClick: () => writeNow("debugPreview", !bool("debugPreview")),
										},
										bool("debugPreview") ? "收起桌面上的卡片" : "在桌面上弹一张看看",
									),
								],
							),
						],
					),
					h(
						"p",
						{ className: "dsh-nudge-intro", key: "cardhint" },
						"宽 " + cardWidth + "、内边距 14/16、左侧 3px 竖条；文字自上而下固定排布，能调的只有尺寸和字号。",
					),
				]),

				/* ---------------- 文字：每一类的字号与颜色 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "type", id: "dsh-nudge-g-type", "data-dirty": groupDirty("type") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "文字"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, FONT_ROLES.length + " 类文字"),
						h(ResetRow, { key: "reset", group: "type", disabled, onReset: resetGroup }),
					]),
					/* 正在调哪一块，写清楚，免得点完没反应。 */
					h(
						"p",
						{ className: "dsh-nudge-focusline", key: "focus" },
						[
							"正在调 ",
							h("b", { key: "name" }, roleLabel(fontRole)),
							" · " + roleSize(fontRole) + "px · " + (text("typography." + fontRole + ".color") === "" ? "颜色跟随主题" : text("typography." + fontRole + ".color")),
						],
					),
					h(
						"div",
						{ className: "dsh-nudge-roles", key: "chips" },
						FONT_ROLES.map(([role, label]) =>
							h(
								"button",
								{
									key: role,
									type: "button",
									className: "dsh-nudge-role",
									"data-role": role,
									"data-on": fontRole === role ? "1" : "0",
									"aria-pressed": fontRole === role ? "true" : "false",
									disabled,
									title: roleHint(role),
									onClick: () => setFontRole(role),
								},
								[
									h("span", { key: "n", className: "dsh-nudge-rolename" }, label),
									h(
										"span",
										{ key: "s", className: "dsh-nudge-rolesize" },
										roleSize(role) + "px",
									),
								],
							),
						),
					),
					/* 选中的那一类：底下这几行就是它的字号与颜色。 */
					h(NumberRow, {
						key: "size",
						label: "字号（" + roleLabel(fontRole) + "）",
						hint: "填 0 回到默认 " + ROLE_SIZE[fontRole] + "px。",
						value: roleSize(fontRole),
						min: 0,
						max: 48,
						step: 0.5,
						disabled,
						onCommit: (next) => write("typography." + fontRole + ".size", next),
					}),
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
						]),
					)),
					h(TextRow, {
						key: "color",
						label: "颜色（" + roleLabel(fontRole) + "）",
						hint: "写 #RRGGBB，留空跟随主题。",
						value: text("typography." + fontRole + ".color"),
						placeholder: "留空跟随主题",
						disabled,
						onCommit: (next) => write("typography." + fontRole + ".color", next),
					}),
				]),

				/* ---------------- 卡片：显示哪几块 + 尺寸 + 配色 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "card", id: "dsh-nudge-g-card", "data-dirty": groupDirty("card") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "卡片"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, "宽 " + cardWidth + " · " + themeLabel),
						h(ResetRow, { key: "reset", group: "card", disabled, onReset: resetGroup }),
					]),
					h("div", { className: "dsh-nudge-block", key: "parts" }, [
						h("div", { className: "dsh-nudge-text", key: "text" }, [
							h("span", { className: "dsh-nudge-label", key: "label" }, "显示哪几块"),
							h("span", { className: "dsh-nudge-hint", key: "hint" }, "点一下隐藏、再点一下显示；关掉的块不占位置。"),
						]),
						h(
							"div",
							{ className: "dsh-nudge-parts", key: "parts" },
							CARD_PARTS.map(([part, label]) =>
								h(
									"button",
									{
										key: part,
										type: "button",
										className: "dsh-nudge-role",
										"data-part": part,
										"data-on": partOn(part) ? "1" : "0",
										disabled,
										title: (partOn(part) ? "点一下隐藏「" : "点一下显示「") + label + "」",
										onClick: () => write("visible." + part, !partOn(part)),
									},
									label,
								),
							),
						),
					]),
					h(NumberRow, {
						key: "width",
						label: "卡片宽度",
						hint: "260–900；填 0 用默认 384。拖卡片的边也能改，改完记在「位置」里。",
						value: num("width"),
						min: 0,
						max: 900,
						step: 4,
						disabled,
						onCommit: (next) => write("width", next),
					}),
					h(SelectRow, {
						key: "theme",
						label: "配色",
						hint: "auto 跟随系统深浅色。",
						value: themeValue,
						options: [
							{ value: "auto", label: "跟随系统" },
							{ value: "light", label: "浅色" },
							{ value: "dark", label: "深色" },
						],
						disabled,
						onChange: (next) => write("theme", next),
					}),
					h("div", { className: "dsh-nudge-block", key: "cardcolor" }, [
						h("div", { className: "dsh-nudge-text", key: "text" }, [
							h("span", { className: "dsh-nudge-label", key: "label" }, "卡片底色"),
							h("span", { className: "dsh-nudge-hint", key: "hint" }, "留空跟随主题。" ),
						]),
						h(ColorSwatches, { key: "sw", value: text("cardColor"), disabled, onPick: (next) => write("cardColor", next) }),
						focusedRow("cardColor", "底色", "#1F2430"),
					]),
					h("div", { className: "dsh-nudge-block", key: "accentcolor" }, [
						h("div", { className: "dsh-nudge-text", key: "text" }, [
							h("span", { className: "dsh-nudge-label", key: "label" }, "左侧竖条"),
							h("span", { className: "dsh-nudge-hint", key: "hint" }, "留空按类别：完成绿、待选橙、失败红。" ),
						]),
						h(ColorSwatches, { key: "sw", value: text("accentColor"), disabled, onPick: (next) => write("accentColor", next) }),
						focusedRow("accentColor", "竖条", "#4DABF7"),
					]),
				]),

				/* ---------------- 位置与停留 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "place", id: "dsh-nudge-g-place", "data-dirty": groupDirty("place") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "位置与停留"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, anchorLabel + " · " + num("staySeconds") + "s"),
						h(ResetRow, { key: "reset", group: "place", disabled, onReset: resetGroup }),
					]),
					h("div", { className: "dsh-nudge-block", key: "anchor" }, [
						h("div", { className: "dsh-nudge-text", key: "text" }, [
							h("span", { className: "dsh-nudge-label", key: "label" }, "卡片落在哪"),
							h("span", { className: "dsh-nudge-hint", key: "hint" }, "点一格就是那个位置；拖过卡片之后以拖到的地方为准。" ),
						]),
						h(AnchorGrid, { key: "grid", value: text("anchor") === "" ? "bottom-right" : text("anchor"), disabled, onPick: (next) => write("anchor", next) }),
					]),
					h(NumberRow, {
						key: "staySeconds",
						label: "停留秒数",
						hint: "1–600 秒；待你选择的卡片按三倍算（不少于 30 秒）。",
						value: num("staySeconds"),
						min: 1,
						max: 600,
						disabled,
						onCommit: (next) => write("staySeconds", next),
					}),
					h(NumberRow, {
						key: "margin",
						label: "距屏幕边缘",
						hint: "0–400 像素。",
						value: num("margin"),
						min: 0,
						max: 400,
						disabled,
						onCommit: (next) => write("margin", next),
					}),
					h(SwitchRow, {
						key: "rememberPosition",
						label: "记住拖过的位置",
						hint: "拖过之后下次还在那儿；拖边改的尺寸也一起记住。换了落点就回到那个角落。",
						checked: bool("rememberPosition"),
						disabled,
						onChange: (next) => write("rememberPosition", next),
					}),
				]),

				/* ---------------- 提醒：弹不弹、弹哪几类 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "basic", id: "dsh-nudge-g-basic", "data-dirty": groupDirty("basic") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "提醒"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, kindsLabel),
						h(ResetRow, { key: "reset", group: "basic", disabled, onReset: resetGroup }),
					]),
					h(SwitchRow, {
						key: "enabled",
						label: "启用提醒弹窗",
						hint: "关掉就不再弹任何卡片。",
						checked: bool("enabled"),
						disabled,
						onChange: (next) => write("enabled", next),
					}),
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
						hint: "等你确认或者提问时提醒。",
						checked: bool("kinds.needs_choice"),
						disabled,
						onChange: (next) => write("kinds.needs_choice", next),
					}),
					h(SwitchRow, {
						key: "failed",
						label: "执行失败",
						hint: "报错、工具失败时提醒。",
						checked: bool("kinds.failed"),
						disabled,
						onChange: (next) => write("kinds.failed", next),
					}),
				]),

				/* ---------------- 点击：点一下会发生什么 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "click", id: "dsh-nudge-g-click", "data-dirty": groupDirty("click") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "点击"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, clickLabel),
						h(ResetRow, { key: "reset", group: "click", disabled, onReset: resetGroup }),
					]),
					h(SwitchRow, {
						key: "clickToFocus",
						label: "点击卡片回到 DSH",
						hint: "关掉后点一下只是把卡片收起来：不跳回 DSH，也不往剪贴板写这批提醒。",
						checked: bool("clickToFocus"),
						disabled,
						onChange: (next) => write("clickToFocus", next),
					}),
					h(SwitchRow, {
						key: "clickThrough",
						label: "鼠标穿透（纯提示）",
						hint: "卡片完全不接鼠标：点下去落到后面的窗口上，等于它不存在。想彻底只当提示，把上面那颗也关掉；代价是不能拖、不能右键关，只等停留时间到点自己消失。预览卡不受影响。",
						checked: bool("clickThrough"),
						disabled,
						onChange: (next) => write("clickThrough", next),
					}),
				]),

				/* ---------------- 时机：什么时候别弹 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "when", id: "dsh-nudge-g-when", "data-dirty": groupDirty("when") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "什么时候弹"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, whenLabel),
						h(ResetRow, { key: "reset", group: "when", disabled, onReset: resetGroup }),
					]),
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
						key: "quietToolErrors",
						label: "回合中途报错不弹",
						hint: "AI 还在跑的时候工具出错先不打扰，等这一回合真的出错结束再提醒。",
						checked: bool("quietToolErrors"),
						disabled,
						onChange: (next) => write("quietToolErrors", next),
					}),
					h(SwitchRow, {
						key: "alertOnToolError",
						label: "工具报错也单独提醒",
						// 这一条会被上面那条整条压掉（宿主：quietToolErrors 为真时直接 return），
						// 所以两者都开时必须当场说明白，否则用户会以为开关坏了。
						hint: bool("quietToolErrors")
							? "上面「回合中途报错不弹」开着，这一条现在不生效——工具报错会攒到回合结束再弹。想立刻弹，先关掉那一条。"
							: "单个工具调用失败时立刻弹一条（关掉就只在回合结束时提醒）。",
						checked: bool("alertOnToolError"),
						muted: bool("quietToolErrors"),
						disabled,
						onChange: (next) => write("alertOnToolError", next),
					}),
				]),

				/* ---------------- 合并与静音 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "merge", id: "dsh-nudge-g-merge", "data-dirty": groupDirty("merge") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
						h("p", { className: "dsh-nudge-group-title", key: "title" }, "合并与静音"),
						h("span", { className: "dsh-nudge-hint", key: "note" }, mergeLabel),
						h(ResetRow, { key: "reset", group: "merge", disabled, onReset: resetGroup }),
					]),
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
					mute.odd.length === 0
						? null
						: h(
								"p",
								{ className: "dsh-nudge-warn", key: "muteodd", role: "alert" },
								"这几行超出 24 小时，宿主不会跳过、而是照原样算：" +
									mute.odd
										.map((item) => `${item.line} → 实际按 ${clockText(item.from)}–${clockText(item.to)} 静音`)
										.join("；") +
									"。建议改成 00:00 起算的写法。",
							),
					mute.slots.length === 0 && mute.bad.length === 0
						? null
						: h(
								"p",
								{ className: "dsh-nudge-warn", key: "mutestate" + clock },
								muted ? "现在正处于静音时段，卡片不会弹。" : "现在不在静音时段。",
							),
				]),

				/* ---------------- 调试：默认收着 ---------------- */
				h("div", { className: "dsh-nudge-group", key: "debug", id: "dsh-nudge-g-debug", "data-dirty": groupDirty("debug") > 0 ? "1" : "0" }, [
					h("div", { className: "dsh-nudge-group-head", key: "head" }, [
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
						h(ResetRow, { key: "reset", group: "debug", disabled, onReset: resetGroup }),
					]),
					/* 预览卡不在这儿再开一个入口：「预览」组样卡底下那颗按钮已经是它了。 */
					debugOpen
						? h(
								"p",
								{ className: "dsh-nudge-intro", key: "previewhint" },
								"想看真卡长什么样、或者拖一拖摆位置：回「预览」组，点样卡底下那颗「在桌面上弹一张看看」。",
							)
						: null,
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
							h("div", { className: "dsh-nudge-text", key: "text" }, [
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
					/* 改在哪几组：点一下跳过去，省得在九组里翻。 */
					pending > 0 && dirtyGroupNames.length > 0
						? h(
								"span",
								{ className: "dsh-nudge-applywhere", key: "where" },
								dirtyGroupNames.map((name, index) => [
									index === 0 ? null : h("span", { key: "sep" + index, className: "dsh-nudge-applysep" }, " · "),
									h(
										"button",
										{
											key: "jump" + name,
											type: "button",
											className: "dsh-nudge-applylink",
											title: "跳到「" + name + "」",
											onClick: () => jumpTo((NAV_GROUPS.find(([, label]) => label === name) ?? ["", ""])[0]),
										},
										name,
									),
								]),
							)
						: null,
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
				/* 全部恢复默认：九组一颗颗点太慢，但这是批量写回，所以要点两下。 */
				h("div", { className: "dsh-nudge-resetall", key: "resetall" }, [
					h(
						"span",
						{ className: "dsh-nudge-applytext", key: "text" },
						resetAllArmed
							? "再点一下就把全部 " + allDefaults().length + " 项写回出厂值（还没保存，可以「放弃」）"
							: "把九组设置一起写回出厂值",
					),
					h(
						"button",
						{
							key: "resetallbtn",
							type: "button",
							className: "dsh-nudge-btn",
							"data-armed": resetAllArmed ? "1" : "0",
							disabled,
							onClick: () => {
								if (!resetAllArmed) {
									setResetAllArmed(true);
									return;
								}
								setResetAllArmed(false);
								// 只进草稿：真正的写回仍然由「应用」完成，误点也能「放弃」。
								writeMany(allDefaults());
							},
						},
						resetAllArmed ? "确认全部恢复" : "全部恢复默认",
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
