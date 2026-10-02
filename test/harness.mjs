/**
 * dsh-sound-alert —— 客户端半区离线测试  v1.1
 *
 * 不打开浏览器也能验证最容易出错的三件事：
 *   1. 音效内容：渲染出来的 PCM 不是静音、不削顶、两种音效音高走向不同（过零率）；
 *   2. 播放通道：Web Audio 可用时走 Web Audio；被挂起时自动退回 <audio> + WAV；
 *   3. 判定逻辑：基线不响、当前会话跑完响「完成」、出现待确认（提问/授权）响「确认」、
 *      非关注会话与总开关关闭时不响。
 *
 * 运行：node test/harness.mjs
 */
import assert from 'node:assert/strict'

/* ------------------------------------------------------------------ 假环境 */

let lastContext = null

class FakeParam {
  constructor(value) { this.value = value }
  setValueAtTime(value) { this.value = value; return this }
  exponentialRampToValueAtTime(value) { this.value = value; return this }
  linearRampToValueAtTime(value) { this.value = value; return this }
}

class FakeNode {
  connect(next) { return next }
  disconnect() {}
}

class FakeGain extends FakeNode {
  constructor() { super(); this.gain = new FakeParam(1) }
}

class FakeFilter extends FakeNode {
  constructor() { super(); this.type = 'lowpass'; this.frequency = new FakeParam(350); this.Q = new FakeParam(1) }
}

class FakeBuffer {
  constructor(channels, length) { this.channels = Array.from({ length: channels }, () => new Float32Array(length)) }
  getChannelData(index) { return this.channels[index] }
}

class FakeBufferSource extends FakeNode {
  constructor() { super(); this.buffer = null; this.started = false }
  start() { this.started = true; FakeBufferSource.started += 1 }
  stop() {}
}
FakeBufferSource.started = 0

class FakeAudioContext {
  constructor() {
    this.state = FakeAudioContext.initialState
    this.currentTime = 0
    this.destination = new FakeNode()
    this.createdBuffers = []
    lastContext = this
  }
  static initialState = 'running'
  static resumeWorks = true
  createOscillator() { return new FakeNode() }
  createGain() { return new FakeGain() }
  createBiquadFilter() { return new FakeFilter() }
  createBuffer(channels, length) { const buf = new FakeBuffer(channels, length); this.createdBuffers.push(buf); return buf }
  createBufferSource() { return new FakeBufferSource() }
  resume() {
    if (FakeAudioContext.resumeWorks) this.state = 'running'
    return Promise.resolve()
  }
}
FakeAudioContext.initialState = 'running'

class FakeStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

const mediaPlays = []

function createFakeAudioElement() {
  const element = {
    src: '', volume: 1, preload: '',
    listeners: {},
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) },
    play() { mediaPlays.push({ src: element.src, volume: element.volume }); return Promise.resolve() },
  }
  return element
}

let captured = null
globalThis.localStorage = new FakeStorage()
globalThis.AudioContext = FakeAudioContext
globalThis.location = { href: 'harness://dsh-sound-alert' }
globalThis.document = {
  listeners: {},
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) },
  removeEventListener() {},
  createElement(tag) { return tag === 'audio' ? createFakeAudioElement() : { style: {}, dataset: {}, appendChild() {} } },
}
globalThis.Blob = class Blob { constructor(parts, options) { this.parts = parts; this.type = options && options.type } }
globalThis.URL.createObjectURL = () => 'blob:harness/1'
globalThis.URL.revokeObjectURL = () => {}
globalThis.setInterval = globalThis.setInterval
// 浏览器里 window === globalThis，假 window 上也必须有同一批全局
globalThis.window = {
  __ModuleLoader__: { load: (row) => { captured = row } },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  AudioContext: FakeAudioContext,
  localStorage: globalThis.localStorage,
  location: globalThis.location,
  document: globalThis.document,
}

/* ------------------------------------------------------------ 载入待测模块 */

await import('../lib/client.js')

assert.ok(captured !== null, '客户端 bundle 必须调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-sound-alert', 'bundle id 必须等于包名')
const exported = captured.factory()
assert.deepEqual(exported.inject, ['sessions'], '应声明 sessions 依赖')
assert.equal(typeof exported.apply, 'function', '必须导出 apply')

/* -------------------------------------------------------------- 假服务 */

/**
 * 假 sessions 服务。刻意不带 `current` 字段 —— 真实版本（0.2.0-rc.2）没有它，
 * 「当前会话」由 retainedBy.mainView > 0 表达，正是被测代码要走的路径。
 */
