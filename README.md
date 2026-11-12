# 月石 Feldspar

月石由 ESP32-S3 床头主机、有线枕下振动片和微信小程序组成。床头主机采集环境声音，驱动夜灯和扬声器，控制枕下振动。小程序负责发现、绑定、配网、手动控制和记录展示。测试后端负责身份、设备状态、结构化声学特征和命令回执。

当前为工程联调候选，固件源码版本为 `1.0.4-dev.1109.1`。自动提醒关闭。首轮验收目标是让同一台样机完成手机发现、绑定、配网、手动输出与全停，并让每个结果对应设备回读和实物现象。真实夜间事件、晨报、长期运行和 OTA 回滚还需单独验证。

复现 V4 工程样机请从 [V4 开源资料](hardware/v4/README.md) 开始。发布版本同时提供可编辑 CAD、8 个打印件、接线、选型和装配资料，以及配套的固件、原生小程序和后端。

## 代码基线与取舍

V4 发布随附的软件工程来自公开联调基线 `b0b571b`，包含设备固件、原生小程序、测试后端和对应的离线回归检查。版本号 `V4` 指外壳与机械装配版本。

| 目录或来源 | 工程选择 | 理由 |
| --- | --- | --- |
| [`firmware/`](firmware/CMakeLists.txt) | 设备端基线 | 保留现有 GPIO、BLE 协议、实体按键、输出停止锁定、I²S 采集和外置 Flash 接口。优先确认样机与该版接线、内存和镜像是否一致 |
| [`firmware/miniprogram-latest/`](firmware/miniprogram-latest/project.config.json) | 唯一真机联调小程序入口 | 有微信原生 BLE 桥接、真机服务适配和回读逻辑。仓库默认以 Mock 启动，开发时再配置真实测试环境 |
| [`backend/`](backend/main.py) | 使用同仓库版本 | 与小程序和设备联调合同对应。离线用 SQLite，真实身份与 MQTT 在独立测试环境验证 |
| [`tests/`](tests/run_checks.py)、[`scripts/`](scripts/demo_features.py) | 保留为回归入口 | 主机检查、模拟 wx、合成声学特征及 API 检查可以在设备到手前执行 |
| 其他本地工程和历史包 | 参考或按需移植 | `好眠` 工作区的 `integration/feldspar-v1` 用于对照历史工程，根目录 `wechat-miniprogram/` 的真实适配仍是占位。优先逐项移植可验证差异，避免整目录覆盖联调版。React 原型、旧后端包、训练参考和历史安装包不进入联调运行路径 |

同本地历史工程对照后，选用本仓库已移除共享账号的 MQTT/OTA 配置及音效 C11 兼容修复。小程序试听使用仓库内生成的低音量粉红噪声夹具。任何接线或协议变更须同时核对固件、BLE 适配和对应回归。

## 样机硬件选型

下表把上传照片和视频能确认的部件与补购规格分开。GPIO 表示固件预期，台架上用丝印、导通和电平实测确认。备件按每套各一件估算，现装件核验通过即可复用。

