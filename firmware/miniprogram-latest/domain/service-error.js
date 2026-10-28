const errorDefinitions = {
  DEVICE_STOPPED: {
    title: '设备已停止', detail: '连接蓝牙并明确恢复手动控制后，才能重新开启输出。', retryable: false, action: 'retry',
  },
  CONTROL_UNSUPPORTED: {
    title: '当前固件不支持此设置', detail: '请选择稳定灯光或整晚播放；自动干预尚未开放。', retryable: false, action: 'retry',
  },
  SCENE_NOT_AVAILABLE: {
    title: '设备缺少该音效', detail: '请先同步对应音效，再选择播放。', retryable: false, action: 'retry',
  },
  SAFETY_REJECTED: {
    title: '设备未接受控制', detail: '请读取停止状态并核对设备后再操作。', retryable: false, action: 'retry',
  },
  STOP_UNCONFIRMED: {
    title: '停止结果未确认', detail: '请长按实体按键 2 秒；若仍未停止，请断开设备电源。', retryable: false, action: 'retry',
  },
  DEVICE_OFFLINE: {
    title: '设备当前离线',
    detail: '请检查月石床头主机的电源与网络后重试。',
    retryable: true,
    action: 'retry',
  },
  NOT_PROVISIONED: {
    title: '设备尚未完成配网',
    detail: '请先完成月石床头主机配网，再重试当前操作。',
    retryable: false,
    action: 'setup',
  },
  AUTH_EXPIRED: {
    title: '登录状态已过期',
    detail: '请重新登录后继续。',
    retryable: false,
    action: 'reauth',
  },
  SYNC_TIMEOUT: {
    title: '同步超时',
    detail: '结果尚未确认，请读取设备状态后再操作。',
    retryable: true,
    action: 'retry',
  },
  READBACK_MISMATCH: {
    title: '设备回读与设置不一致',
    detail: '设备状态与目标不同，请先核对设备，勿将发送成功视为已执行。',
    retryable: true,
    action: 'retry',
  },
  NETWORK_ERROR: {
    title: '网络连接未完成',
    detail: '请检查网络后重试。请求已停止，不会在后台继续等待。',
    retryable: true,
    action: 'retry',
  },
  HTTP_5XX: {
    title: '云端服务暂时繁忙',
    detail: '云端结果尚未确认；可通过蓝牙读取设备状态。',
    retryable: true,
    action: 'retry',
  },
  AI_CONSENT_REQUIRED: {
    title: '需要 AI 数据授权',
    detail: '请先在 AI 页面或“我的”中允许 AI 使用结构化睡眠资料。',
    retryable: false,
    action: 'retry',
  },
  NOT_CONFIGURED: {
    title: '生产服务尚未配置',
    detail: '真实硬件与云端适配器尚未接通，当前功能不可用。',
    retryable: false,
    action: 'retry',
  },
  CLOUD_NOT_CONFIGURED: {
    title: '微信云调用尚未配置',
    detail: '请确认小程序已初始化正确的云环境，并配置 snoozmate-api 服务名。',
    retryable: false,
    action: 'retry',
  },
  BLUETOOTH_DISABLED: {
    title: '手机蓝牙未开启',
    detail: '请开启蓝牙并允许小程序使用附近设备权限。',
    retryable: true,
    action: 'retry',
  },
  BLUETOOTH_UNAVAILABLE: {
    title: '当前环境不支持蓝牙',
    detail: '请使用微信真机并升级微信版本，开发者工具模拟器不能扫描真实 BLE 设备。',
    retryable: false,
    action: 'retry',
  },
  BLUETOOTH_PERMISSION_DENIED: {
    title: '缺少蓝牙扫描权限',
    detail: '请在微信的小程序设置中允许蓝牙和位置信息权限。',
    retryable: true,
    action: 'retry',
  },
  LOCATION_DISABLED: {
    title: '手机定位服务未开启',
    detail: '部分安卓手机需要同时开启系统定位服务才能扫描 BLE 设备。',
    retryable: true,
    action: 'retry',
  },
  CONNECT_FAILED: {
    title: '蓝牙连接失败',
    detail: '请靠近月石设备，确认设备已通电后重新连接。',
    retryable: true,
    action: 'retry',
  },
  NOT_FOUND: {
    title: '附近未找到设备',
    detail: '请靠近月石主机，并重新完成蓝牙搜索。',
    retryable: true,
    action: 'setup',
  },
  CONNECTION_LOST: {
    title: '蓝牙连接已断开',
    detail: '请靠近月石主机后重试。',
    retryable: true,
    action: 'retry',
  },
  WIFI_PROVISION_UNSUPPORTED: {
    title: '设备固件需要升级',
    detail: '当前硬件没有 BLE_PROTOCOL v1.1 的安全 Wi-Fi 配网能力。',
    retryable: false,
    action: 'retry',
  },
  WIFI_BLE_SECURITY_REQUIRED: {
    title: '需要建立安全蓝牙连接',
    detail: '请接受手机系统的蓝牙配对提示，然后重新发送 Wi-Fi 配置。',
    retryable: true,
    action: 'retry',
  },
  WIFI_SCAN_FAILED: {
    title: 'Wi-Fi 扫描失败',
    detail: '请将月石靠近 2.4GHz 路由器后重新扫描。',
    retryable: true,
    action: 'retry',
  },
  WIFI_DISABLED: {
    title: '手机 Wi-Fi 未开启',
    detail: '请打开手机 Wi-Fi 和位置信息权限后重新扫描。',
    retryable: true,
    action: 'retry',
  },
  WIFI_SCAN_UNAVAILABLE: {
    title: '当前环境不支持 Wi-Fi 扫描',
    detail: '请使用微信真机并升级微信版本后重试。',
    retryable: false,
    action: 'retry',
  },
  WIFI_SCAN_TIMEOUT: {
    title: 'Wi-Fi 扫描超时',
    detail: '请确认手机 Wi-Fi、定位开关和小程序权限均已开启。',
    retryable: true,
    action: 'retry',
  },
  WIFI_AUTH_FAILED: {
    title: 'Wi-Fi 密码错误',
    detail: '请重新输入网络密码。原有可用网络配置没有被覆盖。',
    retryable: true,
    action: 'retry',
  },
  WIFI_NOT_FOUND: {
    title: '设备找不到该网络',
    detail: '请确认路由器已开启 2.4GHz Wi-Fi，且设备位于覆盖范围内。',
    retryable: true,
    action: 'retry',
  },
  WIFI_CONNECT_FAILED: {
    title: '设备联网失败',
    detail: '请检查网络名称、密码和路由器状态后重试。',
    retryable: true,
    action: 'retry',
  },
  BLE_RESPONSE_TIMEOUT: {
    title: '设备应答超时',
    detail: '指令没有得到设备确认，请靠近主机后重试。',
    retryable: true,
    action: 'retry',
  },
  SFX_PLAY_FAILED: {
    title: '设备音效不可用',
    detail: '设备没有对应音效，请先同步音效或播放内置测试音。',
    retryable: true,
    action: 'retry',
  },
  AUDIO_TEST_FAILED: {
    title: '设备无法播放声音',
    detail: '请检查扬声器、外部 Flash 与固件音效模块。',
    retryable: true,
    action: 'retry',
  },
  INVALID_AUDIO_DATA: {
    title: '音效文件不可用',
    detail: '请选择有效的 PCM 或 Float WAV 文件。',
    retryable: false,
    action: 'retry',
  },
  SFX_TRANSFER_FAILED: {
    title: '音效传输中断',
    detail: '请保持手机靠近设备并重新同步。',
    retryable: true,
    action: 'retry',
  },
  SFX_FILE_REJECTED: {
    title: '设备未接受音效',
    detail: '文件完整性校验未通过，请重新选择 WAV 后同步。',
    retryable: true,
    action: 'retry',
  },
}

