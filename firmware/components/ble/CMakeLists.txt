idf_component_register(
    SRCS "ble.c"
    INCLUDE_DIRS "include"
    REQUIRES bt
    PRIV_REQUIRES audio lighting haptic mic sfx wifi_mgr mqtt_mgr ota_mgr nvs_flash device_control
)
