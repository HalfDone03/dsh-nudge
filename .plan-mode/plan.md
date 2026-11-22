# 计划：单一自然音色念完整内容（去掉两段拼接）

## Goal

撤掉 v2.2.0 的「预制短句 + TTS 补念」两段拼接，改为**一个自然音色念完整播报内容**（类别+任务名+原因/模板）。

## 已查证的关键事实

- 本机 Windows 语音全是老引擎（SAPI5/OneCore 都是 `MSTTS_V110_*` Huihui/Yaoyao/Kangkang），**没有自然音色**，无法靠系统语音实现单一自然音色。
- 本机装有 **dsh-voice 插件 0.10.8**，导出 `synthesizeSpeech({text, voice, rate, pitch})`，零密钥 Edge 神经语音，返回 MP3 Buffer——**单一自然音色念任意文本**可行。
- 代价：①需联网；②依赖 dsh-voice 插件存在；③合成耗时需实测（探针 `tools/_probe-edge.mjs` 已写，尚未跑）。
- 与"提速"目标可能冲突：Edge 合成通常 1–3 秒。

## 两条路线（取决于探针结果）

| 路线 | 条件 | 做法 |
| --- | --- | --- |
| **A. 实时 Edge TTS**（单一自然音色，任意内容） | 合成 < ~1.5s 且用户装了 dsh-voice | 宿主在拼好 `speechTextOf()` 后调用 dsh-voice 合成 MP3，写临时文件，helper 只播这一个文件（不再播预制短句、不再补念） |
| **B. 回退到系统 TTS 单一音色** | 合成太慢/无网络/无 dsh-voice | 撤掉两段拼接，preset 只播短句、不补念；想念完整内容就用系统 TTS（单一音色，但机械）——保持 v2.1.0 行为 |

**默认建议**：若 A 可用则 A；同时保留 B 作为自动回退（合成失败/超时/无 dsh-voice 时回退系统 TTS，绝不出两声）。

## Ordered steps

1. 跑 `tools/_probe-edge.mjs` 量合成耗时与可用性，据此定 A 或 B。
2. 若 A：宿主 `soundFor` 改为调用 dsh-voice 合成、缓存 MP3 到临时目录，payload 下发单一音频路径；helper 只播这一条（复用 file 播放路径）；撤掉 `Speak-FollowText` 与 preset 短句+补念逻辑。
3. 若 B：撤掉 `Speak-FollowText` 与 preset 补念，回到"preset 只播短句 / tts 单一音色念完整"；设置页说明清楚。
4. 自检断言 + 真机试听（确认只有**一段**声音、内容完整）。
5. 文档 + 发版（A: 2.3.0；B: 2.2.1）。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `node tools/_probe-edge.mjs` | 记录合成耗时与 bytes |
| C2 | 检查试听状态行 | **只有一条** sound 状态行（不再 preset+follow 两条） |
| C3 | 若 A：payload 含单一音频路径、内容完整 | 状态行 ok:true，播的是完整文案 |
| C4 | `node scripts/selftest.mjs 2>&1 \| tail -1` | ALL PASS |
| C5 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | 0 |
| C6 | 5 个探针（隔离） | 全 PROBE OK |

## Risks

- Edge TTS 需联网：断网时必须静默回退系统 TTS，不能卡住弹窗。
- 合成延迟：若 >2s，提醒就不及时；探针数据决定是否采用 A。
- 依赖 dsh-voice：`import()` 失败/未安装时回退 B。
- 缓存：同一文案重复提醒应复用已合成 MP3（按文本 hash 命名临时文件），避免每次都联网。
- 撤掉两段拼接后，`{detail}` 等占位符仍需正常工作。
