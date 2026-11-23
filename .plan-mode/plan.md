# 计划：修复"完成是自然音、需要你选择是机械音"

## Goal

预制语音下，completed 念自然音、needs_choice 念机械音的根因修复：合成与播报必须用**完全同一句**文案，任何类别都不能漏字段。

## 根因（已实测复现）

```
completed  定时器合成: "任务完成：任务"             实际播报: "任务完成：任务"                     一致 ✓
needs_choice 定时器合成: "需要你选择：任务"          实际播报: "需要你选择：任务：等待你批准一个操作"  ✗
```

`speechTextForBatch()`（lib/index.js:1434）拼文案时**没传 `detail`**，而 show() 的 `soundFor()` 传了 `focus.verdictText`。completed 的 detail 是冗余的（"回合已完成"→verdictText 为空），两句恰好相同 → 缓存命中自然音；needs_choice 有真实原因 → 两句不同 → 缓存永远不命中 → 回退机械音。上一轮的"批次文案一致"断言只测了无 detail 场景，漏掉了。

## Ordered steps

1. **修 `speechTextForBatch()`**：补传 `detail: focus.verdictText`（与 show() 的 `soundFor` 一致），使三类文案完全相同。
2. **加断言覆盖三类 × 有/无 detail**：completed / needs_choice / failed，各测"定时器文案 === 播报文案"，防止再漏字段。
3. **端到端验收**：用 needs_choice + detail 的真实 payload 走 schedule，确认 payload.sound.neuralFile 非空（不再回退 tts）。
4. **文档 + 发版 2.3.3**。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `node -e` speechTextForBatch vs soundFor，三类×有detail | 全部 `一致: true` |
| C2 | 端到端：needs_choice push→schedule→看 payload.sound.source | `preset` 且 `neuralFile` 非空 |
| C3 | `node scripts/selftest.mjs 2>&1 \| tail -1` | `ALL PASS (>=320)` |
| C4 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | `0` |
| C5 | 5 个 probe-*.ps1 | 全 `PROBE OK` |

## Risks

- `focus.verdictText` 在多条时为 `focusOf(single)` 的返回值；单条才有值。`speechTextForBatch` 与 show 都按 single 取 focus，一致。
- completed 的"回合已完成"是冗余 detail，`focusOf` 会把它清成空，补传后仍一致。
