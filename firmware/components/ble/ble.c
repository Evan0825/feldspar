#include "ble.h"
#include "ble_protocol.h"

#include <string.h>
#include <inttypes.h>
#include "esp_log.h"
#include "esp_bt.h"
#include "esp_bt_main.h"
#include "esp_bt_device.h"
#include "esp_gap_ble_api.h"
#include "esp_gatts_api.h"
#include "esp_gatt_defs.h"
#include "esp_gatt_common_api.h"

#include "audio.h"
#include "lighting.h"
#include "haptic.h"
#include "mic.h"
#include "sfx.h"
#include "wifi_mgr.h"
#include "mqtt_mgr.h"
#include "ota_mgr.h"
#include "device_control.h"

static const char *TAG = "ble";

/* 基础设备名：最终名 = <基础名>_<公共MAC后6位字符> */
static const char *DEVICE_BASE_NAME = "HAOMIAN-SLEEP";
static char s_device_name[32];

/* GATT 服务/特征句柄（注册后回写） */
static uint16_t s_gatts_if             = ESP_GATT_IF_NONE;
static uint16_t s_conn_id              = 0;
static bool     s_connected            = false;
static uint16_t s_svc_handle           = 0;
static uint16_t s_ctrl_handle          = 0;
static uint16_t s_audio_handle         = 0;
static uint16_t s_status_handle        = 0;
static uint16_t s_status_ccc_handle    = 0;   /* status 的 CCCD (notify 开关) */
static bool     s_status_notify_enable = false;
static uint16_t s_data_handle          = 0;   /* 0xFF04 数据下行 */
static uint16_t s_data_ccc_handle      = 0;
static bool     s_data_notify_enable   = false;

#define IDX_SVC             0
#define IDX_CHAR_CTRL       1
#define IDX_CHAR_VAL_CTRL   2
#define IDX_CHAR_AUDIO      3
#define IDX_CHAR_VAL_AUDIO  4
#define IDX_CHAR_STATUS     5
#define IDX_CHAR_VAL_STATUS 6
#define IDX_CHAR_DESC_CCC   7
#define IDX_CHAR_DATA       8
#define IDX_CHAR_VAL_DATA   9
#define IDX_CHAR_DESC_CCC_DATA 10
#define HRS_IDX_NB          11

static const uint16_t primary_service_uuid         = ESP_GATT_UUID_PRI_SERVICE;
static const uint16_t character_declaration_uuid   = ESP_GATT_UUID_CHAR_DECLARE;
static const uint16_t character_client_config_uuid = ESP_GATT_UUID_CHAR_CLIENT_CONFIG;

/* 16-bit 服务/特征 UUID（按协议定义：0xFF00 / 0xFF01-0xFF04） */
static const uint16_t ble_svc_uuid       = BLE_SVC_UUID;
static const uint16_t ble_ctrl_uuid      = BLE_CHR_CONTROL_UUID;
static const uint16_t ble_audio_uuid     = BLE_CHR_AUDIO_UUID;
static const uint16_t ble_status_uuid    = BLE_CHR_STATUS_UUID;
static const uint16_t ble_data_uuid      = BLE_CHR_DATA_UUID;

/* Bluedroid 官方约定：CHAR_DECLARATION_SIZE = 1 byte 属性位（char property）
 * 注：GATT 规范 char decl value 是 Property(1B)+Handle(2B)+UUID(var)，但
 * esp_gatts_create_attr_tab 仅需 property 字段，其余自动补全。 */
#define CHAR_DECLARATION_SIZE   (sizeof(uint8_t))

/* 特征属性格式：权限掩码 (WRITE / READ / NOTIFY) */
static const uint8_t prop_write_norsp   = (ESP_GATT_CHAR_PROP_BIT_WRITE | ESP_GATT_CHAR_PROP_BIT_WRITE_NR);
static const uint8_t prop_read_notify   = (ESP_GATT_CHAR_PROP_BIT_READ | ESP_GATT_CHAR_PROP_BIT_NOTIFY);
static const uint8_t ccc_initial[2]    = {0x00, 0x00};

/* 特性表：service / char_decl / char_value / char_desc
 * （完全对齐 ESP-IDF gatt_server_service_table 示例写法）*/
