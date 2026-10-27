idf_component_register(
    SRCS "sfx.c"
    INCLUDE_DIRS "include"
    REQUIRES storage audio fatfs wear_levelling esp_partition
)
