# 创新证据矩阵

本表用于申报和答辩。证据等级：A 为本候选可重复的电脑检查；B 为源码/接口事实；C 为待验收目标。A 不代表实机、临床或真实环境效果。

| 可写入材料的主张 | 源码与复现入口 | 证据等级 | 必须保留的边界 |
|---|---|---|---|
| 设备计算版本化声学特征，C 与 NumPy 数值对照 | firmware/components/acoustic_features/；backend/tests/test_feature_contract.py 的 test_c_frontend_matches_numpy_reference | A | 合成信号的数值一致性，不是鼾声准确率 |
| 特征上行包含质量、会话、时钟与连续性信息 | firmware/components/device_link/device_link.c；backend/app/audio/feature_contract.py | A/B | 新特征链默认关闭，需要独立 NVS 与 Broker |
| 只观察分级不启动执行器 | test_continuity_quality_duplicate_and_session_boundaries；test_mqtt_keeps_only_latest_window_without_fabricating_report_or_runtime | A | 工程规则未标定，automatic_allowed=false |
| 控制通过请求令牌与驱动回读确认 | tests/safety_bridge.test.cjs；tests/io_readback.test.cjs | A | wx 与 BLE 为替身，不含物理反馈 |
| 网络失败时保留已确认状态与待同步标记 | tests/device_status.test.cjs | A | 不保证真实断网恢复时序，需手机验收 |
| 全局停止锁定、限时和预算保护 | tests/actuation_guard_test.c；tests/haptic_adapter_test.c；tests/sfx_stop_test.c | A | 软件逻辑测试，不是温升/电流/物理停止测试 |
| 停止命令幂等且以 applied + 回读确认 | backend/tests/test_feature_contract.py 的 test_pending_global_stop_is_prioritized_retried_and_requires_readback 与 test_global_stop_endpoint_is_idempotent_and_write_authorized | A | 鉴权调用边界使用 mock，非正式微信或 Broker 验证 |
| 未知观测不伪装为正常/零值 | backend/tests/test_completion_regressions.py 的 UnknownObservationRegressions；tests/report_unknown.test.cjs | A | 不等于当前已具有雷达、体位或温度实测能力 |
| 真实设备整套协同、家庭效果、自动个性化提醒 | 等待样机/用户数据/模型评估与标定 | C | 不写成已实现或已有疗效 |

## 建议答辩表达

“我们当前交付的是一套可检查的睡眠辅助工程基线：特征如何产生、无效数据如何处理、命令是否真正得到驱动回读，都有源码和电脑复现。自动提醒仍关闭，下一步用样机和授权数据检验它在真实卧室中的价值。”

## 目前不要使用的表述

- “识别准确率 95%”“鼾声降低 X%”“改善睡眠 X%”：没有对应真实、独立评估数据。
- “已实现边缘 AI 个性化止鼾闭环”：候选未接入 v5 分类模型，自动动作关闭。
- “任何情况下都安全停止”：缺少物理反馈、温升、电流、阻塞与断电实测。
- “全产品不上传音频”：只可对指定结构化特征通路作此说明；旧后端保留音频支持。
- “已开源并形成社区”：本地候选尚未发布，社区指标未建立。

## 后续对照实验方案（尚未执行）

先以授权来源的受试者/设备/夜晚分组建立独立留出集，避免同一人的相邻片段同时出现在训练与测试。保留环境噪声、语音、咳嗽、空调/风扇、音效与振动自噪负例，报告每类样本数、标签分歧、召回率、精确率、F1、每小时误报与混淆矩阵。

在同一目标板、采样率和输入上比较固定阈值基线、当前规则及未来模型，记录推理耗时、内存、丢帧和功耗。没有这组实验前不宣称技术领先。物理输出、伴侣感受及长期效果需要独立验证方案，不能以软件单元测试替代。