function readCode(error) {
  const stableCode = error && typeof error.code === 'string' ? error.code : ''
  if (errorDefinitions[stableCode]) return stableCode

  const legacyMessage = error && typeof error.message === 'string' ? error.message : ''
  const match = legacyMessage.match(/^(DEVICE_OFFLINE|NOT_PROVISIONED|AUTH_EXPIRED|SYNC_TIMEOUT|READBACK_MISMATCH|NOT_CONFIGURED|CLOUD_NOT_CONFIGURED|NETWORK_ERROR|HTTP_5XX|AI_CONSENT_REQUIRED|BLUETOOTH_UNAVAILABLE|BLUETOOTH_DISABLED|BLUETOOTH_PERMISSION_DENIED|LOCATION_DISABLED|CONNECT_FAILED|NOT_FOUND|CONNECTION_LOST|WIFI_PROVISION_UNSUPPORTED|WIFI_BLE_SECURITY_REQUIRED|WIFI_SCAN_FAILED|WIFI_DISABLED|WIFI_SCAN_UNAVAILABLE|WIFI_SCAN_TIMEOUT|WIFI_AUTH_FAILED|WIFI_NOT_FOUND|WIFI_CONNECT_FAILED|BLE_RESPONSE_TIMEOUT|SFX_PLAY_FAILED|AUDIO_TEST_FAILED|INVALID_AUDIO_DATA|SFX_TRANSFER_FAILED|SFX_FILE_REJECTED)(?::|\b)/)
  return match ? match[1] : 'UNKNOWN'
}

function toUserError(error, context = '当前内容') {
  const code = readCode(error)
  const definition = errorDefinitions[code]
  if (definition) return { code, ...definition }

  return {
    code: 'UNKNOWN',
    title: `${context}暂时不可用`,
    detail: '请稍后重试。如果问题持续，请联系客服。',
    retryable: true,
    action: 'retry',
  }
}

function runServiceErrorAction(action, retry, platform = typeof wx === 'undefined' ? null : wx) {
  if (action === 'reauth' && platform) return platform.reLaunch({ url: '/pages/onboarding/index?reauth=1' })
  if (action === 'setup' && platform) return platform.navigateTo({ url: '/pages/setup/index' })
  if (action === 'retry' && typeof retry === 'function') return retry()
  return undefined
}

module.exports = { runServiceErrorAction, toUserError }
