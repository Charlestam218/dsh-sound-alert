# dsh-sound-alert

DSH（DeepSeek Harness）的声音提示插件：**任务完成**和**需要你确认**时各响一声，
两个音效分别做在**高音区**和**低音区**上，一耳朵就能分开。
音效在浏览器端用纯 JS 按 FM 合成公式逐采样渲染，**不依赖任何音频文件、网络请求或宿主路由**。

| 时刻 | 音效 | 听感 |
|---|---|---|
| **任务完成**（这一轮回复结束） | E6 → B6 **上行双音亮铃** | **高亢**：清亮、有余音，像「叮—铃」，收束感明确 |
| **需要确认**（授权 / 提问 / 计划审阅） | A3 → E3 **下行低音木鼓** | **低沉**：干爽、短促、有推进感，「咚—咚」 |

两个音效刻意放在**两个音区**上（约 165 ~ 1976 Hz 的跨度），不靠音色细节区分：
高亢 = 完成，低沉 = 要你拍板。

想先听一下：直接播放 `preview/done.wav` 与 `preview/confirm.wav`
（它们由 `node tools/render-preview.mjs` 用**与插件完全相同的合成代码**渲染出来）。

## 判定依据（不猜 DOM）

| 时刻 | 数据来源 |
|---|---|
| 任务完成 | 会话控制器中「当前会话」的 `running: true → false`（`ctx.sessions.list`） |
| 需要确认 | `ctx.uiSession.sessionStatus` 中该会话出现 `pendingInteraction`，`kind` ∈ `approval` / `question` / `plan-review` |

`pendingInteraction` 由 DSH 自带的**审批面板**与**提问卡片**在收到 Host 请求时发布，是官方权威来源；
`plan-review`（计划审阅）也按「要你拍板」处理。插件不读取也不修改聊天记录，不注册路由，不发起网络请求。

## 安装

插件是标准的 DSH bundle（`dsh.bundle.patch` + `dsh.client`）；安装 = 把包放进 profile 的 `node_modules`
并把包名写进该 profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles`。

### 官方桌面端（`desktop` profile）

桌面端 profile 由 Electron 客户端独占，`dsh plugin --profile desktop …` 会被 CLI 拒绝，因此用附带的脚本：

```powershell
# 默认装 %USERPROFILE%\.dsh\profiles\desktop；-Copy 改为拷贝安装（不用 junction 软链）
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir "D:\some\profile"
```

脚本做两件事：在 `<profile>\node_modules\<包名>` 建一个指向本包目录的 junction，
并把包名写进 `<profile>\package.json`（首次运行会先把该文件备份成 `package.json.dsh-sound-alert.bak`）。

> 脚本以 UTF-8 **带 BOM** 保存 —— 否则 Windows PowerShell 5.1 会把中文当 ANSI 读坏。
> 若系统禁止运行未签名脚本，用上面的 `-ExecutionPolicy Bypass`（只影响该进程）。

### Web（`dsh web` 的 profile）

```powershell
dsh plugin --profile web add link:<本包绝对路径>
```

`link:` 是软链安装，改本包源码立即生效；安装后**不要移动或重命名本目录**（移动后重新 `add` 一次）。
用 `file:` 则是拷贝安装。

### 生效方式

DSH 启用 HMR 时会重读 profile 清单，新 bundle 通常**无需重启**即可热挂载（宿主半区与浏览器半区都会自动生效）；
若没生效，重启 DSH 客户端（`dsh web` 则是重启 + `Ctrl+R`）。

## 自检

浏览器开发者工具控制台：

```js
dshSoundAlert.test()          // 依次响「完成」音、1.1 秒后响「确认」音
dshSoundAlert.test('done')    // 只响完成音
dshSoundAlert.test('confirm') // 只响确认音
dshSoundAlert.state()         // { enabled, volume, audio: 'running', watched, sessions, done, confirm, lastPath, lastError }
dshSoundAlert.diag()          // 最近的状态变化与发声历史（含走了哪条播放通道）
dshSoundAlert.samples('done') // 渲染好的 PCM 采样（Float32Array），便于离线分析
dshSoundAlert.wav('confirm')  // 16bit PCM WAV 字节，便于自行保存试听
```

不打开 DevTools 也能排查 —— 页面里的真实状态会写进 localStorage：

| 键 / 文件 | 含义 |
|---|---|
| localStorage `dsh-sound-alert:boot` | 客户端半区确实在页面里跑起来了（含版本、挂载时间） |
| localStorage `dsh-sound-alert:diag` | 心跳快照：`statusAttached`、当前会话、最近 12 次状态边沿（`focused` / `fired`）、最近 8 次发声（含通道）、`audio` 状态、`lastError` |
| localStorage `dsh-sound-alert:plays` | 各音效播放次数与最后一次的类型/通道 |
| `$DSH_HOME/.dsh-sound-alert.log` | 宿主半区每次加载/卸载一行（默认 `~/.dsh/.dsh-sound-alert.log`） |

安装后想验证“真的会响”，最省事的办法是让 agent 向你提一个问题（审批/提问都会触发确认音），
或者直接 `dshSoundAlert.test()` 试听。

## 开关与音量

```js
dshSoundAlert.off()          // 静音（写入 localStorage，刷新后仍静音）
dshSoundAlert.on()           // 恢复
dshSoundAlert.toggle()
dshSoundAlert.setVolume(0.7) // 0 ~ 1，默认 0.7
```

## 自定义音色

音效配方在 [`lib/client.js`](lib/client.js) 顶部的 `RECIPES`，每个音是一个 FM 声部：

```js
done:    [ { freq: 1318.51, at: 0.00, ratio: 2.76, index: 1.9, indexDecay: 0.28, attack: 0.004, decay: 0.80, level: 0.30 },
           { freq: 1975.53, at: 0.12, ratio: 2.76, index: 1.6, indexDecay: 0.24, attack: 0.004, decay: 0.90, level: 0.26 } ],  // E6 → B6 高亢亮铃
