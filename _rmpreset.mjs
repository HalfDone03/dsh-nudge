import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const errors = [];
const fail = (message) => errors.push(message);

const load = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const save = (file, text, lf) => writeFileSync(file, lf ? text : text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));

/* ---------------- client.js ---------------- */

let src = load("client.js");
let lines = src.split("\n");

/* 1. 两条 .dsh-nudge-presets* CSS */
const cssHits = lines.filter((line) => line.includes(".dsh-nudge-presets"));
if (cssHits.length !== 2) fail("CSS: expect 2 preset rules, got " + cssHits.length);
lines = lines.filter((line) => !line.includes(".dsh-nudge-presets"));

/* 2. 预设横条的 JSX（h("div", { className: "dsh-nudge-presets" ... }, [ ... ]),） */
const jsxStart = lines.findIndex((line) => line.includes('className: "dsh-nudge-presets"'));
if (jsxStart < 0) fail("JSX: preset strip not found");
let jsxEnd = -1;
if (jsxStart >= 0) {
	for (let i = jsxStart + 1; i < lines.length; i += 1) {
		if (lines[i].trim() === "])," && lines[i + 1]?.trim() === "h(" && lines[i + 2]?.trim() === '"nav",') {
			jsxEnd = i;
			break;
		}
	}
	if (jsxEnd < 0) fail("JSX: closing line not found");
}
if (jsxStart >= 0 && jsxEnd > jsxStart) lines.splice(jsxStart, jsxEnd - jsxStart + 1);

/* 3. PRESETS 常量（含注释行与结尾 ];） */
const constComment = lines.findIndex((line) => line.includes("三个一键预设：一次写一组字段"));
const constOpen = lines.findIndex((line) => line.includes("const PRESETS = ["));
let constEnd = -1;
if (constOpen >= 0) {
	for (let i = constOpen + 1; i < lines.length; i += 1) {
		if (lines[i].trim() === "];") {
			constEnd = i;
			break;
		}
	}
}
if (constComment < 0 || constOpen < 0 || constEnd < 0) fail("PRESETS: block not found " + [constComment, constOpen, constEnd].join("/"));
if (constComment >= 0 && constEnd > constOpen) {
	// 连同后面的空行一起去掉，避免留下两个连续空行
	let tail = constEnd;
	if (lines[tail + 1] !== undefined && lines[tail + 1].trim() === "") tail += 1;
	lines.splice(constComment, tail - constComment + 1);
}

/* 4. presetOn */
const presetOnAt = lines.findIndex((line) => line.includes("const presetOn = "));
if (presetOnAt < 0) fail("presetOn: line not found");
if (presetOnAt >= 0) lines.splice(presetOnAt, 1);

/* 5. 修订号 */
const revAt = lines.findIndex((line) => line.includes('const PANEL_REVISION = "2026-11-01.9";'));
if (revAt < 0) fail("PANEL_REVISION: 2026-11-01.9 not found");
if (revAt >= 0) lines[revAt] = lines[revAt].replace("2026-11-01.9", "2026-11-01.10");

const nextClient = lines.join("\n");
if (nextClient.includes("dsh-nudge-presets") || nextClient.includes("PRESETS") || nextClient.includes("presetOn")) {
	fail("client.js: preset traces remain");
}

/* ---------------- scripts/selftest.mjs ---------------- */

let test = load("scripts/selftest.mjs");
let tlines = test.split("\n");

const strip = (needle, what) => {
	const at = tlines.findIndex((line) => line.includes(needle));
	if (at < 0) {
		fail("selftest: " + what + " not found");
		return -1;
	}
	return at;
};

/* 注释里的「预设按钮」 */
const headAt = strip("样卡里可点的行、角色按钮、预设按钮。", "helper comment");
if (headAt >= 0) tlines[headAt] = tlines[headAt].replace("角色按钮、预设按钮。", "角色按钮。");

/* presetButtons 定义 */
const defAt = strip("const presetButtons =", "presetButtons");
if (defAt >= 0) tlines.splice(defAt, 1);

/* 「三个一键预设都在」那条 check */
const checkAt = strip('check("三个一键预设都在"', "preset count check");
if (checkAt >= 0) tlines.splice(checkAt, 1);

/* 预设交互两条 check（先落草稿 / 一次写一组） */
const clickAt = tlines.findIndex((line) => line.includes("presetButtons(clientNodes)[0].props.onClick();"));
const blockOpen = clickAt - 1;
let blockClose = -1;
const listAt = tlines.findIndex((line) => line.includes("预设一次写一组字段"));
if (clickAt < 0 || listAt < 0) fail("selftest: preset interaction block not found");
if (listAt >= 0) {
	for (let i = listAt; i < tlines.length; i += 1) {
		if (tlines[i].trim() === ");") {
			blockClose = i;
			break;
		}
	}
}
if (blockOpen < 0 || blockClose < 0) fail("selftest: preset block bounds not found");
if (blockOpen >= 0 && blockClose > blockOpen) {
	let tail = blockClose;
	if (tlines[tail + 1] !== undefined && tlines[tail + 1].trim() === "") tail += 1;
	tlines.splice(blockOpen, tail - blockOpen + 1);
}

const nextTest = tlines.join("\n");
if (nextTest.includes("presetButtons") || nextTest.includes("一键预设") || nextTest.includes("预设一次写一组")) {
	fail("selftest: preset traces remain");
}

