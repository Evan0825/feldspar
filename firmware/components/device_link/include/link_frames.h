#pragma once
#include <stdbool.h>
#include <stddef.h>

#define LINK_COMMAND_MAX 1024
typedef enum { LF_REJECTED=-1, LF_MORE=0, LF_COMPLETE=1 } lf_result_t;
typedef struct { char data[LINK_COMMAND_MAX+1]; size_t used, total; } link_frame_t;
lf_result_t link_frame_push(link_frame_t *frame, const char *expected_topic,
    const char *topic, int topic_len, const char *data, int length, int total, int offset, bool retained);
