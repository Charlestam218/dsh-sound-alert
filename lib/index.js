/**
 * dsh-sound-alert —— 宿主半区（Node 侧）
 *
 * 三件事：
 *   1. 作为 Loader 条目存在 —— DSH 的客户端模块系统只扫描「已启用的 Loader 条目」，
 *      并把条目的 package.json 里 `dsh.client` 声明变成浏览器 bundle；
 *   2. 任务栏徽标（Windows）：浏览器半区把「需要确认 + 已完成未读」的会话数量推到这里，
 *      这里落盘成状态文件，并拉起一个极小的 C# 助手进程，由它调用
 *      ITaskbarList3::SetOverlayIcon 在 DSH 任务栏按钮上画出红点数字；
 *   3. 记录加载/卸载痕迹，便于自检。
 *
 * 为什么徽标要绕一层进程：DSH 宿主是 Electron 以 Node 模式 fork 出来的子进程
 * （`ELECTRON_RUN_AS_NODE=1`），拿不到 Electron 的窗口 API；而桌面壳的 IPC 只认
 * shutdown-complete / ready / platform-session / fatal / update-tasks / quit-inspection
 * 六种消息，没有徽标通道。于是直接用 Win32 的公开接口实现，与 DSH 版本解耦。
 * 助手运行在宿主进程之外：既不让任何 FFI 风险波及 DSH，也让它随状态文件自然退出。
 *
 * 静默降级：非 Windows、缺 .NET 编译器、找不到窗口或权限不足时，路由会回报
 * `mode: "unsupported"`，浏览器半区据此退回 `navigator.setAppBadge()`；
 * 徽标失败绝不影响音效功能。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOG_BASENAME = '.dsh-sound-alert.log'
const DATA_DIR_NAME = 'dsh-sound-alert'
const ROUTE_PATH = '/dsh-sound-alert/attention'
/** 状态文件心跳间隔：助手超过自身 STALE 阈值就清掉徽标退出（宿主崩溃/插件卸载时兜底）。 */
const HEARTBEAT_MS = 20000
/** 助手最长存活：即使一直有徽标也周期性重启，避免任何僵死状态。 */
const HELPER_MAX_MS = 6 * 60 * 60 * 1000

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
}

/** 追加一行痕迹；任何失败都静默（绝不因为日志影响宿主）。 */
function trace(line) {
  try {
    fs.appendFileSync(path.join(dshHome(), LOG_BASENAME), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch (err) {
    /* 忽略：日志是尽力而为 */
  }
}

/** 找系统自带的 .NET Framework 编译器（Windows 10/11 自带，无需 SDK）。 */
function findCompiler() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch (err) {
      /* 继续找 */
    }
  }
  return null
}

function clamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(999, Math.trunc(number)))
}

/** 任务栏徽标控制器：状态文件 + 助手进程生命周期。 */
class TaskbarBadge {
  constructor() {
    this.dataDir = path.join(dshHome(), DATA_DIR_NAME)
    this.statePath = path.join(this.dataDir, 'badge-state.json')
    this.logPath = path.join(this.dataDir, 'badge-helper.log')
    this.exePath = path.join(this.dataDir, 'badge-helper.exe')
    this.sourcePath = fileURLToPath(new URL('../tools/badge-helper.cs', import.meta.url))
    this.child = null
    this.childStartedAt = 0
    this.heartbeat = null
    this.count = { count: 0, pending: 0, completed: 0 }
    this.mode = 'unknown' // taskbar | unsupported | unknown
    this.reason = null
    this.compiledStamp = null
  }

