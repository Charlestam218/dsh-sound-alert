/**
 * dsh-sound-alert —— 任务栏徽标手动演示 / 自检
 *
 * 不依赖 DSH：直接写一份徽标状态、拉起助手进程，在 DSH 任务栏按钮上画出红点数字，
 * 到时间后自动清零。用来确认「这台机器上任务栏徽标通道是通的」。
 *
 * 用法：
 *   node tools/badge-demo.mjs            # 显示 3，20 秒后自动清除
 *   node tools/badge-demo.mjs 5          # 显示 5
 *   node tools/badge-demo.mjs 1 60       # 显示 1，保持 60 秒
 *   node tools/badge-demo.mjs 0          # 立即清除
 *
 * 退出码：0 成功；2 非 Windows / 缺 .NET 编译器；3 助手无法启动。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const count = Math.max(0, Math.min(999, Number(process.argv[2] ?? 3) || 0))
const keepSeconds = Math.max(1, Number(process.argv[3] ?? 20) || 20)

const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.join(here, 'badge-helper.cs')
const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh')
const dir = path.join(home, 'dsh-sound-alert')
const exe = path.join(dir, 'badge-helper.exe')
const state = path.join(dir, 'badge-state.json')
const log = path.join(dir, 'badge-helper.log')

if (process.platform !== 'win32') {
  console.error('任务栏徽标只在 Windows 上可用')
  process.exit(2)
}

fs.mkdirSync(dir, { recursive: true })

/** 编译助手（按源码 mtime+size 判断是否需要重编）。 */
function ensureExe() {
  let stamp = null
  try {
    const stat = fs.statSync(source)
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch (err) {
    console.error(`找不到助手源码：${source}`)
    process.exit(2)
  }
  const stampFile = `${exe}.stamp`
  try {
    if (fs.readFileSync(stampFile, 'utf8') === stamp && fs.existsSync(exe)) return
  } catch (err) {
    /* 需要编译 */
  }
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const compiler = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((candidate) => fs.existsSync(candidate))
  if (compiler === undefined) {
    console.error('没有找到 .NET Framework 编译器（csc.exe），无法启用任务栏徽标')
    process.exit(2)
  }
  const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, source, '/r:System.Drawing.dll'], {
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result.status !== 0 || !fs.existsSync(exe)) {
    console.error(`编译失败：${String(result.stderr || result.error || result.status)}`)
    process.exit(2)
  }
  fs.writeFileSync(stampFile, stamp)
  console.log('已编译助手（一次性）')
}

function writeState(value) {
  fs.writeFileSync(state, JSON.stringify({
    count: value,
    pending: value,
    completed: 0,
    beat: Date.now(),
    text: value > 0 ? `${value} conversations need attention` : '',
  }))
}

ensureExe()

if (count === 0) {
  writeState(0)
  console.log('已写入 0：助手会在约 1.5 秒内清除徽标并退出')
  process.exit(0)
}

writeState(count)
const child = spawn(exe, ['--state', state, '--log', log], { detached: true, stdio: 'ignore', windowsHide: true })
child.unref()
console.log(`已启动助手（pid=${child.pid}），任务栏 DSH 图标上应出现红色数字 ${count}`)
console.log(`日志：${log}`)

const beat = setInterval(() => writeState(count), 10000)
beat.unref?.()
setTimeout(() => {
  writeState(0)
  clearInterval(beat)
  console.log('演示结束，徽标已清除')
  process.exit(0)
}, keepSeconds * 1000)
