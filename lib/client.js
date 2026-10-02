/**
 * dsh-sound-alert —— 浏览器半区（客户端插件）  v1.1.0
 *
 * 职责：判断「任务完成」和「需要确认」两个时刻，并播放两种不同的清脆音效。
 *
 * 音频实现：音效由纯 JS 按 FM 合成公式逐采样渲染成 PCM（44.1kHz 单声道），
 * 再经两条通道播放 —— 优先 Web Audio（AudioBufferSourceNode），若上下文被浏览器
 * 挂起（自动播放策略）则退回 HTMLAudioElement + WAV Blob。渲染与播放都可在 Node 里
 * 离线测试（见 test/harness.mjs），因此「两种声音确实不同、且都不是静音」是可验证的。
 *
 * 判定来源（DSH Web 客户端自己的运行时状态，不猜 DOM）：
 *   · 任务完成 —— 会话控制器里当前会话 `running: true → false`；
 *   · 需要确认 —— `uiSession.sessionStatus` 里该会话出现 `pendingInteraction`
 *     （kind = approval / question / plan-review：授权、提问、计划审阅都算「要你拍板」）。
 *
 * 本文件是「已构建的客户端 bundle」：入口只做一件事 —— 用 window.__ModuleLoader__
 * 注册 factory，模块副作用在物化时执行。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sound-alert',
  factory: () => {
    const module = { exports: {} }

    /* ======================================================================
     * 常量
     * ==================================================================== */

    const VERSION = '1.2.0'
    const SETTINGS_KEY = 'dsh-sound-alert:settings'
    const BOOT_KEY = 'dsh-sound-alert:boot'
    const PLAYS_KEY = 'dsh-sound-alert:plays'
    const DIAG_KEY = 'dsh-sound-alert:diag'
    /** 同一种音效的最小间隔，防止同一时刻被多个订阅重复触发。 */
    const DEDUPE_MS = 600
    const SAMPLE_RATE = 44100

    const DEFAULT_SETTINGS = { enabled: true, volume: 0.7 }

    const settings = { ...DEFAULT_SETTINGS }
    try {
      const raw = localStorage.getItem(SETTINGS_KEY)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          if (typeof parsed.enabled === 'boolean') settings.enabled = parsed.enabled
          if (typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)) {
            settings.volume = Math.min(1, Math.max(0, parsed.volume))
          }
        }
      }
    } catch (err) {
      /* 设置读不出来就用默认值 */
    }

    function saveSettings() {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch (err) {
        /* 忽略 */
      }
    }

    /* ======================================================================
     * 诊断：把页面里的真实状态写进 localStorage，供离线排查
     * ==================================================================== */

    const diag = {
      version: VERSION,
      mountedAt: new Date().toISOString(),
      at: null,
      unloadedAt: null,
      fires: [],          // 最近几次发声：{kind, at, path}
      changes: [],        // 最近几次状态变化：{at, id, running, pending, focused, fired}
      audio: 'not-created',
      lastPath: null,
      lastError: null,
      done: 0,
      confirm: 0,
    }

    function publishDiag() {
      try {
        diag.at = new Date().toISOString()
        diag.audio = audio === null ? 'not-created' : audio.state
        localStorage.setItem(DIAG_KEY, JSON.stringify(diag))
      } catch (err) {
        /* 忽略 */
      }
    }

    function noteChange(entry) {
      diag.changes.push(entry)
      if (diag.changes.length > 12) diag.changes.shift()
    }

    /* ======================================================================
     * 音效：纯 JS 渲染 PCM
     * ==================================================================== */

    /**
     * 每个音 = 一个 FM 声部（载波 + 调制器）：
     *   freq 音高；ratio 调制比（2.76 ≈ 钟的 inharmonic 比值，3~4 ≈ 木琴/木鼓）；
     *   index 起始调制指数（亮/硬），indexDecay 亮度衰减时间常数；
     *   attack 起振时间，decay 余音长度（-60dB），level 相对强度。
     *
     * 两个音效刻意做在**两个音区**上，一耳朵分得开：
     *   完成 = 高亢（E6 1319Hz → B6 1976Hz，亮铃）
     *   确认 = 低沉（A3 220Hz → E3 165Hz，低音木鼓）
     */
    const RECIPES = {
      // 完成：E6 → B6 上行双音亮铃，清亮、有余音、收束感明确
      done: [
        { freq: 1318.51, at: 0.0, ratio: 2.76, index: 1.9, indexDecay: 0.28, attack: 0.004, decay: 0.80, level: 0.30 },
        { freq: 1975.53, at: 0.12, ratio: 2.76, index: 1.6, indexDecay: 0.24, attack: 0.004, decay: 0.90, level: 0.26 },
      ],
      // 需要确认：A3 → E3 下行低音木鼓，低沉、干爽、有推进感
      confirm: [
        { freq: 220.0, at: 0.0, ratio: 3.0, index: 1.6, indexDecay: 0.06, attack: 0.004, decay: 0.30, level: 0.34 },
        { freq: 164.81, at: 0.18, ratio: 3.0, index: 1.5, indexDecay: 0.06, attack: 0.004, decay: 0.38, level: 0.32 },
      ],
    }

    const rendered = new Map()

    /** 渲染一个音效为 Float32Array（44.1kHz 单声道）。 */
    function renderSamples(kind) {
      if (rendered.has(kind)) return rendered.get(kind)
      const notes = RECIPES[kind]
      if (notes === undefined) return null

      let total = 0
      for (const note of notes) total = Math.max(total, note.at + note.attack + note.decay)
      const length = Math.ceil((total + 0.03) * SAMPLE_RATE)
      const out = new Float32Array(length)

      for (const note of notes) {
        const start = Math.min(length, Math.floor(note.at * SAMPLE_RATE))
        const span = Math.min(length - start, Math.ceil((note.attack + note.decay) * SAMPLE_RATE))
        const tau = note.decay / 6.9 // e^-6.9 ≈ 0.001 ≈ -60dB
        for (let i = 0; i < span; i += 1) {
          const t = i / SAMPLE_RATE
          // 起振：线性爬升（避免咔哒），之后指数衰减
          const env = t < note.attack ? t / note.attack : Math.exp(-(t - note.attack) / tau)
          const index = note.index * Math.exp(-t / note.indexDecay)
          const phase = 2 * Math.PI * note.freq * t + index * Math.sin(2 * Math.PI * note.freq * note.ratio * t)
          out[start + i] += Math.sin(phase) * env * note.level
        }
      }

      // 收尾 5ms 淡出，避免波形被截断产生爆音
      const fade = Math.min(Math.floor(0.005 * SAMPLE_RATE), length)
      for (let i = 0; i < fade; i += 1) out[length - fade + i] *= 1 - i / fade

      rendered.set(kind, out)
      return out
    }

    /** Float32 采样 → 16bit PCM WAV 字节（给 HTMLAudioElement 通道用）。 */
    function encodeWav(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
      }
      ascii(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      ascii(8, 'WAVE')
      ascii(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)   // PCM
      view.setUint16(22, 1, true)   // 单声道
      view.setUint32(24, SAMPLE_RATE, true)
      view.setUint32(28, SAMPLE_RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      ascii(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      }
      return bytes
    }

    /* ======================================================================
     * 播放：Web Audio 优先，被挂起则退回 <audio> + WAV Blob
     * ==================================================================== */

    let audio = null
    let master = null
    let gestureBound = false

    /** 懒创建 AudioContext；创建失败返回 null（静默降级，绝不抛给调用方）。 */
    function audioContext() {
      if (audio !== null) return audio
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (typeof Ctor !== 'function') return null
        audio = new Ctor()
        master = audio.createGain()
        master.gain.value = settings.volume
        const softener = audio.createBiquadFilter()
        softener.type = 'lowpass'
        softener.frequency.value = 9000
        softener.Q.value = 0.7
        master.connect(softener)
        softener.connect(audio.destination)
        bindGestureResume()
        publishDiag()
      } catch (err) {
        diag.lastError = `audiocontext: ${String((err && err.message) || err)}`
        audio = null
        master = null
      }
      return audio
    }

    /**
     * 浏览器的自动播放策略可能让 AudioContext 停在 suspended（需要一次用户手势）。
     * 挂一次性手势监听把它唤醒 —— 越早解锁，提示音越不可能被吞掉。
     */
    function bindGestureResume() {
      if (gestureBound) return
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
      gestureBound = true
      const wake = () => {
        try {
          // 在用户手势里创建/唤醒：Chromium 的自动播放策略对手势内创建的上下文最宽松，
          // 这样后面的提示音不会被静默吞掉。
          const ac = audioContext()
          if (ac !== null && ac.state === 'suspended') void ac.resume()
        } catch (err) {
          /* 忽略 */
        }
        document.removeEventListener('pointerdown', wake, true)
        document.removeEventListener('keydown', wake, true)
      }
      document.addEventListener('pointerdown', wake, true)
      document.addEventListener('keydown', wake, true)
    }

    /** 通道一：Web Audio。返回 'webaudio' 表示已经交给音频线程。 */
    function playWebAudio(samples) {
      const ac = audioContext()
      if (ac === null || master === null) return 'no-audiocontext'
      if (ac.state === 'suspended') {
        try { void ac.resume() } catch (err) { /* 忽略 */ }
      }
      if (ac.state !== 'running') return `suspended:${ac.state}`
      try {
        if (master.gain.value !== settings.volume) master.gain.setValueAtTime(settings.volume, ac.currentTime)
        const buffer = ac.createBuffer(1, samples.length, SAMPLE_RATE)
        buffer.getChannelData(0).set(samples)
        const source = ac.createBufferSource()
        source.buffer = buffer
        source.connect(master)
        source.start()
        return 'webaudio'
      } catch (err) {
        return `webaudio-failed:${String((err && err.message) || err)}`
      }
    }

    /** 通道二：HTMLAudioElement + WAV Blob（不受 AudioContext 挂起影响）。 */
    function playMedia(samples) {
      try {
        const url = URL.createObjectURL(new Blob([encodeWav(samples)], { type: 'audio/wav' }))
        const element = document.createElement('audio')
        element.src = url
        element.volume = settings.volume
        element.preload = 'auto'
        const release = () => {
          try { URL.revokeObjectURL(url) } catch (err) { /* 忽略 */ }
        }
        element.addEventListener('ended', release)
        element.addEventListener('error', release)
        const started = element.play()
        if (started !== undefined && typeof started.catch === 'function') {
          started.catch((err) => {
            diag.lastError = `media: ${String((err && err.name) || err)}`
            release()
            publishDiag()
          })
        }
        return 'media'
      } catch (err) {
        return `media-failed:${String((err && err.message) || err)}`
      }
    }

    /**
     * 播放一种音效。
     * @param kind - 'done'（任务完成）| 'confirm'（需要确认）
     * @param force - true 时忽略总开关（用于试听）
     * @returns 使用的通道名，未发声返回 null
     */
    function play(kind, force) {
      const samples = renderSamples(kind)
      if (samples === null) return null
      if (!force && !settings.enabled) return null

      let path = playWebAudio(samples)
      if (path !== 'webaudio') path = playMedia(samples)

      diag.lastPath = path
      diag[kind] = (diag[kind] || 0) + 1
      diag.fires.push({ kind, at: new Date().toISOString(), path })
      if (diag.fires.length > 8) diag.fires.shift()
      publishDiag()

      try {
        localStorage.setItem(PLAYS_KEY, JSON.stringify({
          done: diag.done, confirm: diag.confirm, lastKind: kind, lastAt: new Date().toISOString(), path,
        }))
      } catch (err) {
        /* 忽略 */
      }
      return path
    }

    /* ======================================================================
     * 状态机：把会话状态的变化翻译成两声音
     * ==================================================================== */

    /** sessionId -> { running, pendingKey }，用于前后对比。 */
    const previous = new Map()
    /** 用户「看过并且正在跑」的会话：切走之后它完成/提问也仍然提醒。 */
    const watched = new Set()

    let lastFired = { kind: null, at: 0 }
    let primed = false

    function fire(kind) {
      const now = Date.now()
      if (lastFired.kind === kind && now - lastFired.at < DEDUPE_MS) return false
      lastFired = { kind, at: now }
      play(kind, false)
      return true
    }

    /**
     * 读取所有会话的 {running, pendingKey}，并给出「用户正在看哪个会话」。
     * 当前会话 = 主视图持有的那一行（retainedBy.mainView > 0）；
     * 万一取不到（版本差异），退化为「所有非子会话都算关注」，宁可多响也不漏响。
     */
    function readStates(sessions, statusStore) {
      const states = new Map()
      let current = null
      let byId = {}
      try {
        const list = sessions.list.getSnapshot()
        byId = (list && list.byId) || {}
        if (list && list.current !== undefined && list.current !== null) {
          current = list.current
        } else {
          for (const id of Object.keys(byId)) {
            const row = byId[id]
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) { current = id; break }
          }
        }
        for (const id of Object.keys(byId)) {
          const row = byId[id]
          states.set(id, { running: row && row.running === true, pendingKey: null, child: !!(row && row.parentId) })
        }
      } catch (err) {
        diag.lastError = `list: ${String((err && err.message) || err)}`
      }
      if (statusStore !== null) {
        try {
          const status = statusStore.getSnapshot()
          if (status !== null && typeof status.forEach === 'function') {
            status.forEach((entry, id) => {
              const slot = states.get(id) || { running: false, pendingKey: null, child: false }
              // running 以会话控制器（sessions.list）为准：sessionStatus 里的是派生态，
              // 可能落后一拍；列表里没有这条会话时才退回用它。
              if (states.has(id) !== true && entry && typeof entry.running === 'boolean') slot.running = entry.running
              const pending = entry && entry.pendingInteraction
              slot.pendingKey = pending === undefined || pending === null
                ? null
                : `${pending.kind}:${pending.id !== undefined ? pending.id : (pending.key !== undefined ? pending.key : '')}`
              states.set(id, slot)
            })
          }
        } catch (err) {
          diag.lastError = `status: ${String((err && err.message) || err)}`
        }
      }
      return { states, current }
    }

    /** 每次会话状态变化时对比前后，决定要不要响。 */
    function evaluate(sessions, statusStore) {
      const { states, current } = readStates(sessions, statusStore)
      const allowAll = current === null

      for (const [id, next] of states) {
        const before = previous.get(id) || { running: false, pendingKey: null }
        previous.set(id, next)
        const focused = id === current || watched.has(id) || (allowAll && next.child !== true)

        if (primed) {
          // 两个「该响」的边沿：跑完（true→false）、出现新的待确认交互。
          // 无论最终响不响都记一条诊断 —— 这样事后能区分「没看到」和「看到但判定为不关注」。
          const doneEdge = before.running === true && next.running === false
          const pendingEdge = next.pendingKey !== null && next.pendingKey !== before.pendingKey
          if (doneEdge || pendingEdge) {
            let fired = false
            if (doneEdge && focused) {
              watched.delete(id)
              fired = fire('done')
            } else if (pendingEdge && focused) {
              fired = fire('confirm')
            }
            noteChange({
              at: new Date().toISOString(),
              id: id.slice(-8),
              running: `${String(before.running)}->${String(next.running)}`,
              pending: `${String(before.pendingKey)}->${String(next.pendingKey)}`,
              focused,
              fired,
            })
          }
        }

        if (next.running === true && id === current) watched.add(id)
        if (next.pendingKey === null && next.running === false && id !== current) watched.delete(id)
      }

      for (const id of [...previous.keys()]) {
        if (!states.has(id)) {
          previous.delete(id)
          watched.delete(id)
        }
      }
      if (!primed) {
        noteChange({ at: new Date().toISOString(), note: 'primed', sessions: states.size, current: current === null ? null : current.slice(-8), allowAll })
      }
      primed = true
      publishDiag()
    }

    /* ======================================================================
     * 插件入口
     * ==================================================================== */

    /** 对外小接口：试听 / 静音 / 调音量 / 看状态。挂在 window 上便于随时自检。 */
    function installApi() {
      const api = {
        version: VERSION,
        /** 试听：test() 依次响两种，test('done'|'confirm') 只响一种（忽略总开关） */
        test(kind) {
          const target = kind === 'confirm' || kind === 'done' ? kind : 'both'
          if (target === 'both') {
            const first = play('done', true)
            window.setTimeout(() => play('confirm', true), 1100)
            return { first, second: 'confirm' }
          }
          return play(target, true)
        },
        on() { settings.enabled = true; saveSettings(); return true },
        off() { settings.enabled = false; saveSettings(); return false },
        toggle() { settings.enabled = !settings.enabled; saveSettings(); return settings.enabled },
        get enabled() { return settings.enabled },
        get volume() { return settings.volume },
        setVolume(value) {
          const v = Number(value)
          if (!Number.isFinite(v)) return settings.volume
          settings.volume = Math.min(1, Math.max(0, v))
          saveSettings()
          if (master !== null && audio !== null) master.gain.setValueAtTime(settings.volume, audio.currentTime)
          return settings.volume
        },
        state() {
          return {
            version: VERSION,
            enabled: settings.enabled,
            volume: settings.volume,
            audio: audio === null ? 'not-created' : audio.state,
            mountedAt: diag.mountedAt,
            watched: [...watched],
            sessions: previous.size,
            done: diag.done,
            confirm: diag.confirm,
            lastPath: diag.lastPath,
            lastError: diag.lastError,
          }
        },
        diag() { publishDiag(); return diag },
        /** 供离线测试/预览使用：返回渲染好的 PCM 采样 */
        samples(kind) { return renderSamples(kind) },
        /** 供离线测试/预览使用：返回 16bit PCM WAV 字节 */
        wav(kind) {
          const samples = renderSamples(kind)
          return samples === null ? null : encodeWav(samples)
        },
      }
      try {
        window.dshSoundAlert = api
      } catch (err) {
        /* 忽略 */
      }
      return api
    }

    function apply(ctx) {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || sessions === null || sessions.list === undefined) return

      installApi()

      // 自检痕迹：证明客户端半区确实在页面里跑起来了
      try {
        localStorage.setItem(BOOT_KEY, JSON.stringify({ version: VERSION, at: new Date().toISOString(), href: location.href }))
      } catch (err) {
        /* 忽略 */
      }
      publishDiag()

      let statusStore = null
      let unsubscribeStatus = null

      const refresh = () => {
        try {
          evaluate(sessions, statusStore)
        } catch (err) {
          diag.lastError = `evaluate: ${String((err && err.message) || err)}`
          publishDiag()
        }
      }

      ctx.effect(() => {
        const unsubscribeList = sessions.list.subscribe(refresh)
        // 诊断心跳：每 5 秒把页面内的真实状态写到 localStorage，
        // 这样出问题时不必打开 DevTools 也能看到「插件是否活着、看到了什么」。
        const heartbeat = setInterval(() => {
          diag.sessions = previous.size
          publishDiag()
        }, 5000)

        // 待确认信号来自 ui-session 的 sessionStatus（官方审批面板 / 提问卡片会往这里发布）。
        // 用 ctx.inject 等它就绪：拿不到也不影响「完成音」。
        const releaseInject = typeof ctx.inject === 'function'
          ? ctx.inject(['uiSession'], (scoped) => {
              scoped.effect(() => {
                try {
                  const service = scoped.uiSession
                  statusStore = service !== undefined && service !== null && service.sessionStatus !== undefined
                    ? service.sessionStatus
                    : null
                } catch (err) {
                  statusStore = null
                }
                diag.statusAttached = statusStore !== null
                if (statusStore !== null && typeof statusStore.subscribe === 'function') {
                  unsubscribeStatus = statusStore.subscribe(refresh)
                }
                refresh()
                return () => {
                  if (typeof unsubscribeStatus === 'function') {
                    try { unsubscribeStatus() } catch (err) { /* 忽略 */ }
                  }
                  unsubscribeStatus = null
                  statusStore = null
                  diag.statusAttached = false
                }
              }, 'dsh-sound-alert: 待确认交互')
            })
          : undefined

        refresh()
        return () => {
          clearInterval(heartbeat)
          try { unsubscribeList() } catch (err) { /* 忽略 */ }
          if (typeof releaseInject === 'function') {
            try { releaseInject() } catch (err) { /* 忽略 */ }
          }
          diag.unloadedAt = new Date().toISOString()
          publishDiag()
        }
      }, 'dsh-sound-alert: 会话状态订阅')

      return undefined
    }

    module.exports.inject = ['sessions']
    module.exports.apply = apply
    return module.exports
  },
})
