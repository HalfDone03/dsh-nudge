/**
 * 假会话 demo：不启动 DSH、不改 profile，直接驱动插件逻辑，屏幕上依次弹出三种状态的卡片。
 *
 * 用法：
 *   & "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts\demo.mjs
 *   ... demo.mjs failed      只跑「执行失败」这一张
 *
 * 这是给人看的示例，跑完终端会打印每张卡的位置和判定结果。
 */

import { createPlugin } from "../lib/index.js";

/** 三种状态的示例数据。 */
const SCENARIOS = {
	completed: {
		title: "任务完成",
		events: [["turn/end", { reason: { kind: "completed" } }]],
		note: "回合正常结束"
	},
	needs_choice: {
		title: "需要你选择",
		events: [
			["approval/request", null],
			["turn/end", { reason: { kind: "completed" } }]
		],
		note: "等你批准 + 顺带一条完成"
	},
	failed: {
		title: "执行失败",
		events: [["turn/end", { reason: { kind: "error", error: { code: "BUILD_FAILED", message: "vite build 退出码 1" } } }]],
		note: "回合异常结束"
	}
};

const only = process.argv[2];
const picked = only === undefined ? Object.keys(SCENARIOS) : [only];
if (picked.some((key) => SCENARIOS[key] === undefined)) {
	console.error(`unknown scenario: ${only} (use completed | needs_choice | failed)`);
	process.exit(2);
}

const statuses = [];
const handlers = new Map();
const askResult = { answers: [{ id: "q1", value: "选项 A" }] };
const fakeQuestions = { ask: async () => askResult };

const ctx = {
	on(type, handler) {
		handlers.set(type, [...(handlers.get(type) ?? []), handler]);
	},
	get(name) {
		if (name === "approval") return { id: "demo-approval" };
		if (name === "userQuestions") return fakeQuestions;
		return undefined;
	},
	effect(setup) {
		setup();
	},
	logger: { info: () => {}, debug: () => {}, warn: (message) => console.log(`[warn] ${message}`) }
};

const { dispose } = createPlugin(ctx, { staySeconds: 6, mergeWindowMs: 400 }, {
	onStatus: (status) => {
		statuses.push(status);
		if (status.type === "shown") {
			console.log(`  卡片已显示：${status.width}x${status.height} @ (${status.left},${status.top})，共 ${status.count} 条`);
		}
		if (status.type === "error") console.log(`  卡片报错：${status.message}`);
	}
});

/**
 * 发一条 session/event。
 * @param {string} type 事件类型
 * @param {object} data 事件体
 * @param {string} sessionId 会话 id
 */
function emit(type, data, sessionId) {
	const session = { header: { id: sessionId, title: "修复弹窗圆角", cwd: process.cwd() } };
	for (const handler of handlers.get("session/event") ?? []) handler(session, { type, data });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let index = 0;
for (const key of picked) {
	const scenario = SCENARIOS[key];
	index++;
	const sessionId = `demo-session-${index}`;
	console.log(`\n--- 场景 ${index}/${picked.length}：${scenario.title}（${scenario.note}）---`);
	for (const [type, data] of scenario.events) {
		if (type === "approval/request") {
			for (const handler of handlers.get("approval/request") ?? []) {
				handler({ agent: { id: sessionId, session: { header: { id: sessionId, title: "部署到生产环境", cwd: process.cwd() } } }, command: "npm install --production" },
					() => undefined);
			}
			continue;
		}
		emit(type, data, sessionId);
	}
	await sleep(8000);
}

dispose();

const shown = statuses.filter((status) => status.type === "shown");
const errors = statuses.filter((status) => status.type === "error");
console.log(`\n共弹出 ${shown.length} 张卡片，报错 ${errors.length} 次。`);
const ok = shown.length === picked.length && errors.length === 0;
console.log(ok ? "DEMO OK" : "DEMO FAILED");
process.exit(ok ? 0 : 1);