static esp_gatts_attr_db_t s_gatts_db[HRS_IDX_NB] =
{
    /* 0 服务声明 */
    [IDX_SVC] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&primary_service_uuid,
          ESP_GATT_PERM_READ, sizeof(uint16_t), sizeof(ble_svc_uuid),
          (uint8_t *)&ble_svc_uuid}},

    /* 1 控制特征 声明 */
    [IDX_CHAR_CTRL] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_declaration_uuid,
          ESP_GATT_PERM_READ, CHAR_DECLARATION_SIZE, CHAR_DECLARATION_SIZE,
          (uint8_t *)&prop_write_norsp}},
    /* 2 控制特征 值 (WRITE/WRITE_NR) */
    [IDX_CHAR_VAL_CTRL] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&ble_ctrl_uuid,
          ESP_GATT_PERM_WRITE, 256, 0, NULL}},

    /* 3 音频特征 声明 */
    [IDX_CHAR_AUDIO] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_declaration_uuid,
          ESP_GATT_PERM_READ, CHAR_DECLARATION_SIZE, CHAR_DECLARATION_SIZE,
          (uint8_t *)&prop_write_norsp}},
    /* 4 音频特征 值 (WRITE/WRITE_NR，最大 512 字节) */
    [IDX_CHAR_VAL_AUDIO] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&ble_audio_uuid,
          ESP_GATT_PERM_WRITE, BLE_AUDIO_CHUNK_MAX, 0, NULL}},

    /* 5 状态特征 声明 */
    [IDX_CHAR_STATUS] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_declaration_uuid,
          ESP_GATT_PERM_READ, CHAR_DECLARATION_SIZE, CHAR_DECLARATION_SIZE,
          (uint8_t *)&prop_read_notify}},
    /* 6 状态特征 值 (READ+NOTIFY) */
    [IDX_CHAR_VAL_STATUS] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&ble_status_uuid,
          ESP_GATT_PERM_READ, 32, 0, NULL}},

    /* 7 状态 CCCD (READ/WRITE，固定 2 字节初值 0x0000) */
    [IDX_CHAR_DESC_CCC] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_client_config_uuid,
          ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE,
          sizeof(uint16_t), sizeof(ccc_initial), (uint8_t *)ccc_initial}},

    /* 8 数据特征 声明 (READ + NOTIFY，文件列表/传输应答下行) */
    [IDX_CHAR_DATA] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_declaration_uuid,
          ESP_GATT_PERM_READ, CHAR_DECLARATION_SIZE, CHAR_DECLARATION_SIZE,
          (uint8_t *)&prop_read_notify}},
    /* 9 数据特征 值 */
    [IDX_CHAR_VAL_DATA] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&ble_data_uuid,
          ESP_GATT_PERM_READ, 64, 0, NULL}},
    /* 10 数据 CCCD */
    [IDX_CHAR_DESC_CCC_DATA] =
        {{ESP_GATT_AUTO_RSP}, {ESP_UUID_LEN_16, (uint8_t *)&character_client_config_uuid,
          ESP_GATT_PERM_READ | ESP_GATT_PERM_WRITE,
          sizeof(uint16_t), sizeof(ccc_initial), (uint8_t *)ccc_initial}},
};

/* ---- 小工具：LE 读取 / CRC16(ARC) ---- */
static uint16_t rd16(const uint8_t *p)
{
    return (uint16_t)(p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint16_t crc16_arc(const uint8_t *data, size_t len)
{
    uint16_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int b = 0; b < 8; b++) {
            crc = (crc & 1) ? (uint16_t)((crc >> 1) ^ 0xA001) : (uint16_t)(crc >> 1);
        }
    }
    return crc;
}

/* 0xFF04 数据下行（文件列表 / 传输应答 / 进度） */
void ble_notify_data(const char *msg)
{
    if (!s_connected || msg == NULL) return;
    if (!s_data_notify_enable) return;
    if (s_gatts_if == ESP_GATT_IF_NONE) return;

    uint16_t len = (uint16_t)strlen(msg);
    if (len > 64) len = 64;
    esp_ble_gatts_send_indicate(s_gatts_if, s_conn_id, s_data_handle,
                                len, (uint8_t *)msg, false);
}

/* sfx → BLE 推送桥接 */
static void sfx_progress_bridge(uint32_t sent, uint32_t total)
{
    char buf[16];
    snprintf(buf, sizeof(buf), "RX,%lu%%", (unsigned long)(sent * 100 / total));
    ble_notify_data(buf);
}

static void sfx_event_bridge(const char *msg)
{
    ble_notify_data(msg);
    ESP_LOGI(TAG, "sfx event: %s", msg);
}

/* OTA → BLE 进度推送：OTA,PROG,<off>,<total> */
static void ota_progress_bridge(uint32_t off, uint32_t total)
{
    char buf[40];
    snprintf(buf, sizeof(buf), "OTA,PROG,%lu,%lu",
             (unsigned long)off, (unsigned long)total);
    ble_notify_data(buf);
}

static void report_safety(const uint8_t *data, uint16_t len, esp_err_t result)
{
    uint16_t request_id = len >= 3 ? rd16(data + 1) : 0;
    char state[40], reply[64];
    haptic_status_line(state, sizeof(state));
    snprintf(reply, sizeof(reply), "SAFETY,%u,%s,%s", request_id,
             result == ESP_OK ? "ok" : "error", state);
    ble_notify_data(reply);
}

