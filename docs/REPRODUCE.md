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

## 3. 小程序

微信开发者工具导入 `firmware/miniprogram-latest/`，AppID 使用测试号或你自己的 AppID；仓库配置为 touristappid。默认 `demoMode: true`、`serviceMode: mock`、`transport: public`；mock 画面和模拟数据只证明交互流程。未完成微信开发者工具可视化及手机验收，不保证测试号支持所有平台能力。

真实接入需由维护者填写自己的 AppID/服务地址，将 demoMode 改为 false、serviceMode 改为 real，并配置独立测试服务与设备。真实模式的配网、绑定、鉴权与云托管不是离线 mock 的验证范围。所有 `project.private.config.json` 与真实环境文件保持本地。

## 4. 固件构建

安装官方 ESP-IDF 5.4.1 并加载其环境后：

```sh
cd firmware
idf.py -B build -D SDKCONFIG=sdkconfig build
```

保留仓库的 ESP32-S3 / 8 MB Flash / Octal PSRAM 配置。`CONFIG_FELDSPAR_FEATURE_LINK` 默认关闭；只观察构建可以通过 menuconfig 开启，但要求独立设备 NVS 的 device_id、device_key、mqtts broker_uri 和匹配 CA。自动动作在两种构建中均关闭。

历史共享 MQTT 账号已移除；默认 Broker 是 `.invalid` 保留域名，没有可用账号；OTA 地址同样为 `.invalid`。这些地址不是可连接的测试环境。需要独立服务配置后才能联调，不提供生产一键连接或自动烧录脚本。

运行 `idf.py build` 不代表样机接线正确、温升可接受、停止延迟达标或 OTA 回滚已实测。实机运行前按 HARDWARE.md 核对样机版次和供电，保持自动干预关闭。
