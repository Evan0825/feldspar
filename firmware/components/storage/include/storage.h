#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 初始化外部 SPI Flash（W25Q64，8MB）：
 * SPI2 总线（CS=9, CLK=10, MOSI=11, MISO=12）+ 芯片探测 + 读写自检。
 * 未接线/识别失败时返回错误但不阻塞系统其它功能。 */
esp_err_t storage_init(void);

/* 在外部 Flash 上挂载 FATFS（挂载点 /ext，磨损均衡）。
 * 需在 storage_init 成功后调用；重复调用返回 ESP_OK。 */
esp_err_t storage_mount_fatfs(void);

/* 查询 FATFS 容量信息（字节）。未挂载返回 ESP_ERR_INVALID_STATE。 */
esp_err_t storage_fatfs_info(uint64_t *total_bytes, uint64_t *free_bytes);

/* FATFS 是否已挂载 */
bool storage_fatfs_mounted(void);

/* 获取芯片容量（字节）；未初始化返回 0 */
uint32_t storage_get_size(void);

/* 原始读写擦接口（供后续 FATFS / BLE 音乐传输使用），addr/len 单位字节 */
esp_err_t storage_read(uint32_t addr, void *out, size_t len);
esp_err_t storage_write(uint32_t addr, const void *data, size_t len);
esp_err_t storage_erase_sector(uint32_t addr);   /* 按 4KB 扇区擦除 */

#ifdef __cplusplus
}
#endif
