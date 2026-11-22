# 计划：提速（非常驻）+ 播报读到具体进度 + 设置页一致性优化

## Goal

1. **响应提速（不做常驻）**：把合并窗口默认 400ms 降到 150ms，实测 push→spawn ~16–160ms，肉眼近乎即时；保留可配置，用户仍可调大做合并。
2. **播报读到具体哪里**：让语音能念出卡片上的「状态/原因/进度」（`verdictText`，如"vite 退出码 1、第 3 步失败"），并按使用者想法自定义：新增模板占位符 `{detail}`，`detail` 模式 = 类别 + 任务名 + 状态原因。
3. **设置页排版/一致性优化**：修来源下拉默认回退 `preset` 与宿主默认 `tts` 不一致；更新推荐文案；语音组摘要显示播报档位；模板提示补 `{detail}`；把「念什么」选项改成使用者能懂的说法。

## Evidence（关键事实，已实测/已读）

- merge 窗口实测：400→412ms、200→204ms、100→110ms、0→16ms（push→spawn）。
- `speechTextOf()` 目前只拿 kind/label/headline(context)/count，**没有拿到 `verdictText`**（失败原因/进度）。
- 卡片上 `verdictText` 在 `lib/popup.ps1:1037` 显示，payload 里有（`focus.verdictText`），只是没传给语音。
- 自定义模板当前占位符：`{kind} {project} {task} {count}`，缺 `{detail}`。
- 设置页来源下拉默认回退 `"preset"`，宿主默认 `source:"tts"`（不一致）；选项写「预制语音（自然，推荐）」。
- 不做常驻（用户明确）；常驻原型虽 561ms 但计时器失效，已放弃。

## Ordered steps

1. **提速**：`DEFAULTS.mergeWindowMs` 400→150；客户端 GROUP_DEFAULTS 同步；同步 README/CHANGELOG。
2. **语音带进度**：`soundFor()` 增加 `detail` 参数并传 `focus.verdictText`；`speechTextOf()` 新增 `detail` 模式（类别+任务名+原因）与 `{detail}` 模板占位符；helper 无需改（文本由宿主下发）；默认 phrase 从 `detail` 语义扩为「类别+任务名+原因」，保留 `auto`（只类别）与 `custom`。
3. **设置页**：修来源下拉默认回退为 `tts`；选项文案改「系统朗读（默认·念任务名与原因）/ 预制语音（自然·固定短句）/ 本地音频」；「念什么」三档改为「完整：类别+任务+原因 / 简版：只报类别 / 自定义模板」；模板提示与摘要补 `{detail}`。
4. **自检**：更新默认值断言，新增「语音含原因」「{detail} 模板」「来源默认 tts」断言。
5. **真机验收 + 文档 + 发版 2.1.0**。

## Acceptance checks（命令 + 期望）

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `node -e "import('./lib/index.js').then(m=>console.log(m.DEFAULTS.mergeWindowMs))"` | `150` |
| C2 | 临时脚本量 push→spawn | `< 300ms` |
| C3 | `node -e` 调 `speechTextOf` 带 detail | 文案含失败原因 |
| C4 | `node -e` 自定义模板 `{detail}` | 正确替换成原因文本 |
| C5 | `grep -n 'value: .*preset' client.js` 语音来源默认 | 不是回退到 preset，默认 tts |
| C6 | `node scripts/selftest.mjs 2>&1 \| tail -1` | `ALL PASS (>=311)` |
| C7 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | `0` |
| C8 | `-SoundOnly` 带 detail 的 payload | status `{"mode":"tts","ok":true}` |
| C9 | 探针 5 个 | 全 `PROBE OK` |

## Risks

- 语音带原因后可能过长：`maxChars` 默认 60 会截断，需确认关键原因不被截掉（原因放前面或允许更长）。
- 400→150 让同回合多条更易拆卡：保留可配置，且 `push()` 仍按 session 合并，影响可控。
- 设置页默认回退改动会影响已有配置显示：已有配置有明确值，不受影响；只有缺失字段时回退到 tts（正确）。
- `{detail}` 为空时不该留孤立标点：拼装时空值要跳过。
