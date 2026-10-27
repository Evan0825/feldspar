#pragma once
#include <stddef.h>
#include <stdint.h>
uint32_t esp_rom_crc32_le(uint32_t crc, const uint8_t *data, size_t length);