/* ---- 控制命令处理：分发给灯光/电机/音频/音效 ---- */
static void handle_control(const uint8_t *data, uint16_t len)
{
    if (data == NULL || len < 1) return;
    uint8_t cmd = data[0];

    /* OTA 升级进行中：拒绝一切占用音频 I2S / 麦克风 / 音效传输的命令，
     * 避免升级过程与播放/传输争用 I2S 外设或打断写入。 */
    bool motor_stop = cmd == BLE_CMD_MOTOR_SPEED && len >= 2 && (int8_t)data[1] <= 0;
    if (ota_mgr_busy() && !motor_stop) {
        switch (cmd) {
        case BLE_CMD_MOTOR_SPEED:
        case BLE_CMD_SAFETY_RESUME:
        case BLE_CMD_AUDIO_PLAY:
        case BLE_CMD_AUDIO_PAUSE:
        case BLE_CMD_AUDIO_VOLUME:
        case BLE_CMD_AUDIO_TEST:
        case BLE_CMD_MIC_DIAG:
        case BLE_CMD_SFX_BEGIN:
        case BLE_CMD_SFX_END:
        case BLE_CMD_SFX_PLAY:
        case BLE_CMD_SFX_DELETE:
        case BLE_CMD_SFX_LIST:
        case BLE_CMD_SFX_AUTO:
            ble_notify_data("OTA,ERR,8");   /* 忙碌（升级中） */
            return;
        default: break;
        }
    }

    bool activates_output = cmd == BLE_CMD_AUDIO_PLAY || cmd == BLE_CMD_AUDIO_TEST ||
        (cmd == BLE_CMD_AUDIO_VOLUME && len >= 2 && data[1]) ||
        cmd == BLE_CMD_SFX_PLAY || (cmd == BLE_CMD_SFX_AUTO && len >= 2 && data[1]) ||
        (cmd == BLE_CMD_MOTOR_SPEED && len >= 2 && (int8_t)data[1] > 0) ||
        (cmd == BLE_CMD_LIGHT_LEVEL && len >= 2 && data[1]) ||
        (cmd == BLE_CMD_LIGHT_RGB && len >= 4 && (data[1] || data[2] || data[3]));
    if (haptic_stop_latched() && activates_output) {
        ble_notify_data("CONTROL,ERR,stopped");
        return;
    }

    switch (cmd) {
    case BLE_CMD_IO_STATE: {
        uint8_t r,g,b; bool enabled;
        lighting_get_state(&r,&g,&b,&enabled);
        char reply[64];
        snprintf(reply,sizeof(reply),"IO,%u,%u,%u,%u,%u,%u,%u,%d",
            len>=3 ? rd16(data+1) : 0,enabled,r,g,b,audio_get_volume(),audio_get_state(),sfx_current());
        ble_notify_data(reply);
        break;
    }
    case BLE_CMD_SAFETY_STATE: {
        report_safety(data, len, ESP_OK);
        break;
    }
    case BLE_CMD_SAFETY_RESUME: {
        report_safety(data, len, haptic_resume_manual());
        break;
    }
    case BLE_CMD_STOP_ALL: {
        esp_err_t err = device_control_stop_all();
        report_safety(data, len, err);
        break;
    }
    case BLE_CMD_LIGHT_LEVEL:
        if (len >= 2) {
            lighting_set_level(data[1]);
            ESP_LOGI(TAG, "cmd: light level=%u", (unsigned)data[1]);
        }
        break;
    case BLE_CMD_LIGHT_RGB:
        if (len >= 4) {
            lighting_set_rgb(data[1], data[2], data[3]);
            ESP_LOGI(TAG, "cmd: light rgb=%u,%u,%u",
                     (unsigned)data[1], (unsigned)data[2], (unsigned)data[3]);
        }
        break;
    case BLE_CMD_MOTOR_SPEED:
        if (len >= 2) {
            /* ERM 偏心轮（SIG=GPIO42）只能正转，强度 0-100；负数按 0 处理 */
            int8_t pct = (int8_t)data[1];
            haptic_erm_set((uint8_t)((pct < 0) ? 0 : pct));
            char status[64];
            haptic_status_line(status, sizeof(status));
            ble_notify_data(status);
        }
        break;
    case BLE_CMD_MOTOR_STOP:
        haptic_erm_set(0);
        {
            char status[64];
            haptic_status_line(status, sizeof(status));
            ble_notify_data(status);
        }
        ESP_LOGI(TAG, "cmd: motor stop");
        break;
    case BLE_CMD_AUDIO_PLAY:
        if (sfx_is_playing()) {
            sfx_resume();      /* 恢复被暂停的音效播放 */
        } else {
            audio_start();     /* 兼容旧的实时 PCM 推流模式 */
        }
        ESP_LOGI(TAG, "cmd: audio play");
        break;
    case BLE_CMD_AUDIO_PAUSE:
        if (sfx_is_playing()) {
            sfx_pause();
        } else {
            audio_pause();
        }
        ESP_LOGI(TAG, "cmd: audio pause");
        break;
    case BLE_CMD_AUDIO_STOP:
        sfx_stop();
        ESP_LOGI(TAG, "cmd: audio stop");
        break;
    case BLE_CMD_AUDIO_VOLUME:
        if (len >= 2) {
            audio_set_volume(data[1]);
            ESP_LOGI(TAG, "cmd: audio volume=%u", (unsigned)data[1]);
        }
        break;
    case BLE_CMD_AUDIO_TEST: {  /* 播放内置测试音（不存在则自动生成） */
        char reply[16];
        int idx = sfx_play_test();
        if (idx > 0 && idx <= 255) {
            snprintf(reply, sizeof(reply), "TESTTONE,%u", (unsigned)idx);
            ESP_LOGI(TAG, "cmd: audio test tone #%d", idx);
        } else {
            snprintf(reply, sizeof(reply), "TESTERR");
            ESP_LOGE(TAG, "cmd: audio test tone failed");
        }
        ble_notify_data(reply);
        break;
    }
    case BLE_CMD_MIC_DIAG: {   /* [0=停止 / 1=开始] 麦克风诊断：每秒回 MIC,<rms>,<peak> */
        if (len >= 2) {
            mic_diag(data[1] != 0);
            ble_notify_data(data[1] ? "MICON" : "MICOFF");
            ESP_LOGI(TAG, "cmd: mic diagnostic %s", data[1] ? "on" : "off");
        }
        break;
    }

    /* ---- 音效文件管理 ---- */
    case BLE_CMD_SFX_BEGIN: {   /* [name_len][name..][size u32 LE][fmt u8] */
        char reply[32];
        if (len < 3 || len < (uint16_t)(2 + data[1] + 5)) {
            ble_notify_data("RXERR,badlen");
            break;
        }
        uint8_t name_len = data[1];
        char name[SFX_NAME_MAX + 1] = {0};
        /* 名称过滤：仅保留可打印 ASCII，禁止路径符 */
        uint8_t kept = 0;
        for (uint8_t i = 0; i < name_len && kept < SFX_NAME_MAX; i++) {
            char c = (char)data[2 + i];
            if (c >= '0' && c <= '9') { name[kept++] = c; }
            else if (c >= 'A' && c <= 'Z') { name[kept++] = c; }
            else if (c >= 'a' && c <= 'z') { name[kept++] = c; }
            else if (c == '-' || c == '_') { name[kept++] = c; }
        }
        if (kept == 0) {
            ble_notify_data("RXERR,badname");
            break;
        }
        const uint8_t *tail = data + 2 + name_len;
        uint32_t size = rd32(tail);
        uint8_t fmt = tail[4];
        esp_err_t err = sfx_rx_begin(name, size, fmt);
        if (err == ESP_OK) {
            snprintf(reply, sizeof(reply), "RXBEGIN,%lu", (unsigned long)size);
        } else if (err == ESP_ERR_NO_MEM) {
            snprintf(reply, sizeof(reply), "RXERR,full");
        } else {
            snprintf(reply, sizeof(reply), "RXERR,begin");
        }
        ble_notify_data(reply);
        break;
    }
    case BLE_CMD_SFX_END: {     /* [crc32 u32 LE] */
        char ok_msg[48] = {0}, err_msg[48] = {0};
        uint32_t crc32 = (len >= 5) ? rd32(data + 1) : 0;
        esp_err_t err = sfx_rx_end(crc32, ok_msg, sizeof(ok_msg),
                                   err_msg, sizeof(err_msg));
        if (err == ESP_OK) {
            ble_notify_data(ok_msg);
        } else {
            char reply[64];
            snprintf(reply, sizeof(reply), "FILEERR,%s", err_msg);
            ble_notify_data(reply);
        }
        break;
    }
    case BLE_CMD_SFX_PLAY: {    /* [index]，0=按规则自动选 */
        char reply[16];
        if (len < 2) break;
        esp_err_t err = sfx_play(data[1]);
        if (err == ESP_OK) {
            snprintf(reply, sizeof(reply), "PLAYCMD,%u", (unsigned)data[1]);
        } else {
            snprintf(reply, sizeof(reply), "PLAYERR,%u", (unsigned)data[1]);
        }
        ble_notify_data(reply);
        break;
    }
    case BLE_CMD_SFX_DELETE: {  /* [index] */
        char reply[16];
        if (len < 2) break;
        esp_err_t err = sfx_delete(data[1]);
        snprintf(reply, sizeof(reply), (err == ESP_OK) ? "DELOK,%u" : "DELERR,%u",
                 (unsigned)data[1]);
        ble_notify_data(reply);
        break;
    }
    case BLE_CMD_SFX_LIST: {    /* 结果经 0xFF04 逐行下发 */
        char line[64];
        snprintf(line, sizeof(line), "FILES,%d", sfx_count());
        ble_notify_data(line);
        for (int i = 1; i <= sfx_count(); i++) {
            char name[SFX_NAME_MAX + 1];
            uint32_t size; uint8_t fmt;
            if (sfx_info(i, name, sizeof(name), &size, &fmt)) {
                snprintf(line, sizeof(line), "FILE,%d,%s,%lu,%u",
                         i, name, (unsigned long)size, (unsigned)fmt);
                ble_notify_data(line);
            }
        }
        ble_notify_data("FILESEND");
        break;
    }
    case BLE_CMD_SFX_AUTO: {    /* [0/1] 预设规则自动轮播 */
        if (len < 2) break;
        sfx_set_auto(data[1] != 0);
        char reply[16];
        snprintf(reply, sizeof(reply), "AUTO,%u", (unsigned)(data[1] != 0));
        ble_notify_data(reply);
        ESP_LOGI(TAG, "cmd: sfx auto=%u", (unsigned)(data[1] != 0));
        break;
    }

    /* ---- WiFi 管理 ---- */
    case BLE_CMD_WIFI_CONFIG: {   /* [ssid_len][ssid..][pwd_len][pwd..] */
        if (len < 2) break;
        uint8_t slen = data[1];
        if (len < (uint16_t)(2u + slen + 1u)) { ble_notify_data("WIFI,ERR,badlen"); break; }
        uint8_t plen = data[2 + slen];
        if (len < (uint16_t)(2u + slen + 1u + plen)) { ble_notify_data("WIFI,ERR,badlen"); break; }

        char ssid[33], pass[64];
        uint8_t sn = (slen > 32) ? 32 : slen;
        uint8_t pn = (plen > 63) ? 63 : plen;
        memcpy(ssid, data + 2, sn);      ssid[sn] = 0;
        memcpy(pass, data + 2 + slen + 1, pn); pass[pn] = 0;

        esp_err_t err = wifi_mgr_connect(ssid, pass);
        if (err != ESP_OK) {
            char r[24];
            snprintf(r, sizeof(r), "WIFI,ERR,%d", (int)err);
            ble_notify_data(r);
        }
        ESP_LOGI(TAG, "cmd: wifi config ssid='%s' len=%u", ssid, (unsigned)slen);
        break;
    }
    case BLE_CMD_WIFI_STATE: {    /* 查询 WiFi 状态 */
        char buf[80];
        wifi_mgr_get_status(buf, sizeof(buf));
        ble_notify_data(buf);
        ESP_LOGI(TAG, "cmd: wifi state -> %s", buf);
        break;
    }
    case BLE_CMD_WIFI_FORGET: {   /* 清除已存凭据并断开 */
        wifi_mgr_forget();
        ble_notify_data("WIFI,FORGOT");
        ESP_LOGI(TAG, "cmd: wifi forget");
        break;
    }
    case BLE_CMD_WIFI_SCAN: {     /* 扫描附近 AP，结果经 0xFF04 逐行下发 */
        esp_err_t err = wifi_mgr_scan_start();
        if (err != ESP_OK) {
            ble_notify_data("WIFI,SCANERR");
        }
        ESP_LOGI(TAG, "cmd: wifi scan -> %s", esp_err_to_name(err));
        break;
    }

    /* ---- OTA 升级 ---- */
    case BLE_CMD_OTA_BEGIN: {   /* BLE 全量 OTA：开始传输 */
        if (sfx_rx_active() || audio_get_state() != AUDIO_STATE_STOPPED) {
            ble_notify_data("OTA,ERR,8");   /* 忙碌：播放/传输中 */
            break;
        }
        char reply[24];
        /* data[0] 为命令字节，参数从 data[1] 开始（与 SFX/WIFI 等命令一致） */
        esp_err_t err = ota_mgr_ble_begin(data + 1, (uint16_t)(len - 1),
                                          reply, sizeof(reply));
        ble_notify_data(reply);
        ESP_LOGI(TAG, "cmd: ota begin -> %s (err=%d)", reply, (int)err);
        break;
    }
    case BLE_CMD_OTA_QUERY: {   /* 查询 OTA 状态/断点 */
        char reply[64];
        ota_mgr_ble_query(reply, sizeof(reply));
        ble_notify_data(reply);
        ESP_LOGI(TAG, "cmd: ota query -> %s", reply);
        break;
    }
    case BLE_CMD_OTA_APPLY: {   /* 应用：终验 + 切换槽 + 重启 */
        char reply[24];
        esp_err_t err = ota_mgr_ble_apply(reply, sizeof(reply));
        ble_notify_data(reply);
        ESP_LOGI(TAG, "cmd: ota apply -> %s (err=%d)", reply, (int)err);
        break;
    }
    case BLE_CMD_OTA_ABORT: {   /* 中止传输 */
        ota_mgr_ble_abort("app");
        ble_notify_data("OTA,ABORTED");
        ESP_LOGI(TAG, "cmd: ota aborted");
        break;
    }
    case BLE_CMD_OTA_NOW: {     /* 触发 WiFi 网络通道立即检查（P1） */
        if (!wifi_mgr_is_connected()) {
            ble_notify_data("OTA,NOW,NOWIFI");
            ESP_LOGW(TAG, "cmd: ota now, wifi not connected");
            break;
        }
        char reply[24];
        esp_err_t err = ota_mgr_net_start(reply, sizeof(reply));
        ble_notify_data(reply);
        ESP_LOGI(TAG, "cmd: ota now -> %s (err=%d)", reply, (int)err);
        break;
    }

    default:
        ESP_LOGW(TAG, "unknown cmd 0x%02x", cmd);
        break;
    }
}

