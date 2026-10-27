#pragma once

#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 初始化蓝牙：GAP/GATT 服务注册、启动广播（配合 Bluedroid 堆栈） */
esp_err_t ble_init(void);

/* 向已连接设备发送状态通知（无连接时静默返回） */
void ble_notify_status(const char *msg);

/* 向已连接设备 0xFF04 数据特征推送（文件列表/传输应答/进度） */
void ble_notify_data(const char *msg);

#ifdef __cplusplus
}
#endif
