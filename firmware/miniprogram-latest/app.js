const services = require('./services/index')
const env = require('./config/env')
const { createWxBleBridge } = require('./services/real/ble-bridge')

App({
  globalData: {
    brand: '好眠 SnoozMate',
    services,
  },

  onLaunch() {
    if (services.serviceMode === 'real' && services.configureDeviceBridge) {
      const bridge = createWxBleBridge(env.ble)
      if (typeof bridge.initialize === 'function') bridge.initialize()
      services.configureDeviceBridge(bridge)
    }
    if (env.transport !== 'public' && services.initializeCloudContainer) {
      try {
        this.globalData.cloudContainer = services.initializeCloudContainer()
      } catch (error) {
        this.globalData.cloudContainerError = error.code || 'CLOUD_NOT_CONFIGURED'
      }
    }
    const profile = wx.getStorageSync('haomian-profile')
    if (profile) {
      this.globalData.profile = profile
    }
  },

  onShow() {
    if (services.serviceMode !== 'real' || !services.device || !services.device.autoConnect) return
    this.globalData.bleAutoConnect = 'connecting'
    services.device.autoConnect({ timeout: 4000 })
      .then((result) => {
        this.globalData.bleAutoConnect = result.connected ? 'connected' : 'idle'
        this.globalData.bleAutoConnectError = ''
      })
      .catch((error) => {
        this.globalData.bleAutoConnect = 'idle'
        this.globalData.bleAutoConnectError = error.code || 'CONNECT_FAILED'
      })
  },
})
