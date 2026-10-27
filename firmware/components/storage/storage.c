#include "storage.h"

#include <string.h>
#include "esp_log.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_flash.h"
#include "esp_flash_spi_init.h"   /* esp_flash_spi_device_config_t / spi_bus_add_flash_device */
#include "esp_partition.h"
#include "esp_vfs_fat.h"
#include "wear_levelling.h"

static const char *TAG = "storage";

/* ---- W25Q64（8MB SPI NOR Flash）引脚与 SPI 配置 ----
 * JEDEC ID 期望值：0xEF4017（EF=Winbond，4017=W25Q64JV） */
#define STORAGE_SPI_HOST    SPI2_HOST
#define STORAGE_CS_GPIO     GPIO_NUM_9
#define STORAGE_CLK_GPIO    GPIO_NUM_10
#define STORAGE_MOSI_GPIO   GPIO_NUM_11
#define STORAGE_MISO_GPIO   GPIO_NUM_12

#define STORAGE_FREQ_MHZ_FAST   40   /* 杜邦线先试 40MHz */
#define STORAGE_FREQ_MHZ_SLOW   20   /* 失败降速重试 */
#define SECTOR_SIZE             4096

static esp_flash_t *s_flash = NULL;   /* spi_bus_add_flash_device 创建并返回 */
static bool s_inited = false;
static uint32_t s_size = 0;

/* 挂载设备并探测芯片 */
static esp_err_t add_and_probe(int freq_mhz)
{
    esp_flash_spi_device_config_t cfg = {
        .host_id = STORAGE_SPI_HOST,
        .cs_io_num = STORAGE_CS_GPIO,
        .io_mode = SPI_FLASH_FASTRD,     /* 4 线模块仅单线数据，FASTRD 最稳 */
        .input_delay_ns = 0,
        .cs_id = 0,
        .freq_mhz = freq_mhz,
    };
    esp_err_t err = spi_bus_add_flash_device(&s_flash, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "add flash device err: %d", err);
        return err;
    }
    return esp_flash_init(s_flash);
}

esp_err_t storage_init(void)
{
    if (s_inited) return ESP_OK;

    spi_bus_config_t bus_cfg = {
        .mosi_io_num = STORAGE_MOSI_GPIO,
        .miso_io_num = STORAGE_MISO_GPIO,
        .sclk_io_num = STORAGE_CLK_GPIO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
    };
    esp_err_t err = spi_bus_initialize(STORAGE_SPI_HOST, &bus_cfg, SPI_DMA_DISABLED);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "spi bus init err: %d", err);
        return err;
    }

    /* 先 40MHz，失败降速 20MHz 重试（杜邦线较长/模块质量差时常见） */
    err = add_and_probe(STORAGE_FREQ_MHZ_FAST);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "probe @%dMHz failed: %s, retry @%dMHz",
                 STORAGE_FREQ_MHZ_FAST, esp_err_to_name(err), STORAGE_FREQ_MHZ_SLOW);
        spi_bus_remove_flash_device(s_flash);
        s_flash = NULL;
        err = add_and_probe(STORAGE_FREQ_MHZ_SLOW);
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "flash probe failed: %s（请检查 CS/SLK/DI/DO/VCC/GND 六根线）",
                 esp_err_to_name(err));
        return err;
    }

    /* 识别芯片：JEDEC ID + 容量 */
    uint32_t chip_id = 0;
    esp_flash_read_id(s_flash, &chip_id);
    esp_flash_get_size(s_flash, &s_size);
    ESP_LOGI(TAG, "chip id: 0x%06lX (W25Q64 应为 0xEF4017), size: %lu bytes (%lu MB)",
             (unsigned long)chip_id, (unsigned long)s_size, (unsigned long)(s_size >> 20));

    /* 读写自检：用最后一个扇区（避免占用起始区，后续挂 FATFS 用头部） */
    uint32_t test_addr = s_size - SECTOR_SIZE;
    uint8_t wbuf[256];
    for (int i = 0; i < (int)sizeof(wbuf); i++) wbuf[i] = (uint8_t)(i * 7 + 0x5A);
    uint8_t rbuf[sizeof(wbuf)] = {0};

    err = esp_flash_erase_region(s_flash, test_addr, SECTOR_SIZE);
    if (err == ESP_OK) err = esp_flash_write(s_flash, wbuf, test_addr, sizeof(wbuf));
    if (err == ESP_OK) err = esp_flash_read(s_flash, rbuf, test_addr, sizeof(rbuf));
    if (err != ESP_OK || memcmp(wbuf, rbuf, sizeof(wbuf)) != 0) {
        ESP_LOGE(TAG, "read/write self test FAILED (err=%s)", esp_err_to_name(err));
        return err == ESP_OK ? ESP_ERR_INVALID_RESPONSE : err;
    }
    ESP_LOGI(TAG, "read/write self test ok (%u bytes @0x%08lX)",
             (unsigned)sizeof(wbuf), (unsigned long)test_addr);

    s_inited = true;
    ESP_LOGI(TAG, "storage init ok (CS=%d CLK=%d MOSI=%d MISO=%d)",
             STORAGE_CS_GPIO, STORAGE_CLK_GPIO, STORAGE_MOSI_GPIO, STORAGE_MISO_GPIO);
    return ESP_OK;
}