/* ---- 生成动态设备名：<基础名>_<公共MAC后6位字符> ---- */
static void make_device_name(void)
{
    const uint8_t *addr = esp_bt_dev_get_address();
    if (addr == NULL) {
        snprintf(s_device_name, sizeof(s_device_name), "%s", DEVICE_BASE_NAME);
    } else {
        snprintf(s_device_name, sizeof(s_device_name), "%s_%02X%02X%02X",
                 DEVICE_BASE_NAME, addr[3], addr[4], addr[5]);
    }
    size_t n = strlen(s_device_name);
    if (n == 0 || n >= sizeof(s_device_name)) {
        ESP_LOGE(TAG, "invalid device name, fallback to base");
        snprintf(s_device_name, sizeof(s_device_name), "%s", DEVICE_BASE_NAME);
    }
    ESP_LOGI(TAG, "device name: %s (MAC %02X:%02X:%02X:%02X:%02X:%02X)",
             s_device_name,
             addr ? addr[0] : 0, addr ? addr[1] : 0, addr ? addr[2] : 0,
             addr ? addr[3] : 0, addr ? addr[4] : 0, addr ? addr[5] : 0);
}

/* ---- 启动广播 ---- */
static void start_advertising(void)
{
    esp_ble_adv_params_t adv_params = {
        .adv_int_min        = 0x100,   /* 0x100 = 256 * 0.625ms ≈ 160ms */
        .adv_int_max        = 0x200,   /* 0x200 = 512 * 0.625ms ≈ 320ms */
        .adv_type           = ADV_TYPE_IND,
        .own_addr_type      = BLE_ADDR_TYPE_PUBLIC,
        .channel_map        = ADV_CHNL_ALL,
        .adv_filter_policy  = ADV_FILTER_ALLOW_SCAN_ANY_CON_ANY,
    };
    esp_err_t err = esp_ble_gap_start_advertising(&adv_params);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "start adv fail %d", err);
    } else {
        ESP_LOGI(TAG, "advertising as %s", s_device_name);
    }
}

