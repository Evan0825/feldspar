cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)

# 固件语义化版本：vX.Y.Z（OTA manifest 与 esp_app_desc 使用）
set(PROJECT_VER "1.0.4-dev.1019")

# 项目名：好眠（good sleep）ESP32-S3 控制固件
project(haomian)
