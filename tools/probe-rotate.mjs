import { writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULTS, PopupRunner } from "../lib/index.js";

// 走真实的 PopupRunner：debugPayload 是在 spawnOnce 里调用的，绕开它就测不到轮转。
const file = join(tmpdir(), "nudge-rotate-probe.jsonl");
const backup = file + ".1";
for (const path of [file, backup]) rmSync(path, { force: true });

// 先造一个「已经超过 5MB」的文件，模拟开了调试忘了关。
writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 10), "utf8");
console.log("before:", statSync(file).size);

const runner = new PopupRunner(
	{ ...DEFAULTS, staySeconds: 1, debugPayload: true, debugFile: file, rememberPosition: false },
	() => {},
);
runner.show([
	{ kind: "completed", sessionId: "rotate", title: "rotate probe", project: "dsh-nudge", detail: "check rotation", at: "12:00", count: 1 },
]);

await new Promise((resolve) => setTimeout(resolve, 1500));

const rotated = existsSync(backup);
const size = existsSync(file) ? statSync(file).size : -1;
let firstLine = "";
let parsedKind = "";
if (existsSync(file)) {
	const text = readFileSync(file, "utf8").trim();
	firstLine = text.split("\n")[0] ?? "";
	try {
		parsedKind = JSON.parse(firstLine)?.payload?.kind ?? "";
	} catch {
		parsedKind = "unparsable";
	}
}
console.log("rotated:", rotated, "new size:", size, "line kind:", parsedKind || "(none)");

runner.dispose();
for (const path of [file, backup]) rmSync(path, { force: true });

const ok = rotated && parsedKind === "completed" && size > 0 && size < 1024 * 1024;
console.log(ok ? "PROBE OK: 超限后旧文件挪成 .1，新文件只写这一条" : "PROBE FAILED");
process.exit(ok ? 0 : 1);
