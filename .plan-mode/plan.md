# 计划：让预制语音也支持「念什么」（自定义播报内容）

## 背景 / 为什么现在不行

- 预制语音是 **3 个录死的 mp3**（`lib/voices/<声音>/{completed,needs_choice,failed}.mp3`，每个约 10KB），
  内容是固定的「任务完成了 / 需要你选一下 / 执行失败了」。
- 录音是死的：**没法把任意任务名 / 状态原因塞进一段录音**。
- "念什么"（auto / detail / custom + `{kind}{project}{task}{detail}{count}`）依赖**实时合成**，
  所以被限制在 TTS 来源下。
- 用户问：为什么预制语音不能有"念什么"的功能。

## 三条可行路线

| 路线 | 效果 | 代价 |
| --- | --- | --- |
| **A. 混合播报（推荐）** | 保留预制短句做"自然前缀"，再用 TTS 补念使用者自定义的剩余部分（任务名/原因/模板）。等于"预制音色开头 + 任意内容跟上" | 会听到两种声音拼接；需解决两段串行不重叠（MediaEnded 事件已验证可用） |
| **B. 用神经语音实时合成任意文本** | 预制语音的音色 + 任意"念什么"内容，真正两全 | 需要 edge-tts/在线合成在**弹卡瞬间**实时生成（1-3 秒延迟、需联网、需装 edge-tts），与"提速"目标冲突；或本机预生成海量组合（不现实） |
| **C. 预制语音作为形象，内容仍走 TTS** | 把来源理解改成"提示音 + 播报"，预制短句当提示音，正文用 TTS | 同 A，只是叫法不同 |

**建议 A**：改动小、可靠、满足"预制语音也能按我定的内容念"。

## Goal

让 `sound.source=preset` 时也显示并尊重「念什么」：播完预制短句后，按 `phrase` 档位用 TTS 补念自定义内容；`auto` 档只播短句（等价现状）。

## Ordered steps

1. 设置页：把「念什么」及相关控件从"仅 tts"放开到"tts 或 preset"；preset 下文案说明"先播自然短句，再补念下面的内容"。
2. 宿主：`soundFor()` 在 preset 时依然下发 `text`（现已下发），并新增 `presetFollowText`（补念内容=按 phrase 拼好的文案，但 auto 档为空）。
3. helper：`Play-PresetClip` 播完短句后，若有 `presetFollowText`，用同步 TTS 补念（复用现有 SAPI 代码；`-SoundOnly` 里已是同步路径）。两段串行，不重叠。
4. 自检 + 真机：验证 preset+custom 会先播短句再念自定义内容、auto 只播短句；P0 断言。
5. 文档 + 发版 2.2.0。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `grep -n 'sound.source") === "tts" \|\| text("sound.source") === "preset"' client.js` | 「念什么」在 preset 下也渲染 |
| C2 | `node -e` soundFor(source=preset, phrase=custom) | payload 含 presetFollowText |
| C3 | `-SoundOnly` preset+custom payload | 状态行先 preset ok 再 tts ok |
| C4 | 自检 | ALL PASS |
| C5 | 5 探针 | 全 PROBE OK |

## Risks

- 两段声音拼接音色不同（自然女声 + 系统音），可能是缺点；在设置页说明清楚。
- auto 档必须保持"只播短句"，否则默认变啰嗦。
- 补念内容过长时仍受 maxChars 限制。
