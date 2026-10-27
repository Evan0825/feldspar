idf_component_register(
    SRCS "haptic.c"
    INCLUDE_DIRS "include"
    REQUIRES driver actuation_guard
    PRIV_REQUIRES esp_timer nvs_flash freertos
)
