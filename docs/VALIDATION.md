# 本候选验证记录

日期：2026-10-27（Asia/Shanghai）。候选：oa2026-20261027；固件源码版本：1.0.4-dev.1019。对脱敏导出副本检查，未烧录、未连接生产服务。以下为实际命令与结果，不使用历史记录代填。

| 命令或检查 | 结果 | 范围 |
|---|---|---|
| python3 tests/run_checks.py | C 7 组、Node 25 项通过 | Clang 主机编译、ASan/UBSan（按各模块设置）、模拟外设与 wx；非无线/物理测试 |
| .venv/bin/python -m unittest discover -s backend/tests -v | 21 项通过 | 合成信号、独立 NumPy、进程内 API、临时 SQLite、内存 MQTT |
| .venv/bin/python scripts/demo_features.py | 通过 | 明确标识 synthetic_fixture；自噪后观察重置为 unknown |
| .venv/bin/python scripts/smoke_backend.py | 通过 | 真实应用入口启动、健康/就绪/OpenAPI、未配置 LLM、未认证特征访问被拒绝 |
| node --check（逐个文件） | 49 文件通过 | JS/CJS 语法，不代表微信运行时 |
| Python ast.parse（逐个文件） | 37 文件通过 | 语法，不代替执行 |
| JSON 解析 | 24 文件通过 | 配置语法 |
| 微信开发者工具 wcc | 19 个 WXML 离线编译通过 | 未进行界面截图与手机验收 |
| 本地静态媒体引用 | 缺失 0 | 检查 images/audio 的静态引用，不验证界面布局与音量 |
| ESP-IDF 5.4.1 idf.py build | 默认及只观察配置均通过 | ESP32-S3，8 MB Flash，Octal PSRAM；构建/链接/分区大小通过，不代表实机稳定 |
| 历史配置精确匹配 + 部分密钥模式检查 | 匹配 0 | 只覆盖已列历史配置与常见私钥/Token 模式，不是全面安全审计 |

后端运行环境：Python 3.12.14；精确包版本见 backend/requirements.lock.txt。C/Node 主机命令环境与目标构建环境分开；主机 Python 为本机 python3。当前环境为 macOS arm64，未在 Linux/Windows 验证；仓库 CI 为待执行配置。

ESP-IDF 官方完整 v5.4.1 SDK 与推荐 esp-14.2.0_20241119 工具链；完整 SDK 的元数据为 v5.4.1-dirty，不标成干净 Git checkout。本次两个配置各自用独立构建目录和 SDKCONFIG 副本；未烧录。二进制大小：默认 1,600,464 字节，只观察 1,600,848 字节；均小于 2 MB OTA 槽。产物哈希见 validation/20261027/target-builds.json，二进制不随源码包公开。

Starlette TestClient 存在 httpx 兼容接口弃用提示；当前检查 exit 0。SQLite 持久化与未连接 MQTT 日志是本地隔离运行的预期提示，不表示已部署。

日志位于 validation/20261027/。构建完整日志保留于本机任务临时目录；仓库只附末段构建结果。没有将手机/Broker/MySQL 实库/实机/OTA/8 小时验证标为通过。数据准确率、物理安全与真实使用效果仍待验收。

## 私有仓库上传后的跨平台补充

GitHub 私有仓库：https://github.com/Evan0825/feldspar 。上述记录是初次本地整理时的验证快照，PDF 保留该历史阶段。后续远端自动检查以 GitHub Actions 对应提交为准，不再将“远端未运行”作为当前状态。

首次 Ubuntu / Python 3.12 / Node 22 检查在严格 C11 编译音效模块时失败：M_PI 不是 C11 标准常量，Linux 头文件未定义它。保留原有主机检查作为回归，在音效生成表达式中改用数值等同的 float 圆周率字面量；不改变音效频率或控制逻辑。修复后本机 C 7 组与 Node 25 项检查通过。固件默认配置目标构建通过（1,600,464 字节，未烧录）；补充日志见 validation/20261027/upload-host-tests.log 与 target-upload-default-summary.log。远端完整检查结果见仓库 Actions。

未因此扩大到实机、Broker/MySQL、数据有效性或物理安全验证。