function createSessions() {
  const listeners = new Set()
  const snapshot = { ids: [], byId: {}, phase: 'ready' }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    },
    publish(byId, mainViewId = 's1') {
      snapshot.byId = Object.fromEntries(
        Object.entries(byId).map(([id, row]) => [id, { ...row, retainedBy: { mainView: id === mainViewId ? 1 : 0 } }]),
      )
      snapshot.ids = Object.keys(byId)
      for (const fn of listeners) fn()
    },
  }
}

function createUiSession() {
  const listeners = new Set()
  let snapshot = new Map()
  return {
    sessionStatus: {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    },
    publish(map) {
      snapshot = map
      for (const fn of listeners) fn()
    },
  }
}

function createContext(sessions, uiSession) {
  const base = {
    get: (name) => (name === 'sessions' ? sessions : undefined),
    effect(fn) { const result = fn(); return () => { if (typeof result === 'function') result() } },
  }
  base.inject = (names, callback) => callback({ get: base.get, effect: base.effect, inject: base.inject, uiSession })
  return base
}

/* -------------------------------------------------------------- 断言工具 */

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function stats(samples) {
  let peak = 0
  let energy = 0
  let crossings = 0
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i]
    peak = Math.max(peak, Math.abs(value))
    energy += value * value
    if (i > 0 && ((samples[i - 1] < 0) !== (value < 0))) crossings += 1
  }
  return {
    seconds: samples.length / 44100,
    peak,
    rms: Math.sqrt(energy / samples.length),
    zcr: crossings / (samples.length / 44100),
  }
}

/** 音效有 600ms 同类去重窗口；需要连续测试同一种音时，等过去重窗口。 */
const DEDUPE_GAP = 650
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------------------------------------- 用例 */

const sessions = createSessions()
const uiSession = createUiSession()
exported.apply(createContext(sessions, uiSession))
const api = window.dshSoundAlert

console.log('\n[A] 音效内容：不是静音、不削顶、两种音高走向不同')
const doneSamples = api.samples('done')
const confirmSamples = api.samples('confirm')
const doneStats = stats(doneSamples)
const confirmStats = stats(confirmSamples)
check('完成音有时长（>0.8s）', doneStats.seconds > 0.8, `${doneStats.seconds.toFixed(2)}s`)
check('完成音不是静音（rms > 0.02）', doneStats.rms > 0.02, `rms=${doneStats.rms.toFixed(4)}`)
check('完成音不削顶（peak ≤ 1）', doneStats.peak <= 1 && doneStats.peak > 0.15, `peak=${doneStats.peak.toFixed(3)}`)
check('确认音短促（<0.6s）', confirmStats.seconds < 0.6, `${confirmStats.seconds.toFixed(2)}s`)
check('确认音不是静音（rms > 0.02）', confirmStats.rms > 0.02, `rms=${confirmStats.rms.toFixed(4)}`)
check('确认音不削顶（peak ≤ 1）', confirmStats.peak <= 1 && confirmStats.peak > 0.15, `peak=${confirmStats.peak.toFixed(3)}`)
check('完成音比确认音明显更明亮/更高亢（过零率更高）', doneStats.zcr > confirmStats.zcr * 1.5, `done=${doneStats.zcr.toFixed(0)}Hz confirm=${confirmStats.zcr.toFixed(0)}Hz`)
check('两音区确实拉开（高亢 >2000Hz / 低沉 <1400Hz 过零率）', doneStats.zcr > 2000 && confirmStats.zcr < 1400, `done=${doneStats.zcr.toFixed(0)}Hz confirm=${confirmStats.zcr.toFixed(0)}Hz`)
check('两种音效波形不同', doneSamples.length !== confirmSamples.length && Math.abs(doneStats.zcr - confirmStats.zcr) > 50)

console.log('\n[B] WAV 编码（预览文件与 <audio> 回退共用）')
const wav = api.wav('done')
const wavText = String.fromCharCode(...wav.slice(0, 4)) + String.fromCharCode(...wav.slice(8, 12))
check('RIFF/WAVE 头正确', wavText === 'RIFFWAVE', wavText)
check('WAV 长度 = 44 + 采样数×2', wav.length === 44 + doneSamples.length * 2, `${wav.length}`)

console.log('\n[C] 播放通道：AudioContext 挂起时自动退回 <audio>')
FakeAudioContext.initialState = 'suspended'
FakeAudioContext.resumeWorks = false
const fallbackPath = api.test('confirm')
check('退回 media 通道', fallbackPath === 'media', String(fallbackPath))
check('确实创建了 <audio> 播放', mediaPlays.length === 1, `${mediaPlays.length} 次`)
check('音量跟随设置', Math.abs(mediaPlays[0].volume - api.volume) < 1e-6, String(mediaPlays[0].volume))
FakeAudioContext.resumeWorks = true
if (lastContext !== null) lastContext.state = 'running'

