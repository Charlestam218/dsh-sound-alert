/**
 * dsh-sound-alert —— 宿主半区（Node 侧）
 *
 * 本插件的「听得到的声音」全部在浏览器半区（lib/client.js）产生：它订阅客户端的
 * 会话状态，任务完成 / 需要确认时用 Web Audio 合成音效播放。
 *
 * 宿主半区只做三件事：
 *   1. 作为 Loader 条目存在 —— 客户端模块系统只扫描「已启用的 Loader 条目」，
 *      并把条目的 package.json 里 `dsh.client` 声明变成浏览器 bundle；
 *   2. 记录一行加载/卸载痕迹，便于自检（不写业务状态，不注册任何路由）；
 *   3. 把加载结果写进日志，出问题时能在 DSH 日志里定位。
 *
 * 刻意保持「零依赖、零路由、零配置」：宿主侧任何一步失败都不会影响 DSH 本身，
 * 而浏览器半区是否生效可以独立自检（见 README 的「自检」一节）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LOG_BASENAME = '.dsh-sound-alert.log'

/** 解析痕迹日志路径：优先 $DSH_HOME，退回家目录。 */
function resolveLogPath() {
  try {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    return path.join(home, LOG_BASENAME)
  } catch (err) {
    return null
  }
}

/** 追加一行痕迹；任何失败都静默（绝不因为日志影响宿主）。 */
function trace(line) {
  const file = resolveLogPath()
  if (file === null) return
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch (err) {
    /* 忽略：日志是尽力而为 */
  }
}

export const name = 'dsh-sound-alert'

export function apply(ctx) {
  trace(`host loaded (pid=${process.pid}) — 音效由浏览器半区播放`)

  try {
    if (ctx && typeof ctx.logger === 'object' && ctx.logger !== null && typeof ctx.logger.info === 'function') {
      ctx.logger.info('dsh-sound-alert: 已加载（任务完成 / 需要确认时在浏览器端播放提示音）')
    }
  } catch (err) {
    /* 忽略 */
  }

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      trace('host unloaded')
    }, 'dsh-sound-alert: 痕迹日志')
  }
}

export default { name, apply }
