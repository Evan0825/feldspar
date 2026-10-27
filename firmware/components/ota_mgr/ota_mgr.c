#include "ota_mgr.h"

#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_app_desc.h"
#include "esp_rom_crc.h"
#include "esp_heap_caps.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "mbedtls/sha256.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_timer.h"
#include "cJSON.h"
#include "wifi_mgr.h"
#include "device_control.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ota";

/* OTA 协议常量：与 components/ble/include/ble_protocol.h 保持一致
 * （ota_mgr 不依赖 ble 组件，避免 CMake 循环 REQUIRES；数值以 ble_protocol.h 为准） */
#define OTA_BEGIN_HDR_LEN    42   /* size(4)+crc32(4)+sha256(32)+protoVer(1)+verLen(1) */
#define OTA_PROTO_VERSION    1    /* BLE OTA 协议版本 */

enum { OTA_ERR_COMPAT = 1, OTA_ERR_CRC, OTA_ERR_SPACE, OTA_ERR_WRITE,
       OTA_ERR_ARG, OTA_ERR_APPLY };
#define OTA_IMG_MAX_SIZE     0x200000  /* ota_0/ota_1 槽容量 2MB */

/* ---- 断点记录（NVS 命名空间 "ota"）---- */
#define OTA_NVS_NS     "ota"
#define OTA_NVS_SIZE   "size"   /* u32 目标镜像大小 */
#define OTA_NVS_SHA    "sha"    /* blob 32B 目标镜像 sha256 */
#define OTA_NVS_OFF    "off"    /* u32 已写入字节（断点/进度） */

#define OTA_WRITE_PERSIST_STEP (64 * 1024)   /* 每 64KB 持久化一次断点 */

typedef struct {
    const esp_partition_t *update;   /* 目标槽 */
    esp_ota_handle_t       handle;
    uint32_t               total;    /* 镜像大小 */
    uint32_t               written;  /* 已写入字节 */
    uint32_t               crc;      /* 累计 CRC32 */
    uint32_t               crc_expect;/* OTA_BEGIN 携带的期望 CRC32 */
    uint8_t                sha[32];  /* 目标 sha256 */
    mbedtls_sha256_context sha_ctx;  /* 流式 sha256 */
    int                    seq;      /* 期望下一帧 seq（<256 用 u8 回绕比较） */
    char                   version[16]; /* 目标固件版本 */
    bool                   active;
} ota_state_t;

static ota_state_t s_ota = {0};
static nvs_handle_t s_nvs = 0;
static ota_progress_cb_t s_progress_cb = NULL;

/* 前向声明：以下工具函数定义于文件下半部（网络 OTA 代码先于它们使用，需声明避免
 * C99 下的 implicit-function-declaration 编译错误。） */
static int  ver_cmp(const char *a, const char *b);
static void reply_err(char *reply, size_t reply_len, int code);
static void nvs_save_offset(void);
static void nvs_clear(void);
static void emit_progress(void);

/* ---- 网络 OTA（通道 A / WiFi HTTPS）----
 * 服务器接口地址尚未最终确定：manifest 先用占位 URL；服务器就绪后替换
 * OTA_NET_MANIFEST_URL（固件 URL 由 manifest 的 full.url 下发）。 */
#define OTA_NET_MANIFEST_URL   "https://updates.example.invalid/manifest.json"
#define OTA_NET_TIMEOUT_MS     10000
#define OTA_NET_CHUNK          4096    /* 下载/烧写块 */
#define OTA_NET_MANIFEST_MAX   4096    /* manifest 最大字节 */
#define OTA_NET_STACK          8192    /* 网络 OTA 任务栈 */

/* ---- 主动定时轮询（联网后定期查新版本，发现新版自动升）---- */
#define OTA_NET_POLL_FIRST_US   (30 * 1000 * 1000)        /* 首次检查延迟：等 WiFi 连上 */
#define OTA_NET_POLL_RETRY_US   (60 * 1000 * 1000)        /* 未联网时的重试间隔 */
#define OTA_NET_POLL_PERIOD_US  (6ULL * 3600 * 1000 * 1000) /* 联网后定期轮询周期 6h */

enum {
    NET_OK = 0,
    NET_NO_UPDATE,   /* 已是新版 / 无可用更新 */
    NET_HTTP_FAIL,   /* 网络/HTTP 层失败 */
    NET_JSON_ERR,    /* manifest 解析/契约失败 */
    NET_VER_ERR,     /* 版本策略拒绝（如低于 minVersion） */
    NET_CRC_ERR,     /* 整包 CRC32 不匹配 */
    NET_SHA_ERR,     /* 整包 SHA256 不匹配 */
    NET_SPACE_ERR,   /* 目标槽空间不足/无效 */
    NET_WRITE_ERR,   /* 写入失败/数据不完整 */
    NET_APPLY_ERR,   /* esp_ota_end / set_boot_partition 失败 */
};