/* ---- GAP 回调 ---- */
static void gap_event_handler(esp_gap_ble_cb_event_t event, esp_ble_gap_cb_param_t *param)
{
    ESP_LOGI(TAG, "GAP event=%d", (int)event);

    switch (event) {
    case ESP_GAP_BLE_ADV_DATA_SET_COMPLETE_EVT:
        ESP_LOGI(TAG, "GAP: adv_data_set_complete status=%d",
                 param->adv_data_cmpl.status);
        break;
    case ESP_GAP_BLE_SCAN_RSP_DATA_SET_COMPLETE_EVT:
        ESP_LOGI(TAG, "GAP: scan_rsp_set_complete status=%d",
                 param->scan_rsp_data_cmpl.status);
        start_advertising();
        break;
    case ESP_GAP_BLE_ADV_START_COMPLETE_EVT:
        if (param->adv_start_cmpl.status != ESP_BT_STATUS_SUCCESS) {
            ESP_LOGE(TAG, "adv start failed, status=%d", param->adv_start_cmpl.status);
        } else {
            ESP_LOGI(TAG, "adv start success, advertising as %s", s_device_name);
        }
        break;
    case ESP_GAP_BLE_ADV_STOP_COMPLETE_EVT:
        ESP_LOGI(TAG, "adv stop");
        break;
    case ESP_GAP_BLE_UPDATE_CONN_PARAMS_EVT:
        ESP_LOGI(TAG, "conn params: int=%"PRIu16" lat=%"PRIu16" to=%"PRIu16" min_int=%"PRIu16" max_int=%"PRIu16" status=%d",
                 param->update_conn_params.conn_int,
                 param->update_conn_params.latency,
                 param->update_conn_params.timeout,
                 param->update_conn_params.min_int,
                 param->update_conn_params.max_int,
                 (int)param->update_conn_params.status);
        break;
    case ESP_GAP_BLE_SET_LOCAL_PRIVACY_COMPLETE_EVT:
    default:
        break;
    }
}