confirm: [ { freq: 220.00,  at: 0.00, ratio: 3.0,  index: 1.6, indexDecay: 0.06, attack: 0.004, decay: 0.30, level: 0.34 },
           { freq: 164.81,  at: 0.18, ratio: 3.0,  index: 1.5, indexDecay: 0.06, attack: 0.004, decay: 0.38, level: 0.32 } ],  // A3 → E3 低沉木鼓
```

- `freq` 音高（Hz），`at` 相对起点的延迟（秒）；
- `ratio` 调制比（2.76 ≈ 钟的 inharmonic 比值，3~4 ≈ 木琴/木鼓）；`index` / `indexDecay` 决定「亮多久」；
- `attack` 起振、`decay` 余音（-60dB）、`level` 相对强度；
- 想让低频更「实」，可把 `confirm` 的 `freq` 调到 196 / 146.83（G3 / D3）；低频在小喇叭上偏弱时，
  适当加大 `level` 比调高音量更有效。

改完保存即触发客户端 bundle 热重载（必要时 `Ctrl+R`）；改动前先跑一遍 `node test/harness.mjs`。

## 播放通道

1. **Web Audio**（`AudioContext` + `AudioBufferSourceNode`）—— 首选；
2. 若上下文被浏览器挂起（自动播放策略），自动退回 **`<audio>` + WAV Blob**；
   两条通道走的是同一份 PCM 渲染结果，听感一致。

插件还会在第一次点击/按键手势里提前创建并唤醒音频上下文，尽量避免提示音被静默吞掉。

## 什么时候会响 / 不会响

- **会响**：你正在看的会话（主视图持有的那一行），以及你看着它跑起来、之后切走的那一轮；
- **不会响**：后台其他会话的完成；子代理会话；待确认被*解决*的那一刻（只在「要你确认」时响一次）；
- 同一类音效 600ms 内只响一次，避免同一时刻被多个订阅重复触发；
- 万一取不到「主视图是哪一行」（不同 DSH 版本差异），会退化成「所有非子会话都算关注」—— 宁可多响也不漏响。

## 开发与测试

```powershell
node test\harness.mjs          # 32 项断言：音频内容 / 播放通道 / 判定逻辑 / 诊断痕迹
node tools\render-preview.mjs  # 重新渲染 preview\*.wav（试听文件）
node --check lib\client.js     # 语法检查（npm run check 两个入口都查）
```

harness 用假 `ctx` / 假 `AudioContext` 驱动状态机，并直接检查渲染出的 PCM：不是静音、不削顶、
完成音比确认音明显更明亮（过零率 >2×）；也覆盖「AudioContext 挂起时自动退回 `<audio>`」这条路径。

## 目录结构

```
dsh-sound-alert/
├── package.json          # 名称/入口/元数据；dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml      # 把插件插入 profile 配置树（挂载声明）
├── lib/
│   ├── index.js          # 宿主半区：Loader 条目 + 加载痕迹（不注册路由、不碰业务状态）
│   └── client.js         # 浏览器半区：判定状态机 + PCM 合成 + 双通道播放（核心）
├── preview/              # done.wav / confirm.wav（试听用，由 tools 生成）
├── tools/render-preview.mjs
├── test/harness.mjs
├── install.ps1 / uninstall.ps1
├── CHANGELOG.md / LICENSE
└── README.md
```

## 卸载

```powershell
# 桌面端 profile（保留其它插件与设置）
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -ProfileDir "D:\some\profile"

# Web profile
dsh plugin --profile web remove dsh-sound-alert
```

浏览器里残留的开关/音量/诊断键在 localStorage 的 `dsh-sound-alert:*`，删除即可。

## 已知限制

- **多个 DSH 窗口会各响一次**：每个页面各自判定、各自播放。
- **页面没打开时不会响**：这是界面提示，不是系统级通知；如需离开窗口也提醒，请用系统通知类工具。
- **依赖 DSH 客户端的服务名**：`sessions`（会话列表）与 `uiSession.sessionStatus`（待确认交互）。
  将来 DSH 若改名：完成音会失效、确认音会静默 —— 改 `lib/client.js` 的 `readStates()` 即可，
  `dshSoundAlert.diag()` 会直接指出 `statusAttached: false`。
- **诊断心跳是 5 秒一次**：想立刻看最新状态就在控制台执行 `dshSoundAlert.diag()`。
- 只在 Windows 上做过安装脚本验证；`lib/` 与浏览器半区本身与平台无关。

## 许可

[MIT](LICENSE)
