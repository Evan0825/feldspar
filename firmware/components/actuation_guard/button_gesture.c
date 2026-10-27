#include "button_gesture.h"

button_action_t button_gesture_update(button_gesture_t *s, bool pressed, uint64_t now) {
    if (pressed != s->raw) {
        s->raw = pressed;
        s->changed_ms = now;
    }
    if (now - s->changed_ms < 20) return BUTTON_NONE;
    if (pressed != s->pressed) {
        s->pressed = pressed;
        if (pressed) {
            s->pressed_ms = now;
            s->long_emitted = false;
        } else if (!s->long_emitted) {
            return BUTTON_SHORT;
        }
    }
    if (s->pressed && !s->long_emitted && now - s->pressed_ms >= 2000) {
        s->long_emitted = true;
        return BUTTON_LONG;
    }
    return BUTTON_NONE;
}
