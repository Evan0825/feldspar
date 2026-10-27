# 本地候选接口补充：local-bcd-20261019

固件版本 `1.0.4-dev.1019`。仅描述本地源码；未烧录、未部署。自动干预关闭；本轮没有接入 v5 分类模型。

## 实体按键和输出停止

- 用户确认：短按切换灯光；持续按住 2 秒停止全部输出。20 ms 消抖，长按只触发一次，松手不补发短按。沿用接线文档 GPIO7 上拉/低有效，不再从启动电平猜极性，避免上电按住被误判为空闲。
- 启动时马达/音频/灯光默认关闭，灯带仅保留颜色，不在安全状态初始化前闪亮。
- 全局停止依次先静音、关闭马达驱动、取消自动/排队音效、停止音频、关闭灯光，保存停止锁定。恢复手动控制不启动或恢复任何输出。
- 停止锁定期间，短按不能重新开灯，BLE 正向启动被拒绝；连接蓝牙明确恢复后才能开启。首次安装或停止记录不可用时也锁定。
- 手动马达独立 20 ms 软件定时检查、工程时长上限 10 秒；连续调节不续期，到期需明确恢复。此上限沿用协议工程限制，不是已标定的物理安全参数，也不是硬件看门狗保证。
- 自动执行器核心具有强度/时长/冷却/次数、命令去重、预算先落盘等约束；实际适配器关闭自动动作、预算为 0、profile 未验证。不能仅修改开关就作为产品放行。
- 没有温度/电流/实际振动反馈；所有“确认”均为驱动及软件状态，不表示独立测量了物理输出。

## BLE 候选扩展

仍使用 FF00，控制 FF01、数据通知 FF04；没有 FF05。请求载荷 `[cmd, request_id低字节, request_id高字节]`。令牌为非零 u16，每个连接顺序递增；超时 3 秒。仅接受当前令牌的回读，忽略迟到报文。

| 命令 | 动作 | FF04 回读 |
|---|---|---|
| `0x24` | 查询马达/停止锁定 | `SAFETY,id,ok,HAPTIC,result,active,pct,remaining_ms,latched` |
| `0x25` | 明确恢复手动控制，不启动输出 | 同上；必须 `active=0,latched=0` |
| `0x26` | 全局停止并锁定 | 同上；必须 `active=0,latched=1` 且总体结果 `ok` |
| `0x27` | 灯光/声音驱动回读 | `IO,id,enabled,r,g,b,volume,audio_state,sfx_index` |

`active/latched/enabled` 是 0/1；`pct/r/g/b/volume` 范围 0–100；音频状态 0 停止、1 播放、2 暂停。`sfx_index` 为设备文件索引。`remaining_ms` 最大 10000，非活动时为 0。失败时 `SAFETY,id,error,...`。驱动 result 为 ok/invalid/disabled/unsafe/expired/busy/duplicate/cooldown/budget/storage/stopped/unavailable。

实体停止另发 `CONTROL,STOP,ok|error` 与无令牌 `HAPTIC,...`，不得拿这些旧/主动通知完成新的令牌请求。

小程序：灯光写入后验证实际 RGB/开关；声音写入后验证音量、播放态和文件索引。稳定灯光与整晚播放可用；呼吸模式、定时播放及缺少对应文件均明确拒绝。设备确认后云端保存失败，保留回读并显示“云端待同步”，不自动重发输出。云端偏好没有设备回读时标 `confirmed=false`。

OTA 开始前停止全部输出并锁定；OTA 期间仍可全局停止，禁止恢复/启动马达。有效构建配置开启回滚；CRC/SHA 校验不能代替签名，升级中断、失败启动和回滚尚需实测。

## 版本化特征

默认 `CONFIG_FELDSPAR_FEATURE_LINK=n`。开启需要测试设备独立配置；代码仅读取 NVS `device_link` 的 `device_id`、`device_key`、`broker_uri`，没有自动配置或轮换凭据。ID 限 ASCII 字母数字/下划线/连字符、最多 64；broker 必须 mqtts 且 URI 不包含用户信息，CA 必须匹配。缺少配置不退回共享身份，保留本地手动通路。开启结构化模式时禁用旧心跳；关闭时保留原工程行为，历史共享凭据仍需正式交付前单独治理。本次未连接原生产 Broker。

固定主题前缀 `snoozmate/v1/devices/{device_id}`，测试后端必须匹配：

