# 计划：补齐依赖声明与设置页需求说明

## Goal

v2.3.0 的预制语音（自然音色念完整内容）依赖 **dsh-voice 插件 + 联网 + Windows**，但 package.json / 设置页都没声明。用户装上选了预制语音会静默回退机械音，还不知道为什么。本轮把"需求"完整补上。

## 事实（已查证）

- `package.json`：无 `peerDependencies` / `optionalDependencies`；`engines` 有 node/dsh，`os: [win32]`。
- `cordis.patch.yml` 的 config 段有 1200ms 的旧 `mergeWindowMs`，与当前默认 150ms 不一致；且没有 `sound` 段。
- dsh-voice 装在 profile 的 `node_modules/dsh-voice`（与 dsh-nudge 同级），运行时靠模块名/路径解析，失败时回退系统 TTS。
- 设置页语音组：「声音来源」hint 仍写"预制语音声音更自然但只能念固定短句"——**已过时**（v2.3.0 是自然音念整句）；选项 label 也是"预制语音（自然·固定短句）"。
- README「安装」段没有前置依赖说明；「语音」小节没装 dsh-voice 的提示。

## Ordered steps

1. **package.json**：加 `peerDependenciesMeta` 标记 dsh-voice 为可选（不强制安装），或 `optionalDependencies`；加一段 `dshNudge.requirements` 描述需求。选最不破坏安装的方案：用 `peerDependencies` + `peerDependenciesMeta.optional=true`。
2. **cordis.patch.yml**：把 `mergeWindowMs` 1200 改成 150，补 `sound` 配置段（enabled/source/phrase/presetVoice 等默认），加注释说明自然音依赖。
3. **设置页**：更新「声音来源」hint 与选项 label 为当前行为；preset 下显示一条需求说明（需装 dsh-voice、联网，否则自动回退系统朗读）；「试听」按钮 title 补一句依赖提示。
4. **README / VERIFY**：安装段加"可选前置：dsh-voice（自然语音）、联网"；语音小节写清回退行为。
5. 自检断言 + 文档 + 发版 2.3.1。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `node -e "console.log(require('./package.json').peerDependencies)"` | 含 dsh-voice |
| C2 | `node -e "console.log(require('./package.json').peerDependenciesMeta['dsh-voice'].optional)"` | true |
| C3 | `grep -n 'mergeWindowMs: 150' cordis.patch.yml` | 有 |
| C4 | `grep -n '需.*dsh-voice\\|联网' client.js` | 设置页有依赖提示 |
| C5 | `node scripts/selftest.mjs 2>&1 \| tail -1` | ALL PASS |
| C6 | `grep -n 'dsh-voice' README.md` | 安装/语音段有说明 |

## Risks

- 加 peerDependencies 可能影响 DSH 市场的安装流程；用 optional=true 规避。若市场不认 peerDependenciesMeta，退回到只在 README/设置页声明。
- cordis.patch.yml 的 config 会覆盖用户配置默认值；只改注释里明显过时的值，不动用户已有配置。
