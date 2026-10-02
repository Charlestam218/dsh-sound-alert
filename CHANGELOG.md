# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)；版本号与 `package.json` 一致，
发布 Release 时打 `v<version>` 标签。

## 1.2.0

- **音效改为按音区区分**：任务完成 = 高亢（E6 → B6 上行亮铃），需要确认 = 低沉（A3 → E3 下行低音木鼓），
  两音跨度约 3.5 个八度，不依赖音色细节即可分辨。
- 音频改为**纯 JS 逐采样渲染 PCM**（FM 合成），两条播放通道共用同一份采样：
  Web Audio 优先，被自动播放策略挂起时自动退回 `<audio>` + WAV Blob。
- 新增 `preview/*.wav` 与 `tools/render-preview.mjs`：不打开 DSH 也能试听/对比音色。
- 新增 `dshSoundAlert.samples()/wav()`，测试可直接断言渲染结果。

## 1.1.1

- 修复：`sessionStatus` 里的 `running` 可能落后一拍，导致「完成音」被漏掉 —— 改为以会话控制器
  `sessions.list` 为准，仅在列表缺少该会话时退回 `sessionStatus`。
- 新增诊断心跳与状态边沿记录（`dsh-sound-alert:diag`），可离线看到 `statusAttached`、关注判定与发声通道。
- 放大默认音量（0.55 → 0.7）；手势里提前创建音频上下文，降低被静默吞掉的概率。

## 1.0.0

- 首个版本：客户端插件（`dsh.client`），订阅 `sessions` 与 `uiSession.sessionStatus` 判定两个时刻，
  任务完成用 C6 → G6 上行铃声、需要确认用 A5 → E5 下行木琴；含 32 项离线测试、安装/卸载脚本与中文文档。
