# 计划：试听不依赖语音总开关（修"点不了"）

## Goal

让「试听」在任何时候都能点、点了真的出声，不再因为「卡片弹出时出声」是关的就变灰。

## 根因（已查证）

1. `client.js` 的试听按钮：`disabled: disabled || !bool("sound.enabled")` —— 总开关关着就禁用。
2. 宿主 `help` 侧 `Resolve-Sound` 在 `enabled=false` 时直接返回 `enabled:false`，helper 什么都不播。
3. 你 profile 的 `sound.enabled` 目前是默认 `false`（配置见下），所以按钮一直是灰的。

## 附带发现（不擅自改，需你确认）

`profile/cordis.patch.yml` 现在是 **0 字节**，备份 `.bak-20261119-062904` 也是 0 字节。
`recovery/1794597597437…/cordis.patch.yml` 里还留着你原来的 nudge 配置（`visible.footer:false`、
`typography.project.size:17` 等）——说明个人配置在某次写入中被清空了。恢复属于改动 profile 配置，
本轮**只报告、不动手**，等你确认。

## Ordered steps

1. `client.js`：试听按钮的 `disabled` 只保留页面级 `disabled`（只读时禁用），去掉 `|| !bool("sound.enabled")`；
   `title` 改为「按现在的设置播一次（总开关关着也会出声，只影响试听）」。
2. `lib/index.js`：`playSoundOnly()` 构造 payload 时强制 `sound.enabled = true`，保证 helper 真的播。
3. 补断言：按钮不再依赖 `sound.enabled`；`playSoundOnly` 强制 enabled。
4. 自检 + 真机（总开关关着时试听仍出声）+ 探针 + 文档 + 发版 2.3.6。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `grep -n 'disabled: disabled' client.js` 试听那行 | 不含 `sound.enabled` |
| C2 | `grep -n 'enabled: true' lib/index.js` 在 playSoundOnly 内 | 有 |
| C3 | 端到端：sound.enabled=false 调 playSoundOnly，看 payload | `sound.enabled === true` |
| C4 | 真机 `-SoundOnly` 播一次 | 有 sound 状态行（ok:true） |
| C5 | `node scripts/selftest.mjs 2>&1 \| tail -1` | ALL PASS (>=327) |
| C6 | 4 个 probe-*.ps1 | 全 PROBE OK |

## Risks

- 强制 enabled 只作用于试听 payload，不影响真实提醒的总开关行为（真实卡仍受 `enabled` 控制）。
- 若用户总开关关着、试听却出声，可能让人以为开关失效——所以 `title` 与按钮旁说明写明「只影响试听」。
- 恢复 profile 配置不在本轮范围，避免越权改动用户环境。
