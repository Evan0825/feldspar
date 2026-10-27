#pragma once
int xTaskCreate(void (*worker)(void *), const char *name, unsigned stack,
                void *context, unsigned priority, void *handle);
void vTaskDelay(unsigned ticks);