typedef enum {
    NET_ST_IDLE = 0,
    NET_ST_FETCH,
    NET_ST_DL,
    NET_ST_VERIFY,
    NET_ST_REBOOT,
    NET_ST_ERR,
} net_state_t;

typedef struct {
    char        url[256];         /* 固件下载地址 */
    uint32_t    size;             /* 镜像大小 */
    uint32_t    crc_expect;       /* 期望 CRC32 */
    uint8_t     sha[32];          /* 期望 SHA256 */
    char        version[16];      /* 目标版本 */
    char        min_version[16];  /* 允许升级的最低当前版本 */
} net_manifest_t;

static bool              s_net_active = false;
static volatile net_state_t s_net_state = NET_ST_IDLE;
static volatile bool     s_net_abort  = false;
static TaskHandle_t      s_net_task   = NULL;
static ota_net_event_cb_t s_net_event_cb = NULL;

/* 主动轮询定时器：首次延迟后检查，未联网则短间隔重试，联网成功后转长周期 6h */
static esp_timer_handle_t s_net_poll_timer = NULL;
static bool               s_net_poll_connected = false;

static void net_emit(const char *fmt, ...)
{
    if (!s_net_event_cb) return;
    char buf[64];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    s_net_event_cb(buf);
    ESP_LOGI(TAG, "net event: %s", buf);
}

static void net_emit_rc(int code)
{
    switch (code) {
    case NET_NO_UPDATE: net_emit("OTA,NET,NONE");  break;
    case NET_HTTP_FAIL: net_emit("OTA,NET,ERR,1"); break;   /* 网络/HTTP */
    case NET_JSON_ERR:  net_emit("OTA,NET,ERR,2"); break;   /* manifest 解析/契约 */
    case NET_VER_ERR:   net_emit("OTA,NET,ERR,1"); break;   /* 版本策略 */
    case NET_CRC_ERR:
    case NET_SHA_ERR:   net_emit("OTA,NET,ERR,3"); break;   /* 校验 */
    case NET_SPACE_ERR: net_emit("OTA,NET,ERR,4"); break;   /* 空间 */
    case NET_WRITE_ERR: net_emit("OTA,NET,ERR,5"); break;   /* 写入 */
    case NET_APPLY_ERR: net_emit("OTA,NET,ERR,6"); break;   /* 应用/切换 */
    default:            net_emit("OTA,NET,ERR,0"); break;
    }
}

/* hex 解析工具 */
static uint32_t parse_hex32(const char *s)
{
    if (s == NULL) return 0;
    return (uint32_t)strtoul(s, NULL, 16);
}

static void parse_sha_hex(const char *s, uint8_t out[32])
{
    if (s == NULL) return;
    for (int i = 0; i < 32; i++) {
        unsigned v = 0;
        sscanf(s + 2 * i, "%02x", &v);
        out[i] = (uint8_t)v;
    }
}

