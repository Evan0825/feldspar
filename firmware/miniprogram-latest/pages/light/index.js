const services = require('../../services/index')
const { runServiceErrorAction, toUserError } = require('../../domain/service-error')
const PULSE_READBACK_DELAY = 5500

Page({
  data: { light: null, brightnessDraft: 5, status: null, cloudControl: false, controlAvailable: false, controlError: null, loading: true, loadError: null, actionError: null, phase: 'loading', syncing: false },
  onLoad() { return this.load() },
  onUnload() { this.cancelPulseRefresh() },
  async load() {
    const refreshId = this.cancelPulseRefresh()
    this.setData({ loading: true, loadError: null, actionError: null, phase: 'loading' })
    try {
      const [light, status] = await Promise.all([services.device.getLightState(), services.device.getStatus()])
      const cloudControl = light?.source === 'cloud-driver'
      const controlAvailable = Boolean(cloudControl ? status?.cloudLightAvailable : (status?.bleManualControlAvailable || status?.controlAvailable))
      const controlError = controlAvailable ? null : toUserError({ code: status && status.provisioned ? 'DEVICE_OFFLINE' : 'NOT_PROVISIONED' }, '夜灯')
      this.setData({ light, brightnessDraft: light ? light.brightness : 5, status, cloudControl, controlAvailable, controlError, phase: light ? 'data' : 'empty' })
      if (refreshId === this._pulseRefreshId) this.schedulePulseRefresh(light)
    } catch (error) {
      this.setData({ light: null, loadError: toUserError(error, '夜灯'), phase: 'error' })
    } finally {
      this.setData({ loading: false })
    }
  },
  retry() { return this.load() },
  handleServiceAction(event) { return runServiceErrorAction(event.detail.action, () => this.retry(), wx) },
  handleActionError(event) { return runServiceErrorAction(event.detail.action, () => this.retryAction(), wx) },
  async send(command) {
    if (this.data.syncing || !this.data.controlAvailable) return
    const refreshId = this.cancelPulseRefresh()
    const startedAt = Date.now()
    this._retryAction = () => this.send(command)
    this.setData({ syncing: true, actionError: null })
    try {
      const mode = command.mode || this.data.light.mode
      const light = await services.device.updateLight({ ...command, color: mode === 'night-low' && !this.data.cloudControl ? 'white' : 'amber' })
      this.setData({ light, brightnessDraft: light.brightness })
      this._retryAction = null
    }
    catch (error) {
      const userError = toUserError(error, '夜灯')
      this.setData({ brightnessDraft: this.data.light.brightness, actionError: userError })

    }
    finally {
      this.setData({ syncing: false })
      if (refreshId === this._pulseRefreshId) {
        this.schedulePulseRefresh(this.data.light, Math.max(0, PULSE_READBACK_DELAY - (Date.now() - startedAt)))
      }
    }
  },
  cancelPulseRefresh() {
    clearTimeout(this._pulseRefresh)
    this._pulseRefreshId = (this._pulseRefreshId || 0) + 1
    return this._pulseRefreshId
  },
  schedulePulseRefresh(light, delay = PULSE_READBACK_DELAY, retry = true) {
    const id = this.cancelPulseRefresh()
    if (!light?.confirmed || !light.enabled || light.mode !== 'bedtime-breathe') return
    this._pulseRefresh = setTimeout(async () => {
      const current = await services.device.getLightState().catch(() => null)
      if (id !== this._pulseRefreshId || !current?.confirmed) return
      this.setData({ light: current, brightnessDraft: current.brightness })
      if (retry) this.schedulePulseRefresh(current, 1500, false)
    }, delay)
  },
  toggle() { this.send({ enabled: !this.data.light.enabled }) },
  setMode(event) { return this.send({ mode: event.currentTarget.dataset.mode, enabled: true }) },
  previewBrightness(event) { this.setData({ brightnessDraft: event.detail.value }) },
  setBrightness(event) { return this.send({ brightness: event.detail.value }) },
  retryAction() {
    if (!this.data.actionError || !this.data.actionError.retryable || !this._retryAction) return
    return this._retryAction()
  },
})
