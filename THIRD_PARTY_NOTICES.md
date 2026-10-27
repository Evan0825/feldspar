# 第三方来源与许可证

根 LICENSE 仅适用于项目方有权许可的自研部分，不覆盖以下例外。发布者需随版本保留本文件及相应许可。

## 随仓库包含

- `tests/vendor/cJSON/`：上游 cJSON 1.7.19，Dave Gamble and cJSON contributors，MIT。原 LICENSE 与代码版权头完整保留；仅用于主机测试。来源：https://github.com/DaveGamble/cJSON/tree/v1.7.19 。
- `firmware/ca.crt` 与 `firmware/components/mqtt_mgr/ca.crt`：原工程使用的公共根证书，保留原字节；证书不是自研代码，不赋予新的 Apache 许可。部署时必须核对自己 Broker 的 CA，不用它绕过 TLS 校验。
- `firmware/components/acoustic_features/af_fft512.c`：源码注明参考项目 snoring-ml-training 固定提交 `58ae1312ae36082dfea239ce57f013a3a61e32eb`。项目方已授权公开自研固件；本候选没有复制该项目完整训练目录、数据或模型权重。此来源说明不把第三方数据/模型一并重新许可。
- 小程序 `images/`：项目方提供的产品展示素材，随本地候选附带；仅说明设计，不作为样机照片证据。项目方授权范围内的素材按根许可证分发。
- 小程序 `audio/`：本次使用 ffmpeg seeded anoisesrc 新生成的粉红噪声试听夹具；不含原音乐，不声称任何健康功效。生成命令：`ffmpeg -f lavfi -i anoisesrc=color=pink:amplitude=0.015:sample_rate=16000:seed=1:duration=6 -codec:a libmp3lame -b:a 32k sleep.mp3`；其余三个文件种子为 2、3、4。ffmpeg 是生成工具，不随包分发。

## 外部构建依赖（不随仓库分发）

ESP-IDF 5.4.1 及其组件、工具链按 Espressif 和各上游许可使用，不能将整个 SDK 统一标记 Apache-2.0。请使用官方发行版及其 LICENSE/NOTICE；不随本包附带 SDK 或二进制。来源：https://github.com/espressif/esp-idf/tree/v5.4.1 。

微信开发者工具和微信运行环境为平台工具，不随仓库分发。Node.js、Python、Clang 为外部运行/编译依赖。

## Python 精确版本清单

下面依据实际安装的 distribution metadata 生成；完整可获取的依赖许可文本见 `licenses/python/`。锁文件包含这些直接与传递依赖；这些包需按各自许可使用，不统一重新许可。

| 包 | 版本 | 安装元数据许可 |
|---|---|---|
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| certifi | 2026.10.23 | MPL-2.0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| fastapi | 0.146.0 | MIT |
| h11 | 0.16.0 | MIT |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| idna | 3.20 | BSD-3-Clause |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| opentelemetry-api | 1.45.1 | Apache-2.0 |
| paho-mqtt | 2.1.0 | EPL-2.0 OR BSD-3-Clause |
| pydantic | 2.14.1 | MIT |
| pydantic_core | 2.50.1 | MIT |
| PyMySQL | 1.2.3 | MIT |
| requests | 2.34.2 | Apache-2.0 |
| starlette | 1.10.0 | BSD-3-Clause |
| typing-inspection | 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.8.0 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |

本次做的是清单和已附许可核对，不是对全部历史代码的独立权属审计；新增第三方依赖时必须同步更新。