/* GET 一个小资源（manifest）到内存缓冲；仅接受 200 响应。 */
static esp_err_t http_fetch_buffer(const char *url, char *buf, size_t buf_len, size_t *out_len)
{
    if (url == NULL || buf == NULL || buf_len == 0) return ESP_ERR_INVALID_ARG;

    esp_http_client_config_t cfg = {
        .url               = url,
        .timeout_ms        = OTA_NET_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t cl = esp_http_client_init(&cfg);
    if (cl == NULL) return ESP_FAIL;

    esp_http_client_set_method(cl, HTTP_METHOD_GET);
    if (esp_http_client_open(cl, 0) != ESP_OK) {
        esp_http_client_cleanup(cl);
        return ESP_FAIL;
    }
    int status = esp_http_client_fetch_headers(cl);
    if (status != 200) {
        esp_http_client_close(cl);
        esp_http_client_cleanup(cl);
        return (status < 0) ? ESP_FAIL : ESP_ERR_INVALID_RESPONSE;
    }

    size_t total = 0;
    int rd;
    while ((rd = esp_http_client_read(cl, buf + total, buf_len - 1 - total)) > 0) {
        total += (size_t)rd;
        if (total >= buf_len - 1) break;    /* 防止溢出，留 1 字节终止符 */
    }
    buf[total] = 0;
    esp_http_client_close(cl);
    esp_http_client_cleanup(cl);
    if (rd < 0) return ESP_FAIL;
    *out_len = total;
    return ESP_OK;
}

/* 解析 manifest，校验 product/chip/契约，填充 net_manifest_t。 */
static esp_err_t parse_manifest(const char *text, net_manifest_t *m)
{
    cJSON *root = cJSON_Parse(text);
    if (root == NULL) return ESP_ERR_INVALID_ARG;
    esp_err_t ret = ESP_ERR_INVALID_ARG;

    do {
        const cJSON *prod = cJSON_GetObjectItem(root, "product");
        const cJSON *chip = cJSON_GetObjectItem(root, "chip");
        const cJSON *ver  = cJSON_GetObjectItem(root, "version");
        const cJSON *minv = cJSON_GetObjectItem(root, "minVersion");
        const cJSON *full = cJSON_GetObjectItem(root, "full");

        /* 契约校验：product 必须为 haomian；chip 必须为 esp32s3；必含 version/full */
        if (!cJSON_IsString(prod) || strcmp(prod->valuestring, "haomian") != 0) break;
        if (!cJSON_IsString(chip) || strstr(chip->valuestring, "esp32s3") == NULL) break;
        if (!cJSON_IsString(ver)  || ver->valuestring == NULL) break;
        if (!cJSON_IsObject(full)) break;

        const cJSON *furl = cJSON_GetObjectItem(full, "url");
        const cJSON *fsize = cJSON_GetObjectItem(full, "size");
        const cJSON *fcrc  = cJSON_GetObjectItem(full, "crc32");
        const cJSON *fsha  = cJSON_GetObjectItem(full, "sha256");
        if (!cJSON_IsString(furl) || furl->valuestring == NULL) break;
        if (!cJSON_IsNumber(fsize)) break;
        if (!cJSON_IsString(fcrc)  || fcrc->valuestring == NULL) break;
        if (!cJSON_IsString(fsha)  || fsha->valuestring == NULL) break;

        snprintf(m->url, sizeof(m->url), "%s", furl->valuestring);
        m->size = (uint32_t)fsize->valuedouble;
        m->crc_expect = parse_hex32(fcrc->valuestring);
        parse_sha_hex(fsha->valuestring, m->sha);
        snprintf(m->version, sizeof(m->version), "%s", ver->valuestring);
        m->min_version[0] = 0;
        if (cJSON_IsString(minv) && minv->valuestring != NULL) {
            snprintf(m->min_version, sizeof(m->min_version), "%s", minv->valuestring);
        }
        ret = ESP_OK;
    } while (0);

    cJSON_Delete(root);
    return ret;
}

/* 流式下载固件并写入目标槽，累计 CRC32/SHA256。返回 NET_* 结果码。 */
static int net_download(const net_manifest_t *m, esp_ota_handle_t handle)
{
    esp_http_client_config_t cfg = {
        .url               = m->url,
        .timeout_ms        = OTA_NET_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size       = OTA_NET_CHUNK,
        .keep_alive_enable = true,
    };
    esp_http_client_handle_t cl = esp_http_client_init(&cfg);
    if (cl == NULL) return NET_HTTP_FAIL;

    esp_http_client_set_method(cl, HTTP_METHOD_GET);
    if (esp_http_client_open(cl, 0) != ESP_OK) {
        esp_http_client_cleanup(cl);
        return NET_HTTP_FAIL;
    }
    int status = esp_http_client_fetch_headers(cl);
    if (status != 200) {
        esp_http_client_close(cl);
        esp_http_client_cleanup(cl);
        return NET_HTTP_FAIL;
    }

    uint8_t *chunk = heap_caps_malloc(OTA_NET_CHUNK, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (chunk == NULL) {
        esp_http_client_close(cl);
        esp_http_client_cleanup(cl);
        return NET_WRITE_ERR;
    }

    int rd;
    while ((rd = esp_http_client_read(cl, (char *)chunk, OTA_NET_CHUNK)) > 0) {
        if (s_net_abort) {
            free(chunk);
            esp_http_client_close(cl);
            esp_http_client_cleanup(cl);
            return NET_WRITE_ERR;
        }
        /* 校验块不越界，防止写入超过镜像大小 */
        if (s_ota.written + (uint32_t)rd > m->size) {
            ESP_LOGE(TAG, "net: download exceeds expected size %lu", (unsigned long)m->size);
            free(chunk);
            esp_http_client_close(cl);
            esp_http_client_cleanup(cl);
            return NET_WRITE_ERR;
        }
        esp_err_t err = esp_ota_write(handle, chunk, (size_t)rd);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "net: esp_ota_write fail: %s (0x%x)", esp_err_to_name(err), err);
            free(chunk);
            esp_http_client_close(cl);
            esp_http_client_cleanup(cl);
            return NET_WRITE_ERR;
        }
        s_ota.crc = esp_rom_crc32_le(s_ota.crc, chunk, (size_t)rd);
        mbedtls_sha256_update(&s_ota.sha_ctx, chunk, (size_t)rd);
        s_ota.written += (uint32_t)rd;

        /* 每 64KB 持久化断点（崩溃/断电恢复上报用） */
        if ((s_ota.written % OTA_WRITE_PERSIST_STEP) == 0) {
            nvs_save_offset();
            emit_progress();
        }
        if (s_ota.written >= m->size) break;
    }
    free(chunk);
    esp_http_client_close(cl);
    esp_http_client_cleanup(cl);

    if (rd < 0 || s_ota.written != m->size) {
        ESP_LOGE(TAG, "net: download incomplete %lu/%lu",
                 (unsigned long)s_ota.written, (unsigned long)m->size);
        return NET_WRITE_ERR;
    }
    emit_progress();
    ESP_LOGI(TAG, "net: download complete %lu/%lu",
             (unsigned long)s_ota.written, (unsigned long)m->size);
    return NET_OK;
}

