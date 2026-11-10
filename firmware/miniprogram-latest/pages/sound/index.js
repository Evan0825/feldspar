const services = require('../../services/index')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')

const previewTracks = {
  sleep: '/audio/sleep.mp3',
  healing: '/audio/healing.mp3',
  work: '/audio/work.mp3',
  reading: '/audio/reading.mp3',
}

Page({
  data: { sound: null, volumeDraft: 0, status: null, controlAvailable: false, controlError: null, loading: true, loadError: null, actionError: null, phase: 'loading', syncing: false, previewPlaying: false, previewError: '', uploading: false, uploadProgress: 0, manualStopOnly: false, timerUnavailableText: '', timerLabel: '', canUpload: false, sceneIcons: { sleep: 'sleep', healing: 'healing', work: 'work', reading: 'reading' }, timers: [15, 30, 60, 'all-night'] },
  onLoad() {
    // 订阅设备 BLE 主动上报：曲目自然播完/设备端切换时同步播放态
    if (services.device && typeof services.device.onDeviceEvent === 'function') {
      this._offDeviceEvent = services.device.onDeviceEvent((event) => {
        const message = event && event.message
        if (!message || message.channel !== 'data' || !this.data.sound) return
        if (message.type === 'SFXSTART') {
          if (this.data.controlAvailable && !this.data.sound.playing) {
            this.setData({ sound: { ...this.data.sound, playing: true } })
          }
        } else if (message.type === 'SFXDONE' || message.type === 'SFXERR') {
          if (this.data.controlAvailable && this.data.sound.playing) {
            this.stopCountdown()
            this.setData({ sound: { ...this.data.sound, playing: false, timerRemainingSeconds: 0 }, timerLabel: '' })
          }
        }
      })
    }
    return this.load()
  },
  onUnload() {
    this._hidden = true
    if (typeof this._offDeviceEvent === 'function') {
      this._offDeviceEvent()
      this._offDeviceEvent = null
    }
    this.stopCountdown()
    if (this._previewFadeTimer) clearTimeout(this._previewFadeTimer)
    if (this._previewAudio) this._previewAudio.destroy()
    this._previewAudio = null
  },
  onShow() {
    if (this._hidden) { this._hidden = false; return this.load() }
  },
  onHide() {
    this._hidden = true
    this.stopCountdown()
    if (this._previewAudio && this.data.previewPlaying) this._previewAudio.pause()
  },
  async load() {
    this.stopCountdown()
    this.setData({ loading: true, loadError: null, actionError: null, phase: 'loading' })
    try {
      const [sound, status] = await Promise.all([services.device.getSoundState(), services.device.getStatus()])
      const controlAvailable = Boolean(sound?.source === 'cloud-driver' ? status?.cloudSoundAvailable : (status?.bleManualControlAvailable || status?.controlAvailable))
      const controlError = controlAvailable ? null : toUserError({ code: status?.safety?.stopLatched ? 'DEVICE_STOPPED' : status?.provisioned ? 'DEVICE_OFFLINE' : 'NOT_PROVISIONED' }, '声音')
      const manualStopOnly = (services.serviceMode === 'real' || sound?.source === 'ble-driver') && !sound?.timerSupported
      const timerUnavailableText = status?.ble?.connected ? '需更新设备固件' : '连接蓝牙后检查支持情况'
      const canUpload = controlAvailable && status?.ble?.connected === true && typeof services.device.uploadSoundEffect === 'function'
      const volumeDraft = sound && !sound.playing && !sound.paused && sound.volume === 0
        ? sound.preferredVolume ?? 0 : sound?.volume ?? 0
      this.setData({ sound, volumeDraft, status, controlAvailable, controlError, manualStopOnly, timerUnavailableText, canUpload, phase: sound ? 'data' : 'empty' })
      if (sound) { this.preparePreviewSource(sound); this.startCountdown(sound, controlAvailable) }
    } catch (error) {
      this.setData({ sound: null, loadError: toUserError(error, '声音'), phase: 'error' })
    } finally {
      this.setData({ loading: false })
    }
  },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  handleActionError(event) { return runServiceErrorAction(event.detail.action, () => this.retryAction(), wx) },
  async send(command) {
    if (this.data.syncing || !this.data.controlAvailable) return
    const previousSound = this.data.sound
    this._retryAction = () => this.send(command)
    this.setData({ syncing: true, actionError: null })
    try {
      const sound = await services.device.updateSound(command)
      this.setData({ sound, volumeDraft: sound.volume })
      this.preparePreviewSource(sound)
      this.startCountdown(sound, this.data.controlAvailable)
      this._retryAction = null
    }
    catch (error) {
      const userError = toUserError(error, '声音')
      this.setData({ sound: previousSound, volumeDraft: previousSound.volume, actionError: userError })
      this.preparePreviewSource(previousSound)

    }
    finally { this.setData({ syncing: false }) }
  },
  selectScene(event) {
    const command = { scene: event.currentTarget.dataset.scene }
    if (this.data.controlAvailable) return this.send(command)
    const sound = applySoundCommand(this.data.sound, command)
    this.setData({ sound })
    this.preparePreviewSource(sound)
  },
  togglePlayback() {
    if (this.data.controlAvailable && this.data.sound) {
      const { playing, timerSupported, timer } = this.data.sound
      return this.send(playing ? { playing: false } : { playing: true, ...(timerSupported ? { timer } : {}) })
    }
    return this.togglePreview()
  },
  previewVolume(event) {
    const volumeDraft = event.detail.value
    this.setData({ volumeDraft })
    if (this._previewAudio) {
      this._previewAudio.volume = Math.max(0, Math.min(1, volumeDraft / 100))
    }
  },
  setVolume(event) {
    if (!this.data.controlAvailable) return this.previewVolume(event)
    return this.send({ volume: event.detail.value })
  },
  setTimer(event) {
    const timer = event.currentTarget.dataset.timer
    if (this.data.manualStopOnly && timer !== 'all-night') return
    return this.send({ timer })
  },
  stopCountdown() {
    clearTimeout(this._countdownTick)
    this._countdownTick = null
  },
  startCountdown(sound, available) {
    this.stopCountdown()
    if (!available || !sound.timerSupported || !(sound.playing || sound.paused) || !Number.isFinite(sound.timerRemainingSeconds) || this._hidden) {
      this.setData({ timerLabel: '' })
      return
    }
    const deadline = (sound.timerCheckedAt || Date.now()) + sound.timerRemainingSeconds * 1000
    const update = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      if (!seconds) {
        this.setData({ timerLabel: '正在确认停止' })
        this.retry()
        return
      }
      this.setData({ timerLabel: `剩余 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` })
      this._countdownTick = setTimeout(update, 1000)
    }
    if (sound.timerRemainingSeconds > 0 && deadline > Date.now()) update()
    else this.setData({ timerLabel: '' })
  },
  chooseAndUploadWav() {
    if (!this.data.canUpload || this.data.uploading || typeof wx.chooseMessageFile !== 'function') return
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['wav'],
      success: ({ tempFiles = [] }) => {
        const file = tempFiles[0]
        if (!file || !file.path) return
        const name = String(file.name || 'custom')
          .replace(/\.wav$/i, '')
          .replace(/[^0-9A-Za-z_-]/g, '_')
          .slice(0, 24) || 'custom'
        this.uploadWav(file.path, name)
      },
      fail: ({ errMsg }) => {
        if (!String(errMsg || '').toLowerCase().includes('cancel')) {
          this.setData({ previewError: '未能读取 WAV 文件，请从微信文件中重新选择。' })
        }
      },
    })
  },
  async uploadWav(filePath, name) {
    this.setData({ uploading: true, uploadProgress: 0, actionError: null, previewError: '' })
    try {
      const result = await services.device.uploadSoundEffect({
        filePath,
        name,
        onProgress: (uploadProgress) => this.setData({ uploadProgress }),
      })
      this.setData({ uploadProgress: 100 })
      wx.showToast({ title: `已同步 ${result.name}`, icon: 'success' })
    } catch (error) {
      const userError = toUserError(error, '音效同步')
      this.setData({ actionError: userError })

    } finally {
      this.setData({ uploading: false })
    }
  },
  preparePreviewSource(nextSound) {
    if (!nextSound || typeof wx.createInnerAudioContext !== 'function') return
    const audio = this.ensurePreviewAudio()
    const source = previewTracks[nextSound.scene] || previewTracks.sleep
    const volume = this.data.volumeDraft == null ? nextSound.volume : this.data.volumeDraft
    audio.volume = Math.max(0, Math.min(1, Number(volume) / 100))
    if (audio.src !== source) {
      const resume = this.data.previewPlaying
      audio.stop()
      this._previewResumeOnCanplay = resume
      audio.src = source
      if (resume) this.setData({ previewPlaying: false })
    }
  },
  togglePreview() {
    if (!this.data.sound) return
    const audio = this.ensurePreviewAudio()
    this._previewUserStarted = true
    this.setData({ previewError: '' })
    if (this.data.previewPlaying) {
      audio.pause()
      return
    }
    const source = previewTracks[this.data.sound.scene] || previewTracks.sleep
    audio.volume = Math.max(0, Math.min(1, Number(this.data.volumeDraft) / 100))
    if (audio.src !== source) {
      this._previewResumeOnCanplay = true
      audio.src = source
    } else {
      audio.play()
    }
  },
  ensurePreviewAudio() {
    if (this._previewAudio) return this._previewAudio
    const audio = wx.createInnerAudioContext()
    audio.autoplay = false
    audio.loop = true
    audio.obeyMuteSwitch = false
    // Bind once per context so source switches do not accumulate callbacks.
    if (typeof audio.onCanplay === 'function') audio.onCanplay(() => {
      if (this._previewResumeOnCanplay && this._previewUserStarted) {
        this._previewResumeOnCanplay = false
        audio.play()
      }
    })
    if (typeof audio.onPlay === 'function') audio.onPlay(() => this.setData({ previewPlaying: true, previewError: '' }))
    if (typeof audio.onPause === 'function') audio.onPause(() => this.setData({ previewPlaying: false }))
    if (typeof audio.onStop === 'function') audio.onStop(() => this.setData({ previewPlaying: false }))
    if (typeof audio.onEnded === 'function') audio.onEnded(() => this.setData({ previewPlaying: false }))
    if (typeof audio.onError === 'function') audio.onError(() => {
      this._previewResumeOnCanplay = false
      this.setData({ previewPlaying: false, previewError: '试听音频加载失败，请检查手机媒体权限后重试。' })
    })
    this._previewAudio = audio
    return audio
  },
  retryAction() {
    if (!this.data.actionError || !this.data.actionError.retryable || !this._retryAction) return
    return this._retryAction()
  },
})

function applySoundCommand(current, command) {
  if (!current) return current
  let next = { ...current }
  if (command.scene) {
    const scene = current.scenes.find((item) => item.id === command.scene)
    if (scene) next = { ...next, scene: scene.id, sceneName: scene.name, trackName: scene.trackName }
  }
  if (typeof command.playing === 'boolean') next.playing = command.playing
  if (command.volume !== undefined) next.volume = Math.max(0, Math.min(100, command.volume))
  if ([15, 30, 60, 'all-night'].includes(command.timer)) next.timer = command.timer
  return next
}
