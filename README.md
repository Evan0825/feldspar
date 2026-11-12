# 月石 Feldspar

月石由 ESP32-S3 床头主机、有线枕下振动模块和微信小程序组成。固件负责外设控制、蓝牙和声学特征采集，小程序负责配网、手动控制和睡眠记录，后端提供设备状态与命令回执。

当前公开硬件为 **V6 两件轻扣外壳**。CAD、打印文件、接线和装配从 [V6 工程样机](hardware/v6/README.md) 开始。

[项目图文资料](docs/materials/README.md)包括技术架构图、结构爆炸图、宣传海报和鼾声模型训练报告。

| 模块 | 源码 |
| --- | --- |
| V6 硬件 | [CAD](hardware/v6/cad/) · [STL](hardware/v6/stl/) · [接线](hardware/v6/WIRING.md) |
| ESP32-S3 固件 | [firmware/](firmware/) |
| 微信原生小程序 | [firmware/miniprogram-latest/](firmware/miniprogram-latest/) |
| Python 后端 | [backend/](backend/) |

## 本地运行

使用 Python 3.12、Node.js 22 和 Clang，在仓库根目录运行。

```sh
git clone --branch v6-prototype https://github.com/Evan0825/feldspar.git
cd feldspar
python3.12 -m venv .venv
.venv/bin/python tests/run_checks.py
.venv/bin/python -m pip install -r backend/requirements.lock.txt
.venv/bin/python -m unittest discover -s backend/tests -v
.venv/bin/python scripts/smoke_backend.py
```

- 小程序使用微信开发者工具导入，默认以 Mock 模式启动。
- 固件使用 ESP-IDF 5.4.1 构建，自动提醒默认关闭。
- 后端支持 SQLite 离线验证。启动 API、测试设备和真实环境配置见[软件复现](docs/REPRODUCE.md)。

## 许可

自研软件采用 [Apache-2.0](LICENSE)，V6 自研硬件采用 [CERN-OHL-P-2.0](hardware/v6/LICENSE)，两者均允许按条款商用。项目补充图文采用 [CC BY-NC 4.0](docs/materials/LICENSE)，商用须另行授权。第三方内容沿用各自许可。 [第三方说明](THIRD_PARTY_NOTICES.md) · [贡献指南](CONTRIBUTING.md)
