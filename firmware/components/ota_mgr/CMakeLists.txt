idf_component_register(
    SRCS "ota_mgr.c"
    INCLUDE_DIRS "include"
    REQUIRES app_update esp_partition nvs_flash mbedtls esp_app_format esp_rom
            esp_http_client json esp_timer wifi_mgr device_control
)