/* ---- GATT Server 回调 ---- */
static void gatts_event_handler(esp_gatts_cb_event_t event, esp_gatt_if_t gatts_if,
                                esp_ble_gatts_cb_param_t *param)
{
    ESP_LOGD(TAG, "gatts event=%d if=%d", (int)event, (int)gatts_if);

    if (event == ESP_GATTS_REG_EVT) {
        ESP_LOGI(TAG, "GATTS REG_EVT: status=%d app_id=%d gatts_if=%d",
                 (int)param->reg.status, (int)param->reg.app_id, (int)gatts_if);
        if (param->reg.status != ESP_GATT_OK) {
            ESP_LOGE(TAG, "reg app failed %d", param->reg.status);
            return;
        }
        s_gatts_if = gatts_if;

        /* 注册服务属性表 */
        esp_err_t err = esp_ble_gatts_create_attr_tab(s_gatts_db, gatts_if, HRS_IDX_NB, 0);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "create attr tab fail %d", err);
        } else {
            ESP_LOGI(TAG, "create_attr_tab requested, HRS_IDX_NB=%d", HRS_IDX_NB);
        }
        return;
    }

    if (event == ESP_GATTS_CREAT_ATTR_TAB_EVT) {
        ESP_LOGI(TAG, "CREAT_ATTR_TAB_EVT status=%d num_handle=%d",
                 (int)param->add_attr_tab.status, (int)param->add_attr_tab.num_handle);
        if (param->add_attr_tab.status != ESP_GATT_OK) {
            ESP_LOGE(TAG, "create attr tab status=%d", param->add_attr_tab.status);
            return;
        }
        if (param->add_attr_tab.num_handle != HRS_IDX_NB) {
            ESP_LOGE(TAG, "attr tab num handle mismatch");
            return;
        }
        uint16_t *handle = param->add_attr_tab.handles;
        s_svc_handle        = handle[IDX_SVC];
        s_ctrl_handle       = handle[IDX_CHAR_VAL_CTRL];
        s_audio_handle      = handle[IDX_CHAR_VAL_AUDIO];
        s_status_handle     = handle[IDX_CHAR_VAL_STATUS];
        s_status_ccc_handle = handle[IDX_CHAR_DESC_CCC];
        s_data_handle       = handle[IDX_CHAR_VAL_DATA];
        s_data_ccc_handle   = handle[IDX_CHAR_DESC_CCC_DATA];
        ESP_LOGI(TAG, "attr tab ok: svc=%u ctrl=%u audio=%u status=%u ccc=%u data=%u",
                 (unsigned)s_svc_handle, (unsigned)s_ctrl_handle,
                 (unsigned)s_audio_handle, (unsigned)s_status_handle,
                 (unsigned)s_status_ccc_handle, (unsigned)s_data_handle);

        /* 启动服务 */
        esp_err_t err = esp_ble_gatts_start_service(s_svc_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "start svc fail %d", err);
            return;
        }
        ESP_LOGI(TAG, "start_service ok svc=%u", (unsigned)s_svc_handle);

        /* 设置广播数据：主广播仅带 Flags+TxPower（≤31B）。
         * 注：设备名(HAOMIAN-SLEEP_XXXXXX = 21B) + service uuid + flag + txpower
         * 加起来超出 Legacy 广播 31B 上限会触发 ESP_ERR_INVALID_ARG。
         * 所以把名称和 service uuid 只放在扫描响应（scan_rsp）里。 */
        esp_ble_adv_data_t adv_data = {
            .set_scan_rsp        = false,
            .include_name        = false,
            .include_txpower     = true,
            .min_interval        = 0x100,
            .max_interval        = 0x200,
            .appearance          = 0,
            .manufacturer_len    = 0,
            .p_manufacturer_data = NULL,
            .service_data_len    = 0,
            .p_service_data      = NULL,
            .service_uuid_len    = 0,
            .p_service_uuid      = NULL,
            .flag                = (ESP_BLE_ADV_FLAG_GEN_DISC | ESP_BLE_ADV_FLAG_BREDR_NOT_SPT),
        };
        esp_err_t e1 = esp_ble_gap_config_adv_data(&adv_data);
        ESP_LOGI(TAG, "config adv_data -> %s(0x%x)", esp_err_to_name(e1), e1);

        esp_ble_adv_data_t scan_rsp = {
            .set_scan_rsp        = true,
            .include_name        = true,
            .include_txpower     = true,
            .appearance          = 0,
            .manufacturer_len    = 0,
            .p_manufacturer_data = NULL,
            .service_data_len    = 0,
            .p_service_data      = NULL,
            /* scan_rsp 也受 31B 限制：
             *   name(HAOMIAN-SLEEP_D6C2A6 = 21) + type(1) + length(1)
             * + txpower(1) + type(1) + length(1)
             * = 26B ≤ 31B，安全；若再加入 service uuid 则超出。 */
            .service_uuid_len    = 0,
            .p_service_uuid      = NULL,
        };
        esp_err_t e2 = esp_ble_gap_config_adv_data(&scan_rsp);
        ESP_LOGI(TAG, "config scan_rsp -> %s(0x%x)", esp_err_to_name(e2), e2);
        return;
    }

    if (event == ESP_GATTS_CONNECT_EVT) {
        s_connected = true;
        s_conn_id   = param->connect.conn_id;
        ESP_LOGI(TAG, "connected, conn_id=%u", (unsigned)s_conn_id);
        return;
    }
    if (event == ESP_GATTS_DISCONNECT_EVT) {
        s_connected = false;
        s_conn_id = 0;
        s_status_notify_enable = false;
        s_data_notify_enable = false;
        if (sfx_rx_active()) sfx_rx_abort("disconnect");   /* 丢弃半截传输 */
        haptic_erm_set(0);               /* 安全：断连后 ERM 不得继续震动 */
        mic_diag(false);                 /* 停止麦克风诊断上报 */
        ESP_LOGI(TAG, "disconnected, reason=%d", param->disconnect.reason);
        start_advertising();
        return;
    }

    if (event == ESP_GATTS_WRITE_EVT) {
        uint16_t handle = param->write.handle;
        uint16_t len    = param->write.len;
        uint8_t *data   = param->write.value;
        bool need_rsp   = !param->write.is_prep && param->write.need_rsp;

        if (handle == s_ctrl_handle) {
            handle_control(data, len);
        } else if (handle == s_audio_handle) {
            if (ota_mgr_busy()) {
                /* OTA 升级数据帧：[0xA1][seq][len u16][offset u32][payload][crc16] */
                if (len >= OTA_FRAME_HDR_LEN && data[0] == OTA_PKT_DATA) {
                    uint16_t plen      = rd16(data + 2);
                    uint32_t frame_off = rd32(data + 4);
                    if ((uint16_t)(OTA_FRAME_HDR_LEN + plen) > len) {
                        ble_notify_data("OTA,ERR,5");   /* 长度非法 */
                    } else {
                        uint16_t expect_crc = rd16(data + OTA_FRAME_HDR_LEN + plen - 2);
                        /* crc16 覆盖 seq+len+offset+payload = data[1..7+plen] */
                        uint16_t calc_crc = crc16_arc(data + 1, (size_t)(7 + plen));
                        if (calc_crc != expect_crc) {
                            ble_notify_data("OTA,ERR,2");   /* 帧 CRC 错 */
                        } else if ((uint32_t)data[1] != (ota_mgr_rx_seq() & 0xFFu)) {
                            char r[28];
                            snprintf(r, sizeof(r), "NAK,%u,%u",
                                     (unsigned)(ota_mgr_rx_seq() & 0xFFu), (unsigned)data[1]);
                            ble_notify_data(r);   /* 序号不连续（u8 回绕） */
                        } else if (frame_off != ota_mgr_rx_written()) {
                            ble_notify_data("OTA,ERR,5");   /* 偏移不连续 */
                            /* 防漂移：偏移偏离时中止，让手机从 OTA_QUERY 重新对齐 */
                            ota_mgr_ble_abort("offset");
                        } else {
                            esp_err_t err = ota_mgr_ble_data(data + 8, plen);
                            if (err != ESP_OK) {
                                ota_mgr_ble_abort(esp_err_to_name(err));
                                ble_notify_data("OTA,ERR,4");   /* 写入失败 */
                            }
                        }
                    }
                } else {
                    ble_notify_data("OTA,ERR,5");
                }
            } else if (sfx_rx_active()) {
                /* 音效文件传输帧：[0xA0][seq][len u16][payload][crc16] */
                if (len >= 6 && data[0] == SFX_PKT_DATA) {
                    uint16_t plen = rd16(data + 2);
                    if ((uint16_t)(6 + plen) <= len) {
                        uint16_t expect_crc = rd16(data + 4 + plen);
                        uint16_t calc_crc = crc16_arc(data + 1, (size_t)(3 + plen));
                        if (calc_crc != expect_crc) {
                            char r[24];
                            snprintf(r, sizeof(r), "CRCERR,%u",
                                     (unsigned)(sfx_rx_seq() & 0xFFu));
                            ble_notify_data(r);
                        } else if ((uint32_t)data[1] != (sfx_rx_seq() & 0xFFu)) {
                            /* 序号不连续：告知期望值（按 u8 回绕），小程序从窗口重发 */
                            char r[28];
                            snprintf(r, sizeof(r), "NAK,%u,%u",
                                     (unsigned)(sfx_rx_seq() & 0xFFu), (unsigned)data[1]);
                            ble_notify_data(r);
                        } else {
                            esp_err_t err = sfx_rx_data(data + 4, plen);
                            if (err != ESP_OK) {
                                sfx_rx_abort(esp_err_to_name(err));
                                ble_notify_data("RXERR,write");
                            }
                        }
                    }
                }
            } else {
                /* 兼容旧的实时 PCM 推流：丢弃最后一个奇数字节保证 16bit 对齐 */
                if (len % 2 != 0) len--;
                audio_feed(data, len);
            }
        } else if (handle == s_data_ccc_handle) {
            s_data_notify_enable = (len >= 2 && data[0] & 0x01);
            ESP_LOGI(TAG, "data notify %s", s_data_notify_enable ? "ON" : "OFF");
        } else if (handle == s_status_ccc_handle) {
            /* 客户端写 CCCD：启用/停用 notify */
            s_status_notify_enable = (len >= 2 && data[0] & 0x01);
            ESP_LOGI(TAG, "status notify %s", s_status_notify_enable ? "ON" : "OFF");
        } else {
            ESP_LOGW(TAG, "write to unknown handle %u len=%u", (unsigned)handle, (unsigned)len);
        }

        if (need_rsp) {
            esp_ble_gatts_send_response(gatts_if, param->write.conn_id,
                                        param->write.trans_id, ESP_GATT_OK, NULL);
        }
        return;
    }

    if (event == ESP_GATTS_READ_EVT) {
        if (!param->read.need_rsp) return;
        esp_gatt_rsp_t rsp = {0};
        uint16_t handle = param->read.handle;
        uint16_t *len = &rsp.attr_value.len;

        if (handle == s_status_handle) {
            const char *state = (audio_get_state() == AUDIO_STATE_PLAYING) ? "PLAYING" : "IDLE";
            size_t l = strlen(state);
            if (l > sizeof(rsp.attr_value.value)) l = sizeof(rsp.attr_value.value);
            memcpy(rsp.attr_value.value, state, l);
            *len = (uint16_t)l;
        } else if (handle == s_data_handle) {
            const char *state = sfx_rx_active() ? "RXACTIVE" : "IDLE";
            size_t l = strlen(state);
            memcpy(rsp.attr_value.value, state, l);
            *len = (uint16_t)l;
        } else {
            *len = 0;
        }
        esp_ble_gatts_send_response(gatts_if, param->read.conn_id,
                                    param->read.trans_id, ESP_GATT_OK, &rsp);
        return;
    }

    if (event == ESP_GATTS_EXEC_WRITE_EVT) {
        /* exec_write 参数不带 need_rsp；此处为兼容性静默忽略即可（
         * 属性声明均使用 ESP_GATT_AUTO_RSP，底层已自动处理响应）。 */
        (void)param;
        return;
    }

    /* 其它事件忽略 */
    (void)param;
}

