# 计划：全功能检查——修 2 个真实问题

## Goal

逐块审完所有功能（基线 2.3.3，自检 321 全绿、4 探针 OK），找到并修掉仍存在的 2 个真实问题。

## 已查证的发现

**问题 1（真实 bug，复现成功）——多条同项目 + 自定义模板时文案不一致 → 回退机械音**

```
定时器合成: "2 条提醒，执行失败 2"
实际播报 : "2 条提醒，执行失败 dsh-nudge 2"
一致? false
```

`show()` 多条时把「唯一项目」放进 `focus.context`，而 `speechTextForBatch()` 用 `context:""`。
自定义模板含 `{project}` 时两句不同 → 缓存不命中 → 静默回退机械音。
与之前「完成是自然音、待选是机械音」同类（那次是漏 `detail`，这次是漏 `context`）。

**问题 2（真实隐患）——合成超时拖住弹卡最多 12 秒**

`ensureNeuralAudio` 用 `synthesizeSpeech(..., 12000)`，而 `schedule()` **await 它**。
网络卡住/挂起时弹卡会被拖最多 12 秒——提醒插件不该为了等语音而迟到。

**已查证、确认不是问题的（避免误修）**
- 语速 `sound.rate` 只对 tts 显示——正确，preset 用 Edge 合成时本就用固定 `rate:"+0%"`。
- `maxChars` 对 preset 静默生效（测试：长度 20 截断正确），仅 UI 上没显示，属轻微 UX 缺口，本轮不改。
- `-SoundOnly` 里 `$script:Sound` 在 preset 分支前已 `Resolve-Sound`（1576 行），顺序正确。
- 静音时段的条目在 `push()` 就被拦，不会进合成路径。

## Ordered steps

1. 修 `speechTextForBatch()`：与 `show()` 一样计算 `projects`，多条时 `context` 取唯一项目。
2. 加 `ensureNeuralAudioWithin(config, text, ms)`：用 `Promise.race` 设等待上限（弹卡 2500ms、试听 6000ms）；超时先返回空串让本轮回落系统朗读，后台合成继续跑，同句下次命中缓存。
3. `schedule()` 与 `playSoundOnly()` 改用带上限的合成。
4. 补断言：多条同项目 + 自定义模板文案一致；等待上限存在。
5. 自检 + 端到端（多条同项目时 payload 带 neuralFile）+ 4 探针 + 文档 + 发版 2.3.4。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `node -e` 多条同项目 + 自定义模板，比较两路文案 | 一致 true |
| C2 | 端到端：多条同项目 → payload.sound.neuralFile | 非空（不再回退机械音） |
| C3 | `grep NEURAL_SYNTH_WAIT_MS lib/index.js` | 存在且被调用 |
| C4 | `node scripts/selftest.mjs 2>&1 \| tail -1` | ALL PASS (>=323) |
| C5 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | 0 |
| C6 | 4 个 probe-*.ps1 | 全 PROBE OK |

## Risks

- `Promise.race` 超时后 `ensureNeuralAudio` 的 promise 仍挂起：`neuralAudioCache` 里存的是 Promise，下次同句会复用同一 job，不会重复合成。
- 多条时 `context` 改动会影响 `{project}` 的念法，但与卡片显示一致，属正确行为。
- 等待上限过短会让首次提醒更常是机械音；2500ms 覆盖实测的首次合成 1400ms，平衡了「及时」与「自然音」。
