#pragma once
#include <stddef.h>
#include <stdint.h>
typedef void *QueueHandle_t;
QueueHandle_t xQueueCreate(unsigned count, unsigned size);
int xQueueSend(QueueHandle_t queue, const void *item, uint32_t timeout);
int xQueueReceive(QueueHandle_t queue, void *item, uint32_t timeout);
int xQueueReset(QueueHandle_t queue);