| 功能 | 样机证据 | 补购或复用条件 | 固件接口 |
| --- | --- | --- | --- |
| 主控、BLE、Wi-Fi | 视频可读 `ESP32-S3`，开发板版次及内存后缀待查 | `ESP32-S3-DevKitC-1-N8R8` 或同模组且引脚齐全的开发板。板载 Flash 8 MB，Octal PSRAM 8 MB，预留 GPIO42 和 USB 日志口 | 2.4 GHz Wi-Fi、BLE，串口 `115200` |
| 环境声音采集 | 圆形 I²S 模块，近场人声粗测观察到电平变化，INMP441 料号待查 | 单颗 `INMP441` I²S 数字麦克风，3.3 V，选左声道 | I²S1 `BCLK=15 / WS=16 / SD=17`，`L/R→GND`，16 kHz |
| 音效存储 | 板上可读 `W25QXX`，实测 JEDEC `0xEF4017`、8 MB，封装子型号待查 | `W25Q64JV` 3.3 V SPI NOR 模块，64 Mbit（8 MB），独立于主控 Flash | `CS=9 / CLK=10 / MOSI=11 / MISO=12`，预期 JEDEC `0xEF4017`，FATFS |
| 助眠声和音量 | 照片 1 可读 `MAX98357A`，扬声器铭牌待查 | `MAX98357A` I²S 单声道功放，台架备件可选 8 Ω / 3 W 扬声器。功放 `VIN=5 V`，扬声器两端接 `OUT+ / OUT−` | I²S0 `BCLK=21 / LRC=14 / DIN=13` |
| 夜灯 | 视频可读可编程 RGB LED，灯珠型号、数量和 DIN 方向待查 | `WS2812B` 5 V 单线 RGB、10 珠、GRB。必要时用 `74AHCT` 单向电平转换 | `DIN=GPIO8`，RMT |
| 枕下手动振动 | 现装样机确认一次振动并停止，马达、驱动和针序待核验 | ERM 偏心马达与匹配驱动。驱动接受 3.3 V、20 kHz、高有效 PWM，0% 和上电空闲均停转。按马达额定电压和起动电流选驱动与电源 | `SIG=GPIO42`，BLE `0x02` 调强度、`0x03` 停止 |
| 实体按键 | 视频可辨 DFRobot 三线白色按键模块，型号及极性待查 | 常开瞬时按键，或 3.3 V 供电、按下拉低的模块 | `GPIO7` 内部上拉。短按松手切灯，长按 2 秒全停并锁定 |
| 供电和调试 | 照片 4 可见 DC 插座、开关和 USB-A，板卡输入规格待测 | 台架使用可限流的稳压 5 V 电源，2 A 起步，按峰值电流和压降复核。备 USB 数据线和标识线束 | 各模块共地。灯带和功放用 5 V，麦克风、Flash 和按键用 3.3 V，马达按铭牌。主控供电入口按开发板说明选用 |