  /** 编译一次并缓存；源码更新（mtime+size 变化）则重编。 */
  ensureHelper() {
    if (process.platform !== 'win32') {
      this.mode = 'unsupported'
      this.reason = 'not-windows'
      return false
    }
    let stamp
    try {
      const stat = fs.statSync(this.sourcePath)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch (err) {
      this.mode = 'unsupported'
      this.reason = 'helper-source-missing'
      return false
    }
    if (this.compiledStamp === stamp && fs.existsSync(this.exePath)) return true

    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
    } catch (err) {
      /* 目录已存在 */
    }
    const compiler = findCompiler()
    if (compiler === null) {
      this.mode = 'unsupported'
      this.reason = 'no-csc'
      return false
    }
    try {
      const result = spawnSync(compiler, [
        '/nologo', '/target:exe', `/out:${this.exePath}`, this.sourcePath, '/r:System.Drawing.dll',
      ], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
      if (result.status !== 0 || !fs.existsSync(this.exePath)) {
        this.mode = 'unsupported'
        this.reason = `compile-failed:${String(result.stderr || result.error || result.status).slice(0, 200)}`
        return false
      }
    } catch (err) {
      this.mode = 'unsupported'
      this.reason = `compile-error:${String((err && err.message) || err)}`
      return false
    }
    this.compiledStamp = stamp
    trace('badge: helper compiled')
    return true
  }

  /** 写状态文件：count / pending / completed / beat（助手据此画或清徽标）。 */
  writeState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      const body = JSON.stringify({
        count: this.count.count,
        pending: this.count.pending,
        completed: this.count.completed,
        beat: Date.now(),
        text: this.count.count > 0
          ? `${this.count.count} 个会话需要你的注意（待确认 ${this.count.pending} / 已完成 ${this.count.completed}）`
          : '',
      })
      const temp = `${this.statePath}.tmp`
      fs.writeFileSync(temp, body, 'utf8')
      fs.renameSync(temp, this.statePath)
    } catch (err) {
      trace(`badge: state write failed: ${String((err && err.message) || err)}`)
    }
  }

  /** 需要时拉起助手（它自己轮询状态文件，直到归零或心跳过期才退出）。 */
  ensureHelperRunning() {
    if (this.child !== null && this.child.exitCode === null && !this.child.killed) {
      if (Date.now() - this.childStartedAt < HELPER_MAX_MS) return true
      try { this.child.kill() } catch (err) { /* 忽略 */ }
      this.child = null
    }
    if (!this.ensureHelper()) return false
    try {
      const child = spawn(this.exePath, ['--state', this.statePath, '--log', this.logPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('exit', (code) => {
        if (this.child === child) this.child = null
        trace(`badge: helper exited code=${String(code)}`)
        this.refreshModeFromLog()
      })
      child.on('error', (error) => {
        if (this.child === child) this.child = null
        this.mode = 'unsupported'
        this.reason = `spawn-failed:${String((error && error.message) || error)}`
      })
      child.unref()
      this.child = child
      this.childStartedAt = Date.now()
      trace(`badge: helper spawned pid=${String(child.pid)}`)
      return true
    } catch (err) {
      this.mode = 'unsupported'
      this.reason = `spawn-error:${String((err && err.message) || err)}`
      return false
    }
  }

  /** 助手日志是唯一的事实来源：出现 `badge set` 才认为任务栏通道真的工作了。 */
  refreshModeFromLog() {
    try {
      const text = fs.readFileSync(this.logPath, 'utf8')
      if (text.includes('badge set count=')) {
        this.mode = 'taskbar'
        this.reason = null
        return
      }
      if (text.includes('SetOverlayIcon failed')) {
        this.mode = 'unsupported'
        this.reason = 'overlay-denied'
        return
      }
      if (text.includes('exit: taskbar COM unavailable')) {
        this.mode = 'unsupported'
        this.reason = 'com-unavailable'
        return
      }
      if (text.includes('exit: no window')) {
        this.mode = 'unsupported'
        this.reason = 'no-window'
      }
    } catch (err) {
      /* 日志还没生成 */
    }
  }

  /** 浏览器半区推来的新计数。 */
  update(raw) {
    this.count = { count: clamp(raw.count), pending: clamp(raw.pending), completed: clamp(raw.completed) }
    this.writeState()
    if (this.count.count > 0) this.ensureHelperRunning()
    else this.refreshModeFromLog()
    this.startHeartbeat()
    this.refreshModeFromLog()
    return { mode: this.mode, reason: this.reason, count: this.count.count }
  }

  /** 只要有徽标就周期性刷新 beat，让助手知道宿主还活着。 */
  startHeartbeat() {
    if (this.heartbeat !== null) return
    this.heartbeat = setInterval(() => {
      if (this.count.count > 0) {
        this.writeState()
        this.refreshModeFromLog()
      } else {
        clearInterval(this.heartbeat)
        this.heartbeat = null
      }
    }, HEARTBEAT_MS)
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
  }

  /** 卸载/退出：把徽标清掉（写 0 让助手自己收尾），并停止心跳。 */
  dispose() {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    this.count = { count: 0, pending: 0, completed: 0 }
    this.writeState()
  }
}

function parseQuery(url) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams
  } catch (err) {
    return new URLSearchParams('')
  }
}

export const name = 'dsh-sound-alert'

export function apply(ctx) {
  trace(`host loaded (pid=${process.pid}) — 音效由浏览器半区播放`)

  const badge = new TaskbarBadge()

  try {
    if (ctx && typeof ctx.logger === 'object' && ctx.logger !== null && typeof ctx.logger.info === 'function') {
      ctx.logger.info('dsh-sound-alert: 已加载（任务完成 / 需要确认时播放提示音，任务栏显示未读数量）')
    }
  } catch (err) {
    /* 忽略 */
  }

  if (ctx && typeof ctx.effect === 'function' && typeof ctx.inject === 'function') {
    // 任务栏徽标接口：浏览器半区用相对路径 GET 推计数（与 dsh-whale 的客户端插件同一做法）。
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => scope.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => {
          const query = parseQuery(req.url)
          const result = badge.update({
            count: query.get('n'),
            pending: query.get('p'),
            completed: query.get('c'),
          })
          const body = JSON.stringify({ ok: true, mode: result.mode, reason: result.reason, count: result.count })
          try {
            res.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-store',
              'Content-Length': String(Buffer.byteLength(body)),
            })
            res.end(body)
          } catch (err) {
            /* 连接已断开 */
          }
        },
      }), 'dsh-sound-alert: 任务栏徽标接口')
    })

    ctx.effect(() => () => {
      badge.dispose()
      trace('host unloaded')
    }, 'dsh-sound-alert: 痕迹日志与任务栏徽标')
  }
}

export default { name, apply }
