idf_component_register(
    SRCS "sfx.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_timer storage audio fatfs wear_levelling esp_partition
)