uint32_t storage_get_size(void)
{
    return s_inited ? s_size : 0;
}

/* ---- FATFS（外部 Flash，磨损均衡）---- */
#define FATFS_MOUNT_POINT   "/ext"
#define FATFS_PARTITION     "extstore"
/* 预留最后一扇区给 storage_init 的读写自检，避免与文件系统冲突 */
#define FATFS_RESERVED_TAIL SECTOR_SIZE

static bool s_fatfs_mounted = false;

esp_err_t storage_mount_fatfs(void)
{
    if (s_fatfs_mounted) return ESP_OK;
    if (!s_inited || s_flash == NULL) return ESP_ERR_INVALID_STATE;

    /* 把外部 Flash 整体注册成一个 FAT 分区（尾部预留自检扇区） */
    const esp_partition_t *part = NULL;
    esp_err_t err = esp_partition_register_external(
        s_flash, 0, s_size - FATFS_RESERVED_TAIL,
        FATFS_PARTITION, ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, &part);
    if (err != ESP_OK || part == NULL) {
        ESP_LOGE(TAG, "register external partition err: %s", esp_err_to_name(err));
        return (err != ESP_OK) ? err : ESP_FAIL;
    }

    wl_handle_t wl = WL_INVALID_HANDLE;
    esp_vfs_fat_mount_config_t cfg = {
        .format_if_mount_failed = true,   /* 首次使用自动格式化 */
        .max_files = 8,
        .allocation_unit_size = 4096,
    };
    err = esp_vfs_fat_spiflash_mount_rw_wl(FATFS_MOUNT_POINT, FATFS_PARTITION,
                                           &cfg, &wl);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "fatfs mount err: %s", esp_err_to_name(err));
        esp_partition_deregister_external(part);
        return err;
    }
    s_fatfs_mounted = true;

    uint64_t total = 0, free_b = 0;
    storage_fatfs_info(&total, &free_b);
    ESP_LOGI(TAG, "fatfs mounted at %s, total %llu KB, free %llu KB",
             FATFS_MOUNT_POINT, (unsigned long long)(total >> 10),
             (unsigned long long)(free_b >> 10));
    return ESP_OK;
}

esp_err_t storage_fatfs_info(uint64_t *total_bytes, uint64_t *free_bytes)
{
    if (!s_fatfs_mounted) return ESP_ERR_INVALID_STATE;
    return esp_vfs_fat_info(FATFS_MOUNT_POINT, total_bytes, free_bytes);
}

bool storage_fatfs_mounted(void)
{
    return s_fatfs_mounted;
}

esp_err_t storage_read(uint32_t addr, void *out, size_t len)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    return esp_flash_read(s_flash, out, addr, len);
}

esp_err_t storage_write(uint32_t addr, const void *data, size_t len)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    return esp_flash_write(s_flash, data, addr, len);
}

esp_err_t storage_erase_sector(uint32_t addr)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    return esp_flash_erase_region(s_flash, addr, SECTOR_SIZE);
}
