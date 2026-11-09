# 复现说明

## 1. 主机协议与 C 模块

在仓库根目录运行 `python3 tests/run_checks.py`。测试在临时目录编译 C 程序，使用替身外设、时钟、网络与队列；Node 测试通过模拟 wx API 验证协议处理。无需 npm install。通过仅表示主机逻辑成立。

## 2. 后端与离线演示

按根 README 安装 `backend/requirements.lock.txt`。运行 unittest、`scripts/demo_features.py`、`scripts/smoke_backend.py`。演示明确输出 `synthetic_fixture`；不读取真人音频，不连接 Broker，不生成产品有效性结论。后端烟雾检查采用真实应用入口、进程内 HTTP 和临时 SQLite；认证外部服务不在此复现范围。

若要手工启动只监听回环地址的开发服务，先在空白终端设置以下变量，再运行命令。不要在带生产环境变量的终端直接运行：

```sh
export SNOOZMATE_DB_BACKEND=sqlite
export SNOOZMATE_DB_PATH=/tmp/feldspar-local-demo.db
export SNOOZMATE_MQTT_ENABLED=false
export SNOOZMATE_MQTT_AUDIO_ENABLED=false
export SNOOZMATE_MQTT_HTTP_AUTH_ENABLED=false
export SNOOZMATE_ENABLE_CLOUD_AGENT_DEBUG=false
export SNOOZMATE_SEED_DEMO_DATA=false
export SNOOZMATE_AUTH_MODE=production
.venv/bin/python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
```

打开 `http://127.0.0.1:8000/docs` 检查接口。没有微信登录配置时，受保护接口按权限规则拒绝请求；不能以此假定已接入微信身份。`backend/.env.example` 只是配置模板，代码不会自动加载它。

晨报解读可在测试服务端设置 `SNOOZMATE_LLM_PROVIDER=deepseek` 并注入该服务的 `DEEPSEEK_API_KEY`，默认使用 `deepseek-flash` 非思考模式。已有通用 `SNOOZMATE_LLM_KEY` 时须确认它对应所选服务。小程序沿用 AI 数据授权，测试优先使用合成结构化记录。

方舟双模型联调使用 `SNOOZMATE_LLM_PROVIDER=volcengine-ark-standard`。在服务端凭据配置中注入方舟 `ARK_API_KEY` 后，晨报和问答默认走 `deepseek-v4-1-flash-261017`，短音频分析走 `doubao-seed-2-1-lite-260915`。两者调用方舟标准推理接口。该配置不改变短音频所有者授权和自动提醒开关，首次联调使用合成音频与合成晨报。

「实时状态」从设备授权保护的 `/api/v1/device/{id}/features/latest` 读取声学观察，区分等待、延迟与有效窗口。当前设备的 `feldspar-features-v1` 是统计摘要和规则观察。训练仓库的 [v5 INT8 模型](https://github.com/snoozekinpin/snoring-ml-training/blob/58ae1312ae36082dfea239ce57f013a3a61e32eb/output/v5/deliverables/model_card.md) 输入为 61×30 的量化 Log-Mel 特征，接入该模型需先验证与目标设备的输入一致性。

## 3. 小程序

微信开发者工具导入 `firmware/miniprogram-latest/`，AppID 使用测试号或你自己的 AppID；仓库配置为 touristappid。默认 `demoMode: true`、`serviceMode: mock`、`transport: public`；mock 画面和模拟数据只证明交互流程。未完成微信开发者工具可视化及手机验收，不保证测试号支持所有平台能力。

真实接入需由维护者填写自己的 AppID/服务地址，将 demoMode 改为 false、serviceMode 改为 real，并配置独立测试服务与设备。真实模式的配网、绑定、鉴权与云托管不是离线 mock 的验证范围。所有 `project.private.config.json` 与真实环境文件保持本地。

首轮人工确认仅在联调副本启用。在 `config/env.js` 设置 `testManualPadConfirmation: true`，使用开发版或体验版。设备在线、麦克风就绪且新鲜上报 `pad_detection=false`、`pad_status=unknown` 时，自检可在观察实物振动并停止后继续。记录仍以设备回读为准。

手机正式绑定可用独立的 CloudBase 或 HTTPS 测试后端。CloudBase 使用 `transport: 'cloud-container'`、测试环境 ID 和服务名，后端填写匹配的 `SNOOZMATE_WECHAT_APP_ID`。只有后端入口由微信网关独占、网关能验证并注入身份头时，才启用 `SNOOZMATE_CLOUDBASE_HEADER_AUTH_ENABLED=true`。对公网 HTTPS，显式关闭该开关，并在后端配置测试小程序的 AppID 和 AppSecret，通过微信接口交换登录码。两条路径均使用 `SNOOZMATE_AUTH_MODE=production` 验收。

## 4. 固件构建

安装官方 ESP-IDF 5.4.1 并加载其环境后：

```sh
cd firmware
idf.py -B build -D SDKCONFIG=sdkconfig build
```

保留仓库的 ESP32-S3 / 8 MB Flash / Octal PSRAM 配置。`CONFIG_FELDSPAR_FEATURE_LINK` 默认关闭；只观察构建可以通过 menuconfig 开启，但要求独立设备 NVS 的 device_id、device_key、mqtts broker_uri 和匹配 CA。自动动作在两种构建中均关闭。

历史共享 MQTT 账号已移除；默认 Broker 是 `.invalid` 保留域名，没有可用账号；OTA 地址同样为 `.invalid`。这些地址不是可连接的测试环境。需要独立服务配置后才能联调，不提供生产一键连接或自动烧录脚本。

现有样机的临时构建启用 `CONFIG_FELDSPAR_BUTTON_ACTIVE_HIGH` 和 `CONFIG_FELDSPAR_PRESERVE_EXISTING_STORAGE`，分别匹配实际按键和保护已有配置、音效存储。通用构建默认按键为低有效。

运行 `idf.py build` 不代表样机接线正确、温升可接受、停止延迟达标或 OTA 回滚已实测。实机运行前按 HARDWARE.md 核对样机版次和供电，保持自动干预关闭。
