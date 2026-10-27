#pragma once

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- BLE 服务与特征 UUID（16-bit 简化，便于手机端匹配）---- */
#define BLE_SVC_UUID             0xFF00
#define BLE_CHR_CONTROL_UUID     0xFF01   /* 控制任务（Write）*/
#define BLE_CHR_AUDIO_UUID       0xFF02   /* 音频/音效数据（Write）*/
#define BLE_CHR_STATUS_UUID      0xFF03   /* 状态通知（Read / Notify）*/
#define BLE_CHR_DATA_UUID        0xFF04   /* 数据下行：文件列表/传输应答（Read / Notify）*/

/* 控制特征负载：首字节为命令字节，后续为参数 */
typedef enum {
    BLE_CMD_LIGHT_LEVEL  = 0x01,   /* 灯光亮度：params[0]=0-100（三通道同值白光） */
    BLE_CMD_LIGHT_RGB    = 0x09,   /* RGB 灯带颜色：params[0..2]=r/g/b 各 0-100 */
    BLE_CMD_MOTOR_SPEED  = 0x02,   /* 电机速度：params[0]=int8 -100..100 */
    BLE_CMD_MOTOR_STOP   = 0x03,   /* 电机停止 */
    BLE_CMD_AUDIO_PLAY   = 0x04,   /* 开始播放 */
    BLE_CMD_AUDIO_PAUSE  = 0x05,   /* 暂停播放 */
    BLE_CMD_AUDIO_STOP   = 0x06,   /* 停止播放 */
    BLE_CMD_AUDIO_VOLUME = 0x07,   /* 音量：params[0]=0-100 */
    BLE_CMD_AUDIO_TEST   = 0x08,   /* 播放内置测试音（无参数，应答 TESTTONE/TESTERR） */
    BLE_CMD_MIC_DIAG     = 0x20,   /* 麦克风诊断：params[0]=0 停止/1 开始，开始后每秒经 0xFF04 回 MIC,<rms>,<peak> */

    BLE_CMD_SAFETY_STATE = 0x24,   /* HAPTIC driver state, not physical feedback */
    BLE_CMD_SAFETY_RESUME = 0x25,  /* Clear stop latch; starts no output */
    BLE_CMD_STOP_ALL = 0x26,       /* Latch stop for motor, sound and light */
    BLE_CMD_IO_STATE = 0x27,       /* Correlated light/audio driver readback */

    /* ---- 音效文件管理（0x30-0x35，配合 0xFF02 数据通道）---- */
    BLE_CMD_SFX_BEGIN    = 0x30,   /* 开始传输：[name_len][name..][size u32 LE][fmt u8] */
    BLE_CMD_SFX_END      = 0x31,   /* 传输结束：[crc32 u32 LE] */
    BLE_CMD_SFX_PLAY     = 0x32,   /* 播放音效：[index u8]，0=按规则自动选 */
    BLE_CMD_SFX_DELETE   = 0x33,   /* 删除音效：[index u8] */
    BLE_CMD_SFX_LIST     = 0x34,   /* 查询音效列表（结果经 0xFF04 下发） */
    BLE_CMD_SFX_AUTO     = 0x35,   /* 自动轮播开关：[0/1] */

    /* ---- WiFi 管理（0x41-0x44，配合 0xFF04 状态上报）---- */
    BLE_CMD_WIFI_CONFIG  = 0x41,   /* 配置并连接：[ssid_len][ssid..][pwd_len][pwd..]，存 NVS 并连接 */
    BLE_CMD_WIFI_STATE   = 0x42,   /* 查询 WiFi 状态（结果经 0xFF04 回 WIFI,...） */
    BLE_CMD_WIFI_FORGET  = 0x43,   /* 清除已存凭据并断开 */
    BLE_CMD_WIFI_SCAN    = 0x44,   /* 扫描附近 AP（结果经 0xFF04 回 WIFI,SCANNING/AP,.../SCANEND,n） */

    /* ---- OTA 升级（0x50-0x53 + 0x0A，配合 0xFF02 数据通道 0xA1 帧）---- */
    BLE_CMD_OTA_BEGIN    = 0x50,   /* 开始 BLE OTA：[size u32 LE][crc32 u32 LE][sha256 32B][protoVer u8][verLen u8][version..] */
    BLE_CMD_OTA_QUERY    = 0x51,   /* 查询 OTA 状态/断点（结果经 0xFF04 回 OTA,INFO,...） */
    BLE_CMD_OTA_APPLY    = 0x52,   /* 应用：终验通过后切换启动槽并重启 */
    BLE_CMD_OTA_ABORT    = 0x53,   /* 中止：清除断点状态（不擦槽） */
    BLE_CMD_OTA_NOW      = 0x0A,   /* 触发通道 A（WiFi）立即检查（WiFi 在线时） */
} ble_cmd_t;

/* 音频数据负载：一段 16bit 单声道 PCM（按 MTU 分片上传） */
#define BLE_AUDIO_CHUNK_MAX  512

/* 0xFF02 文件数据帧格式（传输态）：
 *   [type=0xA0][seq u8][len u16 LE][payload len 字节][crc16 u16 LE]
 *   crc16 覆盖 seq+len+payload；seq 从 0 连续递增，不匹配回 NAK */
#define SFX_PKT_DATA         0xA0

/* 0xFF02 OTA 数据帧格式（传输态）：
 *   [type=0xA1][seq u8][len u16 LE][offset u32 LE][payload len 字节][crc16 u16 LE]
 *   crc16 覆盖 seq+len+offset+payload；seq 从 0 连续递增，不匹配回 NAK,<expect>,<got>；
 *   offset 为 payload 在镜像中的绝对字节偏移（须与已写入字节数一致，否则视为协议错误） */
#define OTA_PKT_DATA         0xA1

/* BLE OTA 镜像元数据（OTA_BEGIN 载荷）大小：
 *   size(4) + crc32(4) + sha256(32) + protoVer(1) + verLen(1) = 42 */
#define OTA_BEGIN_HDR_LEN    42
/* OTA 数据帧头（不含 payload）：type(1)+seq(1)+len(2)+offset(4)+crc16(2) = 10 */
#define OTA_FRAME_HDR_LEN    10

/* OTA 协议版本（用于 BLE 通道协商，与 manifest 无关） */
#define OTA_PROTO_VERSION    1

/* 音效格式：0 = PCM16LE 16kHz 单声道，1 = IMA-ADPCM(WAV 块格式, blockAlign=256) */
#define SFX_FMT_PCM16        0
#define SFX_FMT_IMA_ADPCM    1

#ifdef __cplusplus
}
#endif