- `features/up`：1 秒、16 kHz、16000 个 PCM16 样本的结构化特征，无音频字节。
- `telemetry/up`：驱动/能力/传感未知态；不冒充物理反馈。无特征时约 5 秒发送。
- `commands/down`：设备专属命令；拒绝 retained、错主题、超长、断续/乱序分片及带 NUL 报文。上限 1024 字节。
- `acks/up`：命令 ID、结果、错误与实际驱动回读；停止优先于其他待处理命令。

特征协议 `feldspar-features-v1`：`device_id, session_id, sequence, timestamp_ms, monotonic_end_ms, clock_valid, sample_rate=16000, sample_count=16000, window_ms=1000, context_blocks, quality_flags, rms, clipped_ratio, band_ratio, volume_ratio, periodicity`。JSON 上限 2048 字节；不接受额外字段。SNTP 未同步/过旧则时间未知，不伪造 UTC。

DSP：去直流 RMS；512 点对称 Hann/256 hop 的平均功率 100–850 Hz 比例；20 ms 包络保留 6 秒，以第 20 百分位作为幅值背景；包络自相关 lag 20–100（0.5–2.5 Hz）。窗口结束时间按采样块尾部估算，精度和算力待目标板测量。

质量位：GAP=1、SELF_NOISE=2、CLIPPED=4、SILENT=8、WARMUP=16。前 5 窗热身；丢帧/读取失败、播放/马达及后续 2 秒余响、削波、静音会使上下文失效。2 秒是保守工程占位，仍需实测标定。采集回调仅无等待入队，队列满丢弃并计数，禁止等待网络。

后端 `POST /api/v1/device/{id}/features` 使用设备密钥；`GET .../features/latest` 使用用户设备访问权限。只保存每设备最新窗口，不生成晨报事件、不刷新执行器遥测。重复不刷新到达时间。30 个连续有效窗口可输出工程观察分级；规则为 `feature-rule-v1-unvalidated`，分值不是校准概率，`automatic_allowed=false`。

## 云端停止

`POST /api/v1/device/{id}/outputs/stop`：用户写权限，JSON `{ "request_id": "客户端本次操作唯一ID" }`。同一 ID 幂等。排队/投递不算执行；确认必须为 `applied` 且回读 `stop_latched=true, outputs_stopped=true, vibration_level=0`。小程序无 BLE 时可以发此请求并等待回读；超时不宣称停止。

MCU 支持 `stop_all` 和仅停止马达的 `stop_intervention`。其余设置返回 `NOT_IMPLEMENTED`，自动命令返回 `AUTOMATIC_DISABLED`。同一启动会话缓存上一条 ACK；跨启动自动动作仍关闭。全局停止允许未知时钟；已同步后按 `expires_at` 秒检查过期。所有开启类动作在未知时钟下拒绝。

## 下一步实机验证

确认 GPIO/料号/供电与现有单 I2S 麦克风版本一致，再由硬件负责人检查输出。目标编译、手机蓝牙、测试 Broker/MySQL、停止延迟/任务阻塞、PSRAM/CPU、8 小时观察和 OTA 回滚分别记录。未完成这些及数据评估前，保持观察和监督手动联调，不开放自动提醒。

晨报不再用事件间隔代替有效监测时长，不按提醒成功数估算翻身/鼾声停止，不补仰卧比例、92% 质量分或“平稳”结论。缺项保持 null/未评估，显式零值保留。无事件资料不生成展示记录。

代码预期硬件（不是本次实物核验结果）：

| 模块 | 代码接口 / GPIO | 尚缺 |
|---|---|---|
| ESP32-S3 | N8R8 配置、8 MB 内部 Flash、Octal PSRAM | 样机型号/版次和供电 |
| INMP441 单麦克风 | I2S1，BCLK15 / WS16 / DIN17，16 kHz | 实际数量/增益/声学安装与采样校准 |
| ERM 模块 | PWM SIG42，20 kHz，11 bit | 模块/驱动/马达料号、有效电平、电流/温升与停止实测 |
| 灯带 | RMT GPIO8，10 灯珠 | 料号、负载、电源与最大亮度实测 |
| 音频功放 | I2S0 BCLK21 / WS14 / DOUT13 | 实际功放/扬声器与声压 |
| 外置音效存储 | SPI CS9 / CLK10 / MOSI11 / MISO12 | 料号/容量、损坏与文件系统恢复 |
| 实体按键 | GPIO7，上拉、低有效 | 极性/消抖/长按与机械实物验证 |
| 雷达/温度/电流/连接检测 | 当前驱动未提供 | 实际是否安装、原理图/接口与反馈闭环 |

候选 BOM 中的双 PDM 麦克风、雷达或专用触觉驱动不能直接替代当前源码接线；需要硬件版次确认后再修改驱动。
