# 原生页面文案核对证据

结果：passed（原生模拟器的文案、布局与所述 Mock 交互）。

微信开发者工具 Stable 2.02.2608060；iPhone 12/13 (Pro) 模拟器，390 CSS px 宽。PNG 裁自 2500 × 1782 原始实屏的手机区域（1684,252）至（2318,1510），移除 IDE 和系统状态栏，未重绘界面。

已逐页检查 21 个路由；首次登录、AI 方案无记录状态、趋势页底部与偏好保存回显另有补充截图。此前锁屏中断已在用户解锁后补完，不再有待补页面。

| 页面 | 实屏 |
| --- | --- |
| 个性化偏好 | [onboarding.png](onboarding.png) |
| 首页 | [home.png](home.png) |
| 温和方案 | [strategy.png](strategy.png) |
| 我的 | [profile.png](profile.png) |
| 睡眠 | [report.png](report.png) |
| 趋势与反馈 | [trends.png](trends.png) |
| AI 首页 | [ai.png](ai.png) |
| AI 详情 | [ai-detail.png](ai-detail.png) |
| AI 对话 | [ai-chat.png](ai-chat.png) |
| AI 方案 | [ai-plan.png](ai-plan.png) |
| AI 记录 | [ai-records.png](ai-records.png) |
| AI 记忆 | [ai-memory.png](ai-memory.png) |
| 配网 | [setup.png](setup.png) |
| 自检 | [calibration.png](calibration.png) |
| 首夜准备 | [readiness.png](readiness.png) |
| 设备 | [device.png](device.png) |
| 今晚设置 | [tonight.png](tonight.png) |
| 声音 | [sound.png](sound.png) |
| 夜灯 | [light.png](light.png) |
| 事件 | [events.png](events.png) |
| 实时状态 | [live.png](live.png) |

## 交互与渲染核对

- 从「我的」进入偏好，选中声音与灯光、保存返回、重新进入，两项回显勾选；单独取消声音并保存后，再次打开保持声音取消、灯光勾选。证据为 preferences-reloaded.png 与 preferences-unchecked-reloaded.png。
- 随后恢复两项勾选并保存，正常完整编译后重新进入仍保持勾选，见 preferences-recompiled.png；没有通过重置旧用户数据伪造默认值。新账号默认由前后端测试覆盖。
- 振动固定无取消控件；提醒方案的可选说明收于信息按钮；普通偏好入口没有高亮。方案详情的限制字段能显示「无」。
- AI 主标题精简后，记忆入口与输入框均完整可见；来源、日期、数据质量、摘录限制与授权后果保留。
- 趋势页提交反馈可以滚动至系统安全区上方，见 trends-bottom.png。没有提交虚构的晨间反馈或应用设备方案。
- 临时「文案检查」编译模式已移除，恢复普通编译。完整编译与最终偏好页显示 0 个调试错误；保留开发者工具的资源预加载、热重载和 worker 能力提示。

日志范围：native-node 为本地 21 路由演示项目；integration-host、backend、demo-features、backend-smoke 为 GitHub 19 路由集成项目。两版保留各自既有 AI 信息结构，本批实屏不代表集成版每个像素均相同。真实手机读屏、BLE、设备输出与生产云端未在此验收。
