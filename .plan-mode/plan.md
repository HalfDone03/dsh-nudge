# 计划：补齐两个轻微项（maxChars 显示 + 内存缓存上限）

## Goal

1. **`maxChars` 在预置语音下也能调**：它对 preset 的文案确实生效（实测按 20 截断），但设置页只在 tts 下显示，用户调不了预置语音的字数上限。
2. **内存缓存有时间上限**：`neuralAudioCache`（Map）只在上限 100 条的磁盘索引恢复时收敛，运行时只增不减；长时间高频不同文案会缓慢增长。

## Ordered steps

1. `client.js`：把「最多念几个字」这行的显示条件从「仅 tts」放开到「tts 或 preset」。
2. `lib/index.js`：加 `trimNeuralCache()`——Map 超过 `NEURAL_CACHE_MAX` 时按插入顺序淘汰最旧的**已完成**条目（跳过还在合成的 Promise），顺带删文件并重写索引；在合成成功落盘后调用。
3. 补断言：maxChars 对 preset 可见；`trimNeuralCache` 存在并被调用。
4. 自检 + 探针 + 文档 + 发版 2.3.5。

## Acceptance checks

| ID | 命令 | 期望 |
| --- | --- | --- |
| C1 | `grep -n 'sound.maxChars' client.js` 所在行的 gate | 含 `preset` |
| C2 | `grep -n 'trimNeuralCache' lib/index.js` | 定义 + 至少 1 处调用 |
| C3 | 单测：塞入 > 上限条目后 Map 大小 | ≤ NEURAL_CACHE_MAX |
| C4 | `node scripts/selftest.mjs 2>&1 \| tail -1` | ALL PASS (>=325) |
| C5 | `python -c "print(sum(1 for b in open('lib/popup.ps1','rb').read() if b>=128))"` | 0 |
| C6 | 4 个 probe-*.ps1 | 全 PROBE OK |

## Risks

- 淘汰时删文件：若该文件正被 MediaPlayer 播放，删除会失败——用 `rmSync force` 包 try/catch，失败就跳过，不影响播放。
- 淘汰只在超过上限（100）时触发，日常使用几乎不会走到，风险很低。
- maxChars 放开到 preset 后，用户把值调很小会让自然音只念半句——这是用户自己的选择，hint 里已有「10–200」说明。
