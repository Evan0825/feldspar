#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "driver/gpio.h"
#include "audio.h"
#include "lighting.h"
#include "ble.h"
#include "haptic.h"
#include "mic.h"
#include "storage.h"
#include "sfx.h"
#include "wifi_mgr.h"
#include "mqtt_mgr.h"
#include "ota_mgr.h"
#include "button_gesture.h"
#include "device_control.h"
#include "esp_timer.h"
#include "device_link.h"

static const char *TAG = "haomian";

/* 物理按键（三脚模块：+ 接 3.3V，- 接 GND，D 接 GPIO7）。
 * 短按松开切换灯光，长按 2 秒停止全部输出，不额外触发短按。 */
#define BUTTON_GPIO  GPIO_NUM_7

void app_main(void)
{
    /* 初始化 NVS（供 BLE 存储绑定信息、灯带颜色记忆等） */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    /* OTA 管理器（打印版本/槽位状态，加载 NVS 断点态） */
    ESP_ERROR_CHECK(ota_mgr_init());

    /* Safety state and deadline timer must exist before any control channel. */
    ESP_ERROR_CHECK(haptic_erm_init());

    /* 初始化各外设模块 */
    ESP_ERROR_CHECK(audio_init());
    /* Restore remembered color with output OFF; explicit control enables it. */
    ESP_ERROR_CHECK(lighting_init());
    /* INMP441 麦克风（I2S1 RX），采集任务持续运行，诊断经 BLE 0x20 开启 */
    ESP_ERROR_CHECK(mic_init());

    /* 初始化蓝牙（Bluedroid，广播后即可连接） */
    ESP_ERROR_CHECK(ble_init());

    /* 初始化 WiFi STA（netif + 事件循环 + NVS 凭据；依赖 coex 与 BLE 共存） */
    ESP_ERROR_CHECK(wifi_mgr_init());

    /* 初始化 MQTT over TLS 客户端（注册网络事件，WiFi 获 IP 后自动连接） */
    esp_err_t mqtt=mqtt_mgr_init();
    if (mqtt!=ESP_OK) ESP_LOGW(TAG,"MQTT not configured; local control remains available");
    ESP_ERROR_CHECK(device_link_init());
    if (device_link_enabled()) mic_set_feature_cb(device_link_enqueue_features);

    /* 初始化 W25Q64 外部存储（未接线时仅告警，不影响其它功能） */
    if (storage_init() != ESP_OK) {
        ESP_LOGW(TAG, "storage module offline, skip storage feature");
    }

    /* 挂载 FATFS + 音效管理（依赖 storage 成功） */
    if (storage_fatfs_mounted() || storage_mount_fatfs() == ESP_OK) {
        if (sfx_init() == ESP_OK) {
            ESP_LOGI(TAG, "sfx manager ready (%d files)", sfx_count());
        } else {
            ESP_LOGW(TAG, "sfx init failed");
        }
    }

    /* 按键输入（内部上拉：按下 = 低电平，兼容"按键接 GND"与板载上拉型模块；
     * 日志实测按下始终拉低，故不用下拉） */
    gpio_config_t btn_cfg = {
        .pin_bit_mask = (1ULL << BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&btn_cfg);

    if (haptic_stop_latched()) device_control_stop_all();
    ESP_LOGI(TAG, "system ready. Short press: light; hold 2s: stop all.");

    /* OTA 自测确认：若本次从新槽（PENDING_VERIFY）启动且所有模块已成功初始化，
     * 则判定自测通过并 mark_valid；若某模块 init 失败已在上面提前返回，则不会
     * 执行到这里，bootloader 会自动回滚到旧槽。 */
    ota_mgr_confirm_if_pending();

    /* Existing wiring specifies active-low with pull-up. Never infer polarity
     * from boot level: a button held during boot must still mean STOP. */
    const int active_level = 0;

    /* 布防后再留 300ms 冷却：启动/USB 枚举窗口内的残余电平跳变不触发，
     * 正常人工按键远在此之后发生，不影响使用 */
    TickType_t armed_at = xTaskGetTickCount();

    button_gesture_t gesture = {0};
    while (1) {
        if ((xTaskGetTickCount() - armed_at) > pdMS_TO_TICKS(300)) {
            button_action_t action = button_gesture_update(&gesture,
                gpio_get_level(BUTTON_GPIO) == active_level, (uint64_t)esp_timer_get_time()/1000);
            if (action == BUTTON_SHORT) device_control_toggle_light();
            if (action == BUTTON_LONG) {
                esp_err_t stopped = device_control_stop_all();
                ble_notify_data(stopped == ESP_OK ? "CONTROL,STOP,ok" : "CONTROL,STOP,error");
                char status[64];
                haptic_status_line(status, sizeof(status));
                ble_notify_data(status);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
