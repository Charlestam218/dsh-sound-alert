/**
 * dsh-sound-alert —— 音效预览渲染器
 *
 * 复用客户端半区的同一份合成代码，把两种提示音渲染成 WAV 文件，
 * 便于不打开 DSH 也能试听 / 对比 / 交给别人确认音色。
 *
 * 运行：node tools/render-preview.mjs
 * 输出：preview/done.wav（任务完成）、preview/confirm.wav（需要确认）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'preview')

/* ---- 最小假环境：只为了让客户端 bundle 能被载入并导出渲染函数 ---- */

class FakeParam {
  constructor(value) { this.value = value }
  setValueAtTime(value) { this.value = value; return this }
  exponentialRampToValueAtTime(value) { this.value = value; return this }
}
class FakeNode { connect(next) { return next } disconnect() {} }
class FakeGain extends FakeNode { constructor() { super(); this.gain = new FakeParam(1) } }
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new FakeNode() }
  createGain() { return new FakeGain() }
  createBiquadFilter() { return new FakeGain() }
  createBuffer() { return { getChannelData: () => new Float32Array(1) } }
  createBufferSource() { return { connect() {}, start() {} } }
  resume() { return Promise.resolve() }
}

let captured = null
globalThis.AudioContext = FakeAudioContext
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.location = { href: 'preview://renderer' }
globalThis.document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({}) }
globalThis.window = {
  __ModuleLoader__: { load: (row) => { captured = row } },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  AudioContext: FakeAudioContext,
  localStorage: globalThis.localStorage,
  location: globalThis.location,
  document: globalThis.document,
}

await import('../lib/client.js')

const api = captured.factory()
api.apply({
  get: (name) => (name === 'sessions' ? { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } } : undefined),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  inject: () => () => {},
})

fs.mkdirSync(outDir, { recursive: true })

const report = []
for (const [kind, file] of [['done', 'done.wav'], ['confirm', 'confirm.wav']]) {
  const samples = window.dshSoundAlert.samples(kind)
  const wav = window.dshSoundAlert.wav(kind)
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) peak = Math.max(peak, Math.abs(samples[i]))
  const target = path.join(outDir, file)
  fs.writeFileSync(target, Buffer.from(wav))
  report.push({ kind, file: target, seconds: samples.length / 44100, peak, bytes: wav.length })
}

for (const row of report) {
  console.log(`${row.kind.padEnd(8)} -> ${row.file}  ${row.seconds.toFixed(2)}s  peak=${row.peak.toFixed(3)}  ${(row.bytes / 1024).toFixed(1)} KB`)
}

// 插件在 apply() 里装了 5 秒诊断心跳；这里是离线渲染工具，直接退出。
process.exit(0)
