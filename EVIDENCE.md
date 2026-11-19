# EVIDENCE — 使用逻辑优化（1.9.2）

每条都标了怎么确认：✅可命令 / 👁只能看图 / 🤷不知道（须先探）。

## FACT（代码里已确认的现状）

| # | 事实 | 确认方式 | 标签 |
| --- | --- | --- | --- |
| F1 | `failure` 渲染在页面顶部（`client.js:1256`），十组内容之前 | `grep -n 'key: "failure"'` | ✅ |
| F2 | 触发报错的交互（应用 / 试听 / 导入）都在页面底部 | `grep -n 'key: "applybar"'` = 1960 | ✅ |
| F3 | `applybar` 内没有错误位 | `sed -n '1960,1990p' \| grep -c failure` → 0 | ✅ |
| F4 | `exportText` 读 `value[key]`（已应用），界面读 `raw()`（草稿优先） | `sed -n '1014,1022p'` | ✅ |
| F5 | `raw = draft[c] ?? value[c]`（`client.js:934`） | grep | ✅ |
| F6 | `clickThrough` 为真时宿主优先按穿透处理，`clickToFocus` 被忽略 | `popup.ps1:1779` + `Start-CardSound` 上方逻辑 | ✅ |
| F7 | 两个点击开关在 UI 上各自独立、无联动 | `sed -n '/key: "clickToFocus"/,/key: "clickThrough" }/p'` | ✅ |
| F8 | `DEFAULTS` 有 27 个顶层键；`GROUP_DEFAULTS` 覆盖不到 `popupScript`、`placementFile` | 脚本对拍（已跑：输出 `placementFile, popupScript`） | ✅ |
| F9 | `NumberRow` 只有 `onBlur: commit`，无 `onKeyDown` | `sed -n '286,330p'` | ✅ |
| F10 | `TextRow` 只有 `onBlur`，无 `onKeyDown` | `sed -n '358,380p'` | ✅ |
| F11 | 试听按钮 title 写「先把『卡片弹出时出声』打开」，但 onClick 已会连草稿一起写入 | `client.js:1740` 附近 | ✅ |
| F12 | `NumberRow` 已有「空输入不提交」保护（`Number("")===0` 陷阱） | `sed -n '286,300p'` | ✅ |
| F13 | `pending` 只统计 `dirty()` 为真的草稿项（改回原值不算） | `client.js:751` | ✅ |
| F14 | 自检当前 300 项全绿 | `node scripts/selftest.mjs` | ✅ |
| F15 | 源码注释里还有两处「九组」（777、1970、2015、2022） | `grep -n '九组' client.js` | ✅ |

## CONVENTION（本项目既有做法，沿用）

| # | 约定 | 标签 |
| --- | --- | --- |
| C1 | 配置改动一律先进草稿，点「应用」才写回；只有 `debugPreview` / `previewNonce` 这类开关走 `writeNow` | ✅ |
| C2 | 报错文案用中文、说清「发生了什么 + 怎么办」，不用错误码 | ✅ |
| C3 | `popup.ps1` 必须纯 ASCII；中文只从 UTF-8 payload 来 | ✅ |
| C4 | 每组都有「恢复默认」，预览组没有（它没有配置项） | ✅ |
| C5 | 新增行为必须配自检断言，否则下轮回归没人拦 | ✅ |

## AMBIGUITY（需要定夺，已在计划里做了取舍）

| # | 问题 | 取舍 | 标签 |
| --- | --- | --- | --- |
| A1 | 「全部恢复默认」是否该动 `popupScript`？ | 该动——它叫"全部" | ✅ |
| A2 | 导出该导草稿还是已应用？ | 导**界面上看到的**（草稿优先），并标注未保存项数 | ✅ |
| A3 | 两个点击开关要不要做成单选？ | 保留两个开关 + 联动，比换成单选更少改动、更好撤回 | ✅ |
| A4 | 失败提示是否两处都留？ | 都留：顶部是记录，应用栏是就近反馈，共用同一 state | ✅ |

## EDGE（失败模式）

| # | 场景 | 期望 | 标签 |
| --- | --- | --- | --- |
| E1 | 导出时草稿为空 | 与现状一致，不标注 | ✅ |
| E2 | 联动写入后被「放弃」 | 两个开关都回到原值 | ✅ |
| E3 | 数字框输入非法（`abc`）后回车 | 恢复原值，不提交 | ✅ |
| E4 | 数字框清空后回车 | 恢复原值（既有保护），不写成 0 | ✅ |
| E5 | Esc 放弃输入 | 恢复成 `props.value`，草稿不变 | ✅ |
| E6 | 只读 profile | 全部控件 disabled，联动也不触发 | ✅ |

## 只能看图的部分 → 见 P1-TARGETS.yml

失败提示是否真在视野内、开关联动是否有视觉反馈、回车后的草稿计数，这些要截图看。