/* ------------------------------------------------------------------ */

esp_err_t ble_init(void)
{
    /* 麦克风诊断上报桥接：mic 组件不直接依赖 ble，经回调把 MIC 行推到 0xFF04 */
    mic_set_report_cb(ble_notify_data);

    /* WiFi 状态上报桥接：wifi_mgr 状态经回调推到 0xFF04 */
    wifi_mgr_set_event_cb(ble_notify_data);

    /* MQTT 状态上报桥接：mqtt_mgr 连接状态经回调推到 0xFF04 */
    mqtt_mgr_set_event_cb(ble_notify_data);

    /* 仅 ESP32（含经典蓝牙）需要释放 CLASSIC_BT 内存区；ESP32-S3 无此区域，
     * 若执行该调用会失败并污染控制器状态，故按 target 条件执行。 */
#if defined(CONFIG_IDF_TARGET_ESP32)
    {
        esp_err_t rc = esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
        ESP_LOGI(TAG, "release CLASSIC_BT mem: %s (0x%x)", esp_err_to_name(rc), rc);
    }
#endif

    esp_bt_controller_config_t bt_cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
    esp_err_t err = esp_bt_controller_init(&bt_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "controller_init fail: %s (0x%x)", esp_err_to_name(err), err);
        return err;
    }
    ESP_LOGI(TAG, "controller_init ok");

    err = esp_bt_controller_enable(ESP_BT_MODE_BLE);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "controller_enable(BLE) fail: %s (0x%x)", esp_err_to_name(err), err);
        return err;
    }
    ESP_LOGI(TAG, "controller_enable(BLE) ok");

    err = esp_bluedroid_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "bluedroid_init fail: %s (0x%x)", esp_err_to_name(err), err);
        return err;
    }
    ESP_LOGI(TAG, "bluedroid_init ok");

    err = esp_bluedroid_enable();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "bluedroid_enable fail: %s (0x%x)", esp_err_to_name(err), err);
        return err;
    }
    ESP_LOGI(TAG, "bluedroid_enable ok");

    /* 取公共地址 -> 生成设备名 -> 设置 GAP 设备名 */
    make_device_name();
    esp_ble_gap_set_device_name(s_device_name);

    /* 注册 GAP 回调（广播/连接参数等） */
    err = esp_ble_gap_register_callback(gap_event_handler);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gap reg cb fail %d", err);
        return err;
    }
    ESP_LOGI(TAG, "gap_register_callback ok");

    err = esp_ble_gatts_register_callback(gatts_event_handler);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gatts cb reg fail %d", err);
        return err;
    }
    ESP_LOGI(TAG, "gatts_register_callback ok");

    /* 注册 GATTS 应用 ID：0x00AA。回调会立刻收到 ESP_GATTS_REG_EVT。 */
    err = esp_ble_gatts_app_register(0x00AA);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gatts_app_register fail %d", err);
        return err;
    }
    ESP_LOGI(TAG, "gatts_app_register(0x00AA) ok");

    /* MTU 协商时支持更大帧（配合 sdkconfig BLE_LARGE_MTU 默认 517） */
    {
        esp_err_t mtu_err = esp_ble_gatt_set_local_mtu(512);
        if (mtu_err != ESP_OK) {
            ESP_LOGW(TAG, "set local mtu 512 fail %d", mtu_err);
        } else {
            ESP_LOGI(TAG, "set local mtu 512 ok");
        }
    }

    /* 注册 sfx → BLE 推送桥接（传输进度 / 播放事件经 0xFF04 下发） */
    sfx_set_progress_cb(sfx_progress_bridge);
    sfx_set_event_cb(sfx_event_bridge);

    /* 注册 OTA → BLE 进度推送（OTA,PROG,<off>,<total>） */
    ota_mgr_set_progress_cb(ota_progress_bridge);

    /* 注册网络 OTA → BLE 事件推送（OTA,NET,CHECK/DONE/ERR,...） */
    ota_mgr_net_set_event_cb(ble_notify_data);

    ESP_LOGI(TAG, "ble init ok");
    return ESP_OK;
}

void ble_notify_status(const char *msg)
{
    if (!s_connected || msg == NULL) return;
    if (!s_status_notify_enable) return;
    if (s_gatts_if == ESP_GATT_IF_NONE) return;

    uint16_t len = (uint16_t)strlen(msg);
    if (len > ESP_GATT_MAX_ATTR_LEN) len = ESP_GATT_MAX_ATTR_LEN;

    esp_ble_gatts_send_indicate(s_gatts_if, s_conn_id, s_status_handle,
                                len, (uint8_t *)msg, false);
}