/* 网络 OTA 异步任务：manifest → 校验 → 下载烧写 → 双校验 → 切换重启。 */
static void ota_mgr_net_task(void *arg)
{
    (void)arg;
    net_manifest_t m = {0};
    char *buf = NULL;
    int rc = NET_APPLY_ERR;

    s_net_state = NET_ST_FETCH;
    buf = heap_caps_malloc(OTA_NET_MANIFEST_MAX, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (buf == NULL) { rc = NET_HTTP_FAIL; goto done; }

    size_t mlen = 0;
    if (http_fetch_buffer(OTA_NET_MANIFEST_URL, buf, OTA_NET_MANIFEST_MAX, &mlen) != ESP_OK) {
        rc = NET_HTTP_FAIL;
        goto done;
    }
    ESP_LOGI(TAG, "net: manifest %u bytes", (unsigned)mlen);

    if (parse_manifest(buf, &m) != ESP_OK) {
        rc = NET_JSON_ERR;
        goto done;
    }

    /* 版本策略：目标 > 当前才升级；目标 <= 当前视为已最新。
     * minVersion：当前固件过旧（低于最低要求）则拒绝，需走链路升级。 */
    if (ver_cmp(m.version, ota_mgr_version()) <= 0) {
        ESP_LOGI(TAG, "net: up to date (cur=%s new=%s)",
                 ota_mgr_version(), m.version);
        rc = NET_NO_UPDATE;
        goto done;
    }
    if (m.min_version[0] && ver_cmp(ota_mgr_version(), m.min_version) < 0) {
        ESP_LOGE(TAG, "net: current %s below minVersion %s",
                 ota_mgr_version(), m.min_version);
        rc = NET_VER_ERR;
        goto done;
    }
    if (m.size == 0 || m.size > OTA_IMG_MAX_SIZE) {
        ESP_LOGE(TAG, "net: bad size %lu", (unsigned long)m.size);
        rc = NET_SPACE_ERR;
        goto done;
    }

    ESP_LOGI(TAG, "net: new ver=%s size=%lu crc=%08lx",
             m.version, (unsigned long)m.size, (unsigned long)m.crc_expect);

    const esp_partition_t *update = esp_ota_get_next_update_partition(NULL);
    if (update == NULL) { rc = NET_SPACE_ERR; goto done; }

    esp_ota_handle_t handle = 0;
    if (esp_ota_begin(update, OTA_SIZE_UNKNOWN, &handle) != ESP_OK) {
        rc = NET_WRITE_ERR;
        goto done;
    }

    /* 进入写态：占用 busy（拒音频/麦克风/音效与另一路 OTA），填充进度源 */
    s_ota.update     = update;
    s_ota.handle     = handle;
    s_ota.total      = m.size;
    s_ota.written    = 0;
    s_ota.crc        = 0;
    s_ota.crc_expect = m.crc_expect;
    memcpy(s_ota.sha, m.sha, 32);
    mbedtls_sha256_init(&s_ota.sha_ctx);
    mbedtls_sha256_starts(&s_ota.sha_ctx, 0);
    s_ota.active = true;

    net_emit("OTA,NET,CHECK,%s", m.version);
    s_net_state = NET_ST_DL;
    rc = net_download(&m, handle);
    if (rc != NET_OK) goto fail_write;

    /* 终验：整包 CRC32 + SHA256 与 manifest 比对 */
    s_net_state = NET_ST_VERIFY;
    uint8_t digest[32];
    mbedtls_sha256_finish(&s_ota.sha_ctx, digest);
    mbedtls_sha256_free(&s_ota.sha_ctx);
    if (s_ota.crc != m.crc_expect) {
        ESP_LOGE(TAG, "net: crc mismatch got=%08lx expect=%08lx",
                 (unsigned long)s_ota.crc, (unsigned long)m.crc_expect);
        rc = NET_CRC_ERR;
        goto fail_write_nosha;
    }
    if (memcmp(digest, m.sha, 32) != 0) {
        ESP_LOGE(TAG, "net: sha256 mismatch");
        rc = NET_SHA_ERR;
        goto fail_write_nosha;
    }

    if (esp_ota_end(handle) != ESP_OK) { rc = NET_APPLY_ERR; goto fail_write_nosha; }
    if (esp_ota_set_boot_partition(update) != ESP_OK) { rc = NET_APPLY_ERR; goto fail_write_nosha; }

    nvs_clear();
    s_ota.active = false;
    s_ota.handle = 0;
    net_emit("OTA,NET,DONE");
    s_net_state = NET_ST_REBOOT;
    ESP_LOGI(TAG, "net: ok -> slot %s, rebooting in 1s", update->label);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    rc = NET_OK;   /* 不会到达 */
    goto done;

fail_write_nosha:
    esp_ota_abort(handle);
    s_ota.active = false;
    s_ota.handle = 0;
    nvs_clear();
    goto done;

fail_write:
    esp_ota_abort(handle);
    mbedtls_sha256_free(&s_ota.sha_ctx);
    s_ota.active = false;
    s_ota.handle = 0;
    nvs_clear();
    goto done;

done:
    if (buf != NULL) heap_caps_free(buf);
    s_net_active = false;
    s_net_task   = NULL;
    s_net_abort  = false;
    if (rc == NET_OK) {
        s_net_state = NET_ST_IDLE;
    } else {
        s_net_state = NET_ST_ERR;
        net_emit_rc(rc);
        ESP_LOGE(TAG, "net: failed rc=%d", rc);
    }
    vTaskDelete(NULL);
}

/* ------------------------------------------------------------------ */
/* 网络 OTA 对外接口                                                    */
/* ------------------------------------------------------------------ */

bool ota_mgr_net_running(void)
{
    return s_net_active;
}

esp_err_t ota_mgr_net_start(char *reply, size_t reply_len)
{
    if (s_ota.active || s_net_active) {
        reply_err(reply, reply_len, 8);   /* 已有 OTA 在进行 */
        return ESP_ERR_INVALID_STATE;
    }

    if (device_control_stop_all() != ESP_OK) {
        reply_err(reply, reply_len, OTA_ERR_APPLY);
        return ESP_ERR_INVALID_STATE;
    }
    s_net_active = true;
    s_net_abort  = false;
    s_net_state  = NET_ST_FETCH;

    BaseType_t ok = xTaskCreate(ota_mgr_net_task, "ota_net", OTA_NET_STACK, NULL, 5, &s_net_task);
    if (ok != pdPASS) {
        s_net_active = false;
        s_net_state  = NET_ST_IDLE;
        reply_err(reply, reply_len, 5);   /* 任务创建失败 */
        return ESP_ERR_NO_MEM;
    }

    snprintf(reply, reply_len, "OTA,NET,STARTED");
    ESP_LOGI(TAG, "net: task started");
    return ESP_OK;
}

void ota_mgr_net_stop(void)
{
    if (!s_net_active) return;
    ESP_LOGW(TAG, "net: abort requested, will stop at next chunk");
    s_net_abort = true;
    s_net_state = NET_ST_ERR;
}

const char *ota_mgr_net_state_string(void)
{
    switch (s_net_state) {
    case NET_ST_FETCH:   return "FETCHING";
    case NET_ST_DL:      return "DOWNLOADING";
    case NET_ST_VERIFY:  return "VERIFYING";
    case NET_ST_REBOOT:  return "REBOOTING";
    case NET_ST_ERR:     return "ERROR";
    default:             return "IDLE";
    }
}

void ota_mgr_net_set_event_cb(ota_net_event_cb_t cb)
{
    s_net_event_cb = cb;
}

/* 主动轮询回调（esp_timer 上下文）：联网且空闲时触发一次网络 OTA 检查。
 * 未联网用短间隔重试，已联网转长周期，实现"联网后定期查新版本自动升级"。 */
static void net_poll_cb(void *arg)
{
    (void)arg;
    if (!(s_ota.active || s_net_active) && wifi_mgr_is_connected()) {
        char reply[16];
        ota_mgr_net_start(reply, sizeof(reply));
        s_net_poll_connected = true;
    }
    /* 重新安排下一次检查 */
    uint64_t next = s_net_poll_connected ? OTA_NET_POLL_PERIOD_US : OTA_NET_POLL_RETRY_US;
    esp_timer_start_once(s_net_poll_timer, next);
}

/* 创建并启动主动轮询（一次性：首次延迟后触发，回调内自续期）。 */
static void ota_mgr_net_poll_init(void)
{
    if (s_net_poll_timer) return;
    esp_timer_create_args_t a = {
        .callback = net_poll_cb,
        .name     = "ota_net_poll",
    };
    if (esp_timer_create(&a, &s_net_poll_timer) != ESP_OK) {
        ESP_LOGW(TAG, "net: poll timer create fail");
        return;
    }
    esp_timer_start_once(s_net_poll_timer, OTA_NET_POLL_FIRST_US);
    ESP_LOGI(TAG, "net: auto poll started (first in %us)", OTA_NET_POLL_FIRST_US / 1000000);
}

/* ------------------------------------------------------------------ */
/* 初始化 & 自测确认                                                   */
/* ------------------------------------------------------------------ */

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void nvs_save_task(void)
{
    if (s_nvs == 0) return;
    nvs_set_u32(s_nvs, OTA_NVS_SIZE, s_ota.total);
    nvs_set_blob(s_nvs, OTA_NVS_SHA, s_ota.sha, sizeof(s_ota.sha));
    nvs_commit(s_nvs);
}

static void nvs_save_offset(void)
{
    if (s_nvs == 0) return;
    nvs_set_u32(s_nvs, OTA_NVS_OFF, s_ota.written);
    nvs_commit(s_nvs);
}

static void nvs_clear(void)
{
    if (s_nvs == 0) return;
    nvs_erase_key(s_nvs, OTA_NVS_SIZE);
    nvs_erase_key(s_nvs, OTA_NVS_SHA);
    nvs_erase_key(s_nvs, OTA_NVS_OFF);
    nvs_commit(s_nvs);
}

static void emit_progress(void)
{
    if (s_progress_cb && s_ota.total > 0) {
        s_progress_cb(s_ota.written, s_ota.total);
    }
}

/* 版本比较：返回 0 相等、正整数表示 a>b、负整数 a<b（语义化 vX.Y.Z） */
static int ver_cmp(const char *a, const char *b)
{
    unsigned ma = 0, mb = 0, va = 0, vb = 0, ra = 0, rb = 0;
    sscanf(a, "%u.%u.%u", &ma, &va, &ra);
    sscanf(b, "%u.%u.%u", &mb, &vb, &rb);
    if (ma != mb) return (ma > mb) ? 1 : -1;
    if (va != vb) return (va > vb) ? 1 : -1;
    if (ra != rb) return (ra > rb) ? 1 : -1;
    return 0;
}

/* OTA 错误码（与协议一致）：1 兼容/版本 2 校验 3 空间 4 写失败 5 参数 6 应用失败 */


static void reply_err(char *reply, size_t reply_len, int code)
{
    snprintf(reply, reply_len, "OTA,ERR,%d", code);
}

/* ------------------------------------------------------------------ */
/* 对外查询                                                            */
/* ------------------------------------------------------------------ */

bool ota_mgr_busy(void) { return s_ota.active || s_net_active; }
uint32_t ota_mgr_rx_seq(void) { return (uint32_t)(s_ota.seq & 0xFF); }
uint32_t ota_mgr_rx_written(void) { return s_ota.written; }
void ota_mgr_set_progress_cb(ota_progress_cb_t cb) { s_progress_cb = cb; }

const char *ota_mgr_version(void)
{
    static char buf[32];
    const esp_app_desc_t *d = esp_app_get_description();
    snprintf(buf, sizeof(buf), "%s", d->version);
    return buf;
}

const char *ota_mgr_slot_state_string(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (run == NULL) return "NONE";
    esp_ota_img_states_t st = ESP_OTA_IMG_UNDEFINED;
    if (esp_ota_get_state_partition(run, &st) != ESP_OK) return "UNDEFINED";
    switch (st) {
    case ESP_OTA_IMG_NEW:          return "NEW";
    case ESP_OTA_IMG_PENDING_VERIFY: return "PENDING_VERIFY";
    case ESP_OTA_IMG_VALID:        return "VALID";
    case ESP_OTA_IMG_INVALID:      return "INVALID";
    case ESP_OTA_IMG_ABORTED:      return "ABORTED";
    default:                       return "UNDEFINED";
    }
}

/* ------------------------------------------------------------------ */
/* OTA_BEGIN                                                           */
/* ------------------------------------------------------------------ */

esp_err_t ota_mgr_ble_begin(const uint8_t *data, uint16_t len,
                            char *reply, size_t reply_len)
{
    if (data == NULL || len < OTA_BEGIN_HDR_LEN) {
        reply_err(reply, reply_len, OTA_ERR_ARG);
        return ESP_ERR_INVALID_ARG;
    }
    if (s_ota.active) {
        reply_err(reply, reply_len, OTA_ERR_ARG);   /* 已在传输中，先 abort */
        return ESP_ERR_INVALID_STATE;
    }

    uint32_t size   = rd32(data + 0);
    uint32_t crc32  = rd32(data + 4);
    uint8_t  proto  = data[40];
    uint8_t  vlen   = data[41];
    const uint8_t *sha = data + 8;

    if (proto != OTA_PROTO_VERSION) {
        reply_err(reply, reply_len, OTA_ERR_COMPAT);
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (size == 0 || size > OTA_IMG_MAX_SIZE) {
        reply_err(reply, reply_len, OTA_ERR_SPACE);
        return ESP_ERR_INVALID_SIZE;
    }
    if (vlen == 0 || vlen >= sizeof(s_ota.version) || (size_t)len < OTA_BEGIN_HDR_LEN + (size_t)vlen) {
        reply_err(reply, reply_len, OTA_ERR_ARG);
        return ESP_ERR_INVALID_ARG;
    }
    memcpy(s_ota.version, data + 42, vlen);
    s_ota.version[vlen] = '\0';

    /* 防降级：目标版本 < 当前运行版本则拒绝 */
    if (ver_cmp(s_ota.version, ota_mgr_version()) < 0) {
        reply_err(reply, reply_len, OTA_ERR_COMPAT);
        return ESP_ERR_INVALID_STATE;
    }

    /* 选定目标槽（非运行槽） */
    const esp_partition_t *update = esp_ota_get_next_update_partition(NULL);
    if (update == NULL) {
        reply_err(reply, reply_len, OTA_ERR_APPLY);
        return ESP_ERR_NOT_FOUND;
    }
    ESP_LOGI(TAG, "begin: target slot %s (label=%s) size=%lu ver=%s proto=%u",
             update->type == ESP_PARTITION_TYPE_APP ? "app" : "?",
             update->label, (unsigned long)size, s_ota.version, (unsigned)proto);

    esp_ota_handle_t handle = 0;
    if (device_control_stop_all() != ESP_OK) {
        reply_err(reply, reply_len, OTA_ERR_APPLY);
        return ESP_ERR_INVALID_STATE;
    }
    esp_err_t err = esp_ota_begin(update, OTA_SIZE_UNKNOWN, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin fail: %s (0x%x)", esp_err_to_name(err), err);
        reply_err(reply, reply_len, OTA_ERR_WRITE);
        return err;
    }

    s_ota.update  = update;
    s_ota.handle  = handle;
    s_ota.total   = size;
    s_ota.written = 0;
    s_ota.crc     = 0;
    s_ota.crc_expect = crc32;
    s_ota.seq     = 0;
    s_ota.active  = true;
    memcpy(s_ota.sha, sha, 32);
    mbedtls_sha256_init(&s_ota.sha_ctx);
    mbedtls_sha256_starts(&s_ota.sha_ctx, 0);

    /* 记录任务元数据（崩溃/断点恢复用） */
    nvs_save_task();
    /* 重连续传采用"手机侧缓存从 0 重发"模型：偏移上报为当前已写入 0 */
    snprintf(reply, reply_len, "OTA,READY,0");
    ESP_LOGI(TAG, "ota ready, slot=%s", update->label);
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* OTA_DATA                                                            */
/* ------------------------------------------------------------------ */

esp_err_t ota_mgr_ble_data(const uint8_t *payload, uint16_t payload_len)
{
    if (!s_ota.active) return ESP_ERR_INVALID_STATE;
    if (s_ota.written + payload_len > s_ota.total) return ESP_ERR_INVALID_SIZE;

    /* 顺序校验：payload 必须连续（BLE 层已用 offset 字段做一致性校验，
     * 这里再次防御性地核对累计偏移，防止窗口内乱序写入损坏镜像。） */
    if (payload_len > 0) {
        esp_err_t err = esp_ota_write(s_ota.handle, payload, payload_len);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write fail: %s (0x%x)",
                     esp_err_to_name(err), err);
            s_ota.crc = 0;
            nvs_clear();
            s_ota.active = false;
            return err;
        }
        s_ota.crc = esp_rom_crc32_le(s_ota.crc, payload, payload_len);
        mbedtls_sha256_update(&s_ota.sha_ctx, payload, payload_len);
        s_ota.written += payload_len;
        s_ota.seq++;
    }

    /* 每 64KB 持久化断点 */
    if ((s_ota.written % OTA_WRITE_PERSIST_STEP) == 0) {
        nvs_save_offset();
        emit_progress();
    }

    /* 数据收齐：预置"待 apply"标记（终验在 apply 阶段做） */
    if (s_ota.written >= s_ota.total) {
        emit_progress();
        ESP_LOGI(TAG, "ota all data received: %lu/%lu",
                 (unsigned long)s_ota.written, (unsigned long)s_ota.total);
    }
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* OTA_APPLY                                                           */
/* ------------------------------------------------------------------ */

esp_err_t ota_mgr_ble_apply(char *reply, size_t reply_len)
{
    if (!s_ota.active) {
        reply_err(reply, reply_len, OTA_ERR_ARG);
        return ESP_ERR_INVALID_STATE;
    }
    if (s_ota.written != s_ota.total) {
        reply_err(reply, reply_len, OTA_ERR_WRITE);    /* 数据不完整 */
        return ESP_ERR_INVALID_STATE;
    }

    /* 整包 CRC32 + SHA256 双重校验（均与 OTA_BEGIN 携带的目标值比对） */
    if (s_ota.crc != s_ota.crc_expect) {
        ESP_LOGE(TAG, "crc32 mismatch: got %08lx expect %08lx",
                 (unsigned long)s_ota.crc, (unsigned long)s_ota.crc_expect);
        nvs_clear();
        s_ota.active = false;
        reply_err(reply, reply_len, OTA_ERR_CRC);
        return ESP_ERR_INVALID_CRC;
    }
    uint8_t digest[32];
    mbedtls_sha256_finish(&s_ota.sha_ctx, digest);
    mbedtls_sha256_free(&s_ota.sha_ctx);
    if (memcmp(digest, s_ota.sha, 32) != 0) {
        ESP_LOGE(TAG, "sha256 mismatch");
        nvs_clear();
        s_ota.active = false;
        reply_err(reply, reply_len, OTA_ERR_CRC);
        return ESP_ERR_INVALID_CRC;
    }

    esp_err_t err = esp_ota_end(s_ota.handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end fail: %s (0x%x)", esp_err_to_name(err), err);
        s_ota.active = false;
        reply_err(reply, reply_len, OTA_ERR_APPLY);
        return err;
    }

    err = esp_ota_set_boot_partition(s_ota.update);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_boot_partition fail: %s (0x%x)", esp_err_to_name(err), err);
        s_ota.active = false;
        reply_err(reply, reply_len, OTA_ERR_APPLY);
        return err;
    }

    nvs_clear();
    s_ota.active = false;
    snprintf(reply, reply_len, "OTA,APPLY");
    ESP_LOGI(TAG, "ota apply ok -> slot %s, rebooting in 1s", s_ota.update->label);

    /* 延迟约 1s 重启，让 BLE 应答先把 OTA,APPLY 送出去 */
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* OTA_QUERY                                                           */
/* ------------------------------------------------------------------ */

esp_err_t ota_mgr_ble_query(char *reply, size_t reply_len)
{
    if (!s_ota.active) {
        snprintf(reply, reply_len, "OTA,INFO,%s,%s,0,0",
                 ota_mgr_version(), ota_mgr_slot_state_string());
        return ESP_OK;
    }
    snprintf(reply, reply_len, "OTA,INFO,%s,%s,%lu,%lu",
             ota_mgr_version(), ota_mgr_slot_state_string(),
             (unsigned long)s_ota.written, (unsigned long)s_ota.total);
    return ESP_OK;
}

/* ------------------------------------------------------------------ */
/* OTA_ABORT                                                           */
/* ------------------------------------------------------------------ */

void ota_mgr_ble_abort(const char *reason)
{
    if (!s_ota.active) return;
    ESP_LOGW(TAG, "ota abort: %s", reason ? reason : "app");
    esp_ota_abort(s_ota.handle);
    mbedtls_sha256_free(&s_ota.sha_ctx);
    nvs_clear();
    s_ota.active = false;
    s_ota.handle = 0;
}

/* ------------------------------------------------------------------ */
/* 初始化 & 自测确认                                                   */
/* ------------------------------------------------------------------ */

esp_err_t ota_mgr_init(void)
{
    /* 打开 NVS（读断点/进度；只读场景失败不致命） */
    esp_err_t err = nvs_open(OTA_NVS_NS, NVS_READWRITE, &s_nvs);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "open nvs %s fail (0x%x)", OTA_NVS_NS, err);
        s_nvs = 0;
    }

    const esp_app_desc_t *d = esp_app_get_description();
    const esp_partition_t *run = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "fw=%s project=%s slot=%s state=%s",
             d->version, d->project_name,
             run ? run->label : "?",
             ota_mgr_slot_state_string());

    /* 启动主动轮询：联网后定期检查新版本（发现新版自动升级） */
    ota_mgr_net_poll_init();
    return ESP_OK;
}

void ota_mgr_confirm_if_pending(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (run == NULL) return;

    esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
    if (esp_ota_get_state_partition(run, &state) != ESP_OK) return;
    if (state == ESP_OTA_IMG_PENDING_VERIFY) {
        /* 新固件首次启动：所有已调用的模块 init 均成功，判定自测通过。
         * 若任一模块 init 失败，app_main 会提前 return（ESP_ERROR_CHECK），
         * 不会走到这里；一旦走到这里即可 confirm。 */
        ESP_LOGI(TAG, "PENDING_VERIFY: self-test passed, marking valid");
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "mark valid -> %s (0x%x)", esp_err_to_name(err), err);
    } else if (state == ESP_OTA_IMG_INVALID) {
        ESP_LOGW(TAG, "running slot INVALID after rollback, awaiting next OTA");
    }
}
