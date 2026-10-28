# 月石 Feldspar / 好眠 SnoozMate

面向家庭鼾声困扰的开源睡眠辅助软硬件工程候选。床头主机与枕下提醒垫配合微信小程序，探索设备控制、声学观察和使用反馈。

**状态：开发候选 `oa2026-20261027`，不是医疗产品或可发布固件。自动干预关闭；没有提供经验证的鼾声分类模型。电脑测试不证明真实设备效果。**

## 从这里开始

- 无设备复现：运行下面的主机检查、后端测试和合成特征演示。
- 小程序入口：`firmware/miniprogram-latest/`，导入微信开发者工具，默认 mock 模式。
- 固件入口：`firmware/`，ESP-IDF 5.4.1 / ESP32-S3；只构建，不自动烧录。
- 参赛说明：[项目介绍](docs/PROJECT.md)、[创新证据矩阵](docs/EVIDENCE.md)、[复现说明](docs/REPRODUCE.md)。
- 硬件预期：[接线与物料](docs/HARDWARE.md)。尚未公开量产原理图/PCB，本仓库不是完整制造资料包。

## 无设备复现

依赖 Python 3.12、Node.js 20+、Clang 和 Git。C 检查会编译临时可执行文件；不连接设备。

```sh
python3 tests/run_checks.py
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.lock.txt
.venv/bin/python -m unittest discover -s backend/tests -v
.venv/bin/python scripts/demo_features.py
.venv/bin/python scripts/smoke_backend.py
```

Windows 请使用 WSL2 执行以上主机命令，或将 Python 路径改为 `.venv/Scripts/python.exe`；未在 Windows 验证。固件需单独安装 ESP-IDF。后端锁文件为本次 Python 3.12 环境的精确版本，不是所有平台兼容性承诺。

## 当前可以证明的能力

1. 固件 DSP 特征的 C 与 NumPy 数值一致性，以及质量标记、连续性检查。
2. 小程序协议层的请求令牌、超时和驱动状态回读；云端失败不冒充已同步。
3. 停止锁定、预算与超时约束的主机替身测试；物理温升和停止延迟尚待实测。
4. 结构化特征在进程内 API 与临时 SQLite 间的往返；不将观察分值当校准概率。

旧后端还保留音频接口与参考决策器；默认关闭 MQTT、音频上行、云端调试和外部模型。只有 `feldspar-features-v1` 链路可表述为“结构化特征、不含原始录音”。不得扩展成整个产品已验证不传音频。

## 开放范围

开放本候选固件源码、小程序代码、后端代码、协议、测试和文档。自研部分 Apache-2.0；cJSON、依赖及公共根证书保留各自条款，见 [第三方说明](THIRD_PARTY_NOTICES.md)。不包含生产凭据、用户数据、训练数据、模型权重、生产二进制和历史演示脚本。

原始音乐未纳入。小程序四个试听文件是新生成的低音量粉红噪声测试夹具，不代表疗愈或助眠效果。产品图片为项目方提供的展示素材，不代表实物验收结果。

仓库整理和许可证选择已获项目方于 2026-10-27 授权。当前交付目标为 GitHub 个人私有仓库 Evan0825/feldspar，仅供项目方及受邀协作者维护；尚未公开开源。未来可迁移至免费组织 feldspar-sleep。参赛前需核对评委访问方式，私有仓库不能自动满足公开开源要求。项目说明 PDF 记录的是整理时的候选状态。

## 参与与维护

阅读 [贡献指南](CONTRIBUTING.md) 与 [维护规划](docs/MAINTENANCE.md)。本次检查的命令、数量、环境和限制见 [验证记录](docs/VALIDATION.md)。

## 月石界面规范

后续界面工作遵循 [项目约定](AGENTS.md) 与 [UI 风格和交互偏好](docs/ui-style-preferences.md)，视觉依据为 [最新四屏确认图](docs/design/moonstone-ui-approved-20261028.png)。本次更新仅涉及小程序界面、偏好保存与方案状态展示；不启用自动干预或部署生产服务。