台架开工先确认现装板型、马达针序、地线连续性、静态电压、上电默认关闭和启动日志。测振动时先观察空载 PWM，再接匹配负载测低档、峰值电流、温升和物理停止时间。软件 10 秒限时为工程约束，物理输出另行记录。[接线与物料边界](docs/HARDWARE.md) [乐鑫开发板规格](https://docs.espressif.com/projects/esp-idf/en/v5.0/esp32s3/hw-reference/esp32s3/user-guide-devkitc-1-v1.0.html) [ADI 功放规格](https://www.analog.com/en/products/max98357a.html)

样机启动时识别到 16 MB 内置 Flash（镜像按 8 MB 使用）、8 MB PSRAM 和 8 MB 外置音效 Flash。该板使用 GPIO7 按下高电平的候选构建，启动回读为空闲低。实体短按和长按全停按台架实际动作验收。[样机联调记录](validation/20261107-hardware-bringup/README.md)

## 环境准备与离线复现

需要 Git、Python 3.12、Node.js 20+、Clang。固件构建需要 ESP-IDF 5.4.1，小程序需要微信开发者工具。以下命令在 macOS 或 Linux shell 执行，Windows 可使用 WSL2 运行主机检查。

```sh
git clone --branch v4-prototype https://github.com/Evan0825/feldspar.git
cd feldspar
python3 tests/run_checks.py
python3.12 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.lock.txt
.venv/bin/python -m unittest discover -s backend/tests -v
.venv/bin/python scripts/demo_features.py
.venv/bin/python scripts/smoke_backend.py
```

主机测试使用临时 C 程序和模拟外设。合成特征演示输出 `synthetic_fixture`。后端检查使用临时 SQLite 与进程内 HTTP。需要手动浏览 API 时，可按复现说明在干净终端启动回环服务，检查 `/healthz`、`/readyz` 和 `/docs`。`backend/.env.example` 是配置模板，需要显式载入。[复现说明](docs/REPRODUCE.md)

### 编译固件

安装并加载 ESP-IDF 5.4.1 后，从仓库根目录运行。用临时配置保留仓库内的基线。

```sh
cd firmware
build_root=$(mktemp -d)
cp sdkconfig "$build_root/sdkconfig"
idf.py -B "$build_root/build" -D "SDKCONFIG=$build_root/sdkconfig" build
```

默认关闭 `CONFIG_FELDSPAR_FEATURE_LINK`，适合核对本地 BLE 接口和外设。隔离测试环境如需结构化观测和云端停止，用同一份临时配置执行 `menuconfig` 开启该选项，再构建。两种配置的自动提醒均关闭。当前仓库的默认固件 Broker 和 OTA 地址是 `.invalid` 占位符。[固件配置与复现](docs/REPRODUCE.md)

### 导入小程序与接入测试环境

1. 用微信开发者工具导入 `firmware/miniprogram-latest/`。先用默认 Mock 模式走一遍页面，确认环境与导航。
2. 真机联调时使用有体验权限的测试 AppID。先把 `config/env.js` 的 API 地址或 CloudBase 环境替换为测试环境，再设 `demoMode: false`、`serviceMode: 'real'`。当前 Mock 配置仍保留历史 API 地址，仅切换模式会指向旧环境。
3. 启动独立测试后端，验证登录、测试设备登记和绑定。设备、测试 AppID、测试账号及云端记录要对应同一台样机。使用 Wi-Fi 配网和云端状态两个独立验收项。
4. 需要云端观测时，测试设备 NVS 的 `device_link` 配置须包含 `device_id`、`device_key`、`broker_uri`。Broker 使用 `mqtts`、匹配 CA 与设备专属访问权限。配置缺失时结构化链路关闭，BLE 手动通路仍可用。凭据和本机配置通过独立渠道管理。[配置模板](backend/.env.example) [设备与云端合同](docs/DEVELOPMENT_CONTRACT.md)

## 真机联调与验收

主机广播名以 `HAOMIAN-SLEEP_` 开头。BLE 服务 `FF00`，`FF01` 写控制，`FF02` 写音效数据，`FF03` 看设备状态，`FF04` 收数据与回读。当前固件的配网走 `FF01`。

| 顺序 | 测试 | 通过证据 |
| --- | --- | --- |
| 1 | 上电与识别 | 保存串口日志、实际固件版本、内存和外置 Flash 识别信息。确认灯、声音和马达默认关闭 |
| 2 | 发现与绑定 | 微信真机发现目标广播并成功订阅通知。小程序与后端绑定到同一个测试设备 ID |
| 3 | Wi-Fi 配网 | `0x44` 扫描，`0x41` 下发，`0x42` 查询。收到 `WIFI,CONNECTED` 和 IP，重启可重连，错误密码和断网能如实显示。`0x43` 用于清除配网 |
| 4 | 麦克风、存储与音效 | `0x20` 开启采集诊断，有声和安静时的 `MIC` 电平可区分。保存 JEDEC 和 FATFS 挂载结果。低音量试播、上传短音效并验证重启后可播放 |
| 5 | 手动输出与状态回读 | 必要时 `0x25` 恢复，恢复本身无输出。逐一验证夜灯、扬声器和振动片；`0x27` 回读灯光与播放，`0x24` 回读马达和锁定状态。驱动状态与实物现象分别记录 |
| 6 | 停止、限时与断连 | 实体按键长按 2 秒和 BLE `0x26` 各测一次，确认全停并锁定。单测振动到期、断开蓝牙后的停止及物理延迟 |
| 7 | 云端观测与远程停止 | 测试后端能接收同一设备的 `features/up` 和 `telemetry/up`。断开手机 BLE 后测云端全停，只有收到 `acks/up` 并读到停止锁定、马达强度为 0 才算确认 |

对 `0x24` 至 `0x27`，控制帧附非零两字节请求编号，以 `FF04` 返回的同编号 `SAFETY` 或 `IO` 通知确认操作。网络写入、指令排队和 UI 变化都不能单独证明执行成功。对每项验收记录样机编号、固件版本、手机系统、操作、实际现象与日志。[协议字段与回读](docs/DEVELOPMENT_CONTRACT.md)

升级前的 `1.0.2` 已通过手机发现、绑定、隔离热点配网和自动重连。台架确认扬声器出声、短按切灯，振动片在一次 50%、2 秒指令测试中实际启动并停止。麦克风仅做了近场粗测。继续验收呼吸灯、全停、限时和断连时，先核对测试板版本为 `1.0.4-dev.1108.4`。云端观测使用启用结构化链路的构建和独立测试身份。[样机联调记录](validation/20261107-hardware-bringup/README.md)

2026-11-08 经确认将单台样机切到 `1.0.4-dev.1019`，已校验原 16 MB 内置 Flash 备份。实机收到安全和输出回读，重启后仍连到已保存的测试网络，音效库识别 6 项。手机手动操作和云端上报按新计划验收。[手机联调计划](docs/superpowers/plans/2026-11-08-moonstone-phone-integration.md)

## 首夜闭环的缺口

- **校准。** 联调版自检要求云端新鲜的 `mic_status=ready`，当前固件只采一支麦克风。缺少上报时，页面说明未收到状态，并可查看已绑定设备。校准还要求 `pad_status=connected`，固件上报 `unknown` 且 `pad_detection=false`。首轮联调允许现场确认振动后继续，入口仅在联调副本显式启用，并要求主机在线、麦克风就绪，以及设备明确上报没有连接检测能力。人工确认只进入首页，连接状态仍为未知。自动识别插拔需要连接器检测电路、驱动和遥测。
- **声音与灯光。** 首轮验收常亮、调光、音效播放、音量和停止。候选已实现手动呼吸灯、设备端声音定时及 Wi-Fi 远程控制协议。声音定时和远程控制的实物执行与回执待验。
- **睡眠数据。** 当前 `feldspar-features-v1` 仅上传结构化特征，样本窗口为 1 秒，带质量和时钟标记。这条链路尚不生成真实夜间事件与晨报。可用明确标识来源的测试夜验证报告界面和缺测处理。毫米波雷达、第二颗麦克风、温度及电流传感器不列入首轮联调物料。
- **自动提醒与长期运行。** 自动输出保持关闭。启用条件包括独立数据评估、执行器物理标定、断电与断线处理、连续运行及 OTA 回滚实测。当前工程观察分值不等于鼾声分类准确率。

## 验证、维护与许可

2026-11-07 在本联调基线复跑通过后端测试 26 项、合成特征演示和后端烟雾检查。小程序 45 个 JS 文件通过语法检查，20 个 WXML 文件通过微信开发者工具离线编译。根据台架结果，候选补上扫描与重连的顺序处理，并在音效自然结束时等待缓冲中的尾部音频。ESP-IDF 5.4.1 默认与只观察配置均通过 ESP32-S3 构建，镜像均在 2 MB 应用分区内。小程序配网修正了默认蓝牙单包长度、安卓权限读取超时和旧固件重连误报。C 主机检查 8 组和 Node 测试 56 项通过。现装样机通过手机蓝牙、Mac 与安卓预览下发配网及自动重连。正式小程序真机微信登录与云端绑定已通过。设备自检回报、候选完整播放与全停、独立 Broker 和 OTA 回滚仍待实机验收。[样机联调记录](validation/20261107-hardware-bringup/README.md) [历史验证](docs/VALIDATION.md) [界面验证](validation/ui-interaction-20261028/README.md)

固件、小程序、后端和其他自研软件按 Apache-2.0 授权。[V4 硬件资料](hardware/v4/README.md) 按 CERN-OHL-P-2.0 授权。两种许可均允许商用，第三方材料沿用各自许可。量产原理图与 PCB、生产镜像、真实录音和训练权重需另行管理。[软件许可证](LICENSE) [硬件许可证](hardware/v4/LICENSE) [第三方说明](THIRD_PARTY_NOTICES.md) [贡献指南](CONTRIBUTING.md)

产品与参赛背景见 [项目介绍](docs/PROJECT.md) 和 [证据矩阵](docs/EVIDENCE.md)。界面改动遵循 [项目约定](AGENTS.md) 与 [UI 风格和交互偏好](docs/ui-style-preferences.md)，以 [确认图](docs/design/moonstone-ui-approved-20261028.png) 为视觉依据。
