idf_component_register(
    SRCS "storage.c"
    INCLUDE_DIRS "include"
    REQUIRES driver spi_flash fatfs wear_levelling esp_partition
)
