idf_component_register(
    SRCS "device_link.c" "link_frames.c"
    INCLUDE_DIRS "include"
    REQUIRES acoustic_features esp_common
    PRIV_REQUIRES mqtt_mgr haptic device_control esp_timer esp_netif lwip
                  esp_app_format esp_hw_support json freertos
)
