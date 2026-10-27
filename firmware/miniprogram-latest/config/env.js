// SnoozMate 运行配置
// transport: cloud-container 生产只走 wx.cloud.callContainer（微信内网）。
// transport: cloud-container 可强制只走微信云调用；transport: public 仅用于外部调试。

module.exports = {
  // 演示模式（比赛/演示时开 true，开发联调时开 false）
  demoMode: true,
  
  // 服务模式
  serviceMode: 'mock',

  // 微信云托管内部调用配置。环境 ID 以 CloudBase 控制台实际值为准。
  transport: 'public',
  cloudEnvId: '',
  cloudServiceName: '',
  ble: {
    protocolVersion: '1.1',
    namePrefix: 'HAOMIAN-SLEEP_',
    serviceUuid: 'FF00',
    controlCharacteristicUuid: 'FF01',
    audioCharacteristicUuid: 'FF02',
    statusCharacteristicUuid: 'FF03',
    dataCharacteristicUuid: 'FF04',
    provisionCharacteristicUuid: 'FF05',
  },
  
  // 仅当 transport=public 或云调用在开发工具不可用时使用。
  apiBaseUrl: 'https://-307990-4-1480950331.sh.run.tcloudbase.com',
  
  // 仅供 demoMode=true 的 Mock 演示使用；真实模式不允许默认设备回退。
  defaultDeviceId: 'device_esp32_real_001',
}
