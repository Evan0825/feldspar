#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { BUTTON_NONE, BUTTON_SHORT, BUTTON_LONG } button_action_t;
typedef struct {
    bool raw, pressed, long_emitted;
    uint64_t changed_ms, pressed_ms;
} button_gesture_t;

/* Call from the polling loop; short action is emitted only on release. */
button_action_t button_gesture_update(button_gesture_t *state, bool pressed, uint64_t now_ms);
