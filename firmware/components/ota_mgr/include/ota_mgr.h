#pragma once

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ---- 好眠 OTA 管理器（components/ota_mgr）----
 * 职责：
 *  1) 启动时打印固件版本与当前启动槽状态；
 *  2) PENDING_VERIFY 自测与 confirm（配合 bootloader rollback，见 FIXME main.c）；
 *  3) BLE 通道全量 OTA 状态机：begin 元数据/校验 → 流式写入空闲槽 → apply 终验+切换；
 *  4) NVS 断点记录（进度/崩溃恢复上报，写中断重连后由手机侧缓存重发）。
 * 通道 A（WiFi HTTPS OTA）属 P1，不在本组件当前范围。
 */

/* 初始化：读取 OTA 相关信息（版本/槽位），加载 NVS 断点态。 */
esp_err_t ota_mgr_init(void);

/* 自测确认：PENDING_VERIFY 的新固件首次启动成功后调用。
 * 运行自测清单，全部通过则 mark_valid 确认；有任一失败则主动回滚旧槽并重启。 */
void ota_mgr_confirm_if_pending(void);

/* OTA 是否正在进行（BLE 互斥：升级期间拒绝音频/麦克风/音效传输等）。 */
bool ota_mgr_busy(void);

/* ---- BLE 接收通道（BLE 回调上下文调用，勿阻塞、勿长耗时）---- */

/* OTA_BEGIN：解析 [size u32][crc32 u32][sha256 32B][protoVer u8][verLen u8][version..]
 * 校验兼容性/空间，选定目标槽并 esp_ota_begin。结果写入 reply（"OTA,READY,<off>" / "OTA,ERR,<code>"）。 */
esp_err_t ota_mgr_ble_begin(const uint8_t *data, uint16_t len, char *reply, size_t reply_len);

/* OTA_DATA：写入一帧有效载荷（BLE 层已完成 CRC16/seq/offset 校验后剥离出的 payload）。
 * 内部做 offset 校验、esp_ota_write、cr32/sha256 累计、每 64KB 持久化断点。 */
esp_err_t ota_mgr_ble_data(const uint8_t *payload, uint16_t payload_len);

/* OTA_APPLY：终验（全量字节/CRC32/SHA256）→ esp_ota_end → 切换启动槽并重启。
 * 结果写入 reply（"OTA,APPLY" / "OTA,ERR,<code>"）；成功返回后内部会安排重启。 */
esp_err_t ota_mgr_ble_apply(char *reply, size_t reply_len);

/* OTA_QUERY：查询当前 OTA 状态，写入 reply（"OTA,INFO,..."）。 */
esp_err_t ota_mgr_ble_query(char *reply, size_t reply_len);

/* OTA_ABORT：中止传输，清除断点态（不擦槽）。 */
void ota_mgr_ble_abort(const char *reason);

/* 期望的下一帧序号（供 BLE 层 NAK 比较，需 u8 回绕）。 */
uint32_t ota_mgr_rx_seq(void);

/* 当前已写入字节数（BLE 层做 offset 一致性校验用）。 */
uint32_t ota_mgr_rx_written(void);

/* 版本与启动槽信息（供启动日志 / OTA_QUERY / 小程序展示）。 */
const char *ota_mgr_version(void);         /* 如 "1.0.0" */
const char *ota_mgr_slot_state_string(void); /* 如 "VALID"/"PENDING_VERIFY"/"INVALID" */

/* 注册进度回调（可选），BLE 层推送 OTA,PROG,<off>,<total> 用。 */
typedef void (*ota_progress_cb_t)(uint32_t offset, uint32_t total);
void ota_mgr_set_progress_cb(ota_progress_cb_t cb);

/* ---- WiFi/HTTPS 网络 OTA 通道（P1）----
 * 异步任务：拉取 manifest → 校验版本/契约 → 下载固件写入空闲槽 →
 * CRC32+SHA256 双校验 → 切换启动槽并重启。
 * 服务器接口地址尚未最终确定（先以 OTA_NET_MANIFEST_URL 占位，待提供后替换；
 * 固件 URL 由 manifest 的 full.url 下发）。
 * 结果经 ota_mgr_net_set_event_cb 以文本推送（如 OTA,NET,CHECK,<ver> / OTA,NET,DONE /
 * OTA,NET,ERR,<code>），下载进度经 ota_mgr_set_progress_cb 推送（OTA,PROG,<off>,<total>）。 */

/* 网络 OTA 是否正在运行（与 BLE OTA 互斥，升级期间 ota_mgr_busy() 亦为真）。 */
bool ota_mgr_net_running(void);

/* 触发一次网络 OTA（异步）：成功启动写 reply 为 "OTA,NET,STARTED"；
 * 若已有 OTA（BLE 或网络）在进行则写 "OTA,ERR,8"，启动失败写 "OTA,ERR,5"。 */
esp_err_t ota_mgr_net_start(char *reply, size_t reply_len);

/* 中止正在进行的网络 OTA（尽力而为：下一数据块处中断）。 */
void ota_mgr_net_stop(void);

/* 当前网络 OTA 状态文本（IDLE / FETCHING / DOWNLOADING / VERIFYING / REBOOTING / ERROR）。 */
const char *ota_mgr_net_state_string(void);

/* 注册网络 OTA 事件回调（文本消息），BLE 层经 0xFF04 下行。 */
typedef void (*ota_net_event_cb_t)(const char *msg);
void ota_mgr_net_set_event_cb(ota_net_event_cb_t cb);

#ifdef __cplusplus
}
#endif