/* ---------------- 文档 ---------------- */

let readme = load("README.md");
const readmeBefore = readme;
readme = readme.replace(
	"三类提醒；顶上那一排是安静 / 标准 / 话多三个一键预设，一次写 9 个字段，之后还能逐项微调 |",
	"三类提醒 |",
);
if (readme === readmeBefore) fail("README: 提醒 row preset clause not replaced");

let verify = load("VERIFY.md");
const verifyBefore = verify;
verify = verify.replace("「提醒」组把总开关、三类提醒和三个一键预设合成一组。", "「提醒」组把总开关和三类提醒合成一组。");
if (verify === verifyBefore) fail("VERIFY: preset sentence not replaced");

let changelog = load("CHANGELOG.md");
const patchDoc = (from, to, what) => {
	const hits = changelog.split(from).length - 1;
	if (hits !== 1) {
		fail("CHANGELOG: " + what + " hits=" + hits);
		return;
	}
	changelog = changelog.replace(from, to);
};

patchDoc(
	"- 设置页：顶部一张**样卡**，按当前配色和字号把八类文字画出来，点哪一行下面就调哪一行；字号与颜色从 16 个输入框\n  收成「颜色（某行）」「字号（某行）」两行，**不再需要先打开预览开关**才能调。另加三个一键预设\n  （安静 / 标准 / 话多），一次写 9 个字段，之后仍可逐项微调。",
	"- 设置页：顶部一张**样卡**，按当前配色和字号把八类文字画出来；点样卡上的一行、或者下面那排名字按钮就切到\n  那一类，底下只画这一类的一个字号框和一个颜色框（16 个输入框压成两个），**不必先打开预览**才能调。",
	"观感 entry",
);
patchDoc("一个键都没变就不发请求。预设、恢复默认、", "一个键都没变就不发请求。恢复默认、", "draft entry");
patchDoc("和九个分组按钮，点一下滚到那一组", "和五个分组按钮，点一下滚到那一组", "nav count");
patchDoc("修订\n  2026-11-01.7", "修订\n  2026-11-01.10", "revision");
patchDoc(
	"- 字号组改成常显：八类文字各自的字号框一直列在「字号与颜色」里（原来要塞进折叠开关后面点一下才出现，\n  而那个开关自己就藏在八个角色按钮下面）；切类靠点样卡上的一行，或者样卡下面新加的那排名字按钮\n  —— 每格写着类名和这一类现在的字号，不用再靠猜。",
	"- 名字按钮：样卡下面一排八个按钮，每格写着类名和这一类现在的字号，点一下就切到那一类，不用再靠猜。",
	"role buttons entry",
);
patchDoc("- 自测 225 项（`--no-live` 202；设 `DSH_NUDGE_SCHEMASTERY` 时 232）", "- 自测 223 项（`--no-live` 200；设 `DSH_NUDGE_SCHEMASTERY` 时 229）", "test counts");
patchDoc(
	"  源码约束 4 条、设置页 17 条（样卡 8 行都可点、只渲染选中的那一类、8 个角色按钮、3 个预设、预设先落草稿再一次写 6 条 op、\n",
	"  源码约束 4 条、设置页 14 条（样卡 8 行都可点、只渲染选中的那一类、8 个角色按钮、\n",
	"test list",
);
patchDoc("逐行设字号列出八类、放弃丢掉草稿", "放弃丢掉草稿", "test list 2");
patchDoc("调试组默认收着、7 个恢复默认按钮", "调试组默认收着、5 个恢复默认按钮", "reset count");
patchDoc("总开关、三类提醒与三个一键预设合成「提醒」", "总开关与三类提醒合成「提醒」", "groups entry");
patchDoc(
	"- 字号与颜色去重：删掉与八行表重复的「字号（某类）」单行，同一项只在一处改；一键预设会把当前命中的\n  那一档标出来。",
	"- 字号与颜色去重：删掉与八行表重复的「字号（某类）」单行，同一项只在一处改。",
	"dedupe entry",
);
patchDoc(
	"- 组内密度收紧：行距 9px → 6px、组间距 18 → 12、提示字 11px，样卡下面那行长说明压成一句。",
	"- 组内密度收紧：行距 9px → 6px、组间距 18 → 12、提示字 11px，样卡下面那行长说明压成一句。\n"
		+ "- 删掉页首那条「一键预设 安静 / 标准 / 话多」横条：它不属于任何一张卡片，浮在导航上方白占一行；`PRESETS`、\n"
		+ "  `presetOn` 与两条 CSS 一并删掉，`writeMany` 留着（恢复默认与导入还在用）。",
	"density entry",
);

/* ---------------- 写盘 ---------------- */

if (errors.length > 0) {
	console.log("FAIL");
	for (const message of errors) console.log(" - " + message);
	process.exit(1);
}

save("client.js", nextClient, false);
save("scripts/selftest.mjs", nextTest, false);
save("README.md", readme, true);
save("VERIFY.md", verify, false);
save("CHANGELOG.md", changelog, false);

execFileSync(process.execPath, ["--check", "client.js"], { stdio: "inherit" });
execFileSync(process.execPath, ["--check", "scripts/selftest.mjs"], { stdio: "inherit" });

console.log(
	"ok: client=" + nextClient.split("\n").length
	+ " selftest=" + nextTest.split("\n").length
	+ " readme=" + readme.split("\n").length,
);
