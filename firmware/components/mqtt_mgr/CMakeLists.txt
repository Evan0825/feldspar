idf_component_register(
    SRCS "mqtt_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES mqtt esp_event esp_netif esp_wifi esp_timer esp_app_format
    PRIV_REQUIRES nvs_flash wifi_mgr
)

# 将 CA 证书作为只读文本（NULL 结尾的 PEM 字符串）嵌入固件，
# 生成符号 _binary_ca_crt_start / _binary_ca_crt_end
target_add_binary_data(${COMPONENT_LIB} "ca.crt" TEXT)
