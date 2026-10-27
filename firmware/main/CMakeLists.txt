idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    REQUIRES audio lighting ble haptic mic storage sfx wifi_mgr mqtt_mgr ota_mgr nvs_flash actuation_guard device_control device_link esp_timer
)
