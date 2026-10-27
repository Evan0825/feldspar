#pragma once
static inline void host_log(const char *tag, const char *format, ...) { (void)tag; (void)format; }
#define ESP_LOGI(tag, ...) host_log(tag, __VA_ARGS__)
#define ESP_LOGW(tag, ...) host_log(tag, __VA_ARGS__)
#define ESP_LOGE(tag, ...) host_log(tag, __VA_ARGS__)