console.log('\n[D] 播放通道：可用时走 Web Audio')
const webPath = api.test('done')
check('走 webaudio 通道', webPath === 'webaudio', String(webPath))
check('AudioBuffer 采样数与渲染一致', lastContext.createdBuffers.some((buf) => buf.channels[0].length === doneSamples.length))

console.log('\n[E] 判定：基线不响')
const firesBefore = api.diag().fires.length
sessions.publish({ s1: { running: true, displayTitle: '主会话' } })
uiSession.publish(new Map())
check('基线快照不发声', api.diag().fires.length === firesBefore, `${api.diag().fires.length - firesBefore} 次`)

console.log('\n[F] 判定：当前会话 running: true → false = 任务完成')
await sleep(DEDUPE_GAP)
let before = api.diag().fires.length
sessions.publish({ s1: { running: false, displayTitle: '主会话' } })
let fired = api.diag().fires.slice(before)
check('响了「完成」音', fired.length === 1 && fired[0].kind === 'done', JSON.stringify(fired))

console.log('\n[G] 判定：出现提问 = 需要确认')
before = api.diag().fires.length
uiSession.publish(new Map([['s1', { running: true, pendingInteraction: { kind: 'question', id: 'q1' }, completionUnread: false }]]))
fired = api.diag().fires.slice(before)
check('响了「确认」音', fired.length === 1 && fired[0].kind === 'confirm', JSON.stringify(fired))

console.log('\n[H] 判定：换成授权请求也应提醒')
await sleep(DEDUPE_GAP)
before = api.diag().fires.length
uiSession.publish(new Map([['s1', { running: true, pendingInteraction: { kind: 'approval', id: 'a1' }, completionUnread: false }]]))
fired = api.diag().fires.slice(before)
check('响了「确认」音', fired.length === 1 && fired[0].kind === 'confirm', JSON.stringify(fired))

console.log('\n[I] 判定：清空 pending 不响；随后完成仍响（sessionStatus 落后一拍也照样响）')
before = api.diag().fires.length
uiSession.publish(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
check('清空 pending 不发声', api.diag().fires.length === before)
await sleep(DEDUPE_GAP)
before = api.diag().fires.length
sessions.publish({ s1: { running: true, displayTitle: '主会话' } })
sessions.publish({ s1: { running: false, displayTitle: '主会话' } })
fired = api.diag().fires.slice(before)
check('随后完成发声', fired.length === 1 && fired[0].kind === 'done', JSON.stringify(fired))

console.log('\n[J] 判定：非关注会话完成时不发声')
before = api.diag().fires.length
sessions.publish({ s1: { running: true, displayTitle: '主会话' }, s2: { running: true, displayTitle: '后台会话' } }, 's1')
sessions.publish({ s1: { running: true, displayTitle: '主会话' }, s2: { running: false, displayTitle: '后台会话' } }, 's1')
check('后台会话完成不发声', api.diag().fires.length === before, `${api.diag().fires.length - before} 次`)

console.log('\n[K] 判定：主视图信息缺失时退化为「都算关注」，不漏响')
const sessions2 = createSessions()
const ui2 = createUiSession()
const api2module = captured.factory()
const handled = api2module.apply(createContext(sessions2, ui2))
const api2 = window.dshSoundAlert
sessions2.list.getSnapshot().byId = { s9: { running: true, displayTitle: '无主视图会话', retainedBy: {} } }
await sleep(DEDUPE_GAP * 2)
sessions2.publish({ s9: { running: true, displayTitle: '无主视图会话' } }, 'nobody')
sessions2.publish({ s9: { running: false, displayTitle: '无主视图会话' } }, 'nobody')
check('退化模式下仍发声', api2.diag().fires.some((row) => row.kind === 'done'), JSON.stringify(api2.diag().fires.map((row) => row.kind)))
check('apply 返回值可为 undefined（不干扰 cordis）', handled === undefined)

console.log('\n[L] 总开关')
api.on()
before = api.diag().fires.length
api.off()
check('off() 后 enabled=false', api.enabled === false)
check('总开关状态已持久化', localStorage.getItem('dsh-sound-alert:settings') !== null)
api.on()

console.log('\n[M] 诊断痕迹（不必打开 DevTools 也能排查）')
const d = api.diag()
check('diag 有 mountedAt', typeof d.mountedAt === 'string')
check('diag 记录了状态变化历史', Array.isArray(d.changes) && d.changes.length > 0)
check('diag 记录了发声历史（含通道）', Array.isArray(d.fires) && d.fires.every((row) => typeof row.path === 'string'))
check('diag 写入了 localStorage', localStorage.getItem('dsh-sound-alert:diag') !== null)
check('boot 痕迹已写入', localStorage.getItem('dsh-sound-alert:boot') !== null)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
