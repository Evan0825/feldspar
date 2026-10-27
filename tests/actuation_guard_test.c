#include "actuation_guard.h"
#include "button_gesture.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static bool save_ok = true;
static ag_checkpoint_t saved;
static bool save_checkpoint(void *context, const ag_checkpoint_t *checkpoint) {
    (void)context;
    if (!save_ok) return false;
    saved = *checkpoint;
    return true;
}

static ag_request_t automatic(const char *id) {
    return (ag_request_t){.source=AG_CLOUD, .command_id=id, .percent=20,
        .duration_ms=1000, .night=42, .expires_ms=5000, .authorized=true,
        .hardware_ready=true, .evidence_fresh=true, .clock_valid=true};
}

int main(void) {
    /* Numerical fixtures only: these are not approved physical profiles. */
    ag_policy_t policy = {.max_percent=30, .max_duration_ms=1000,
        .cooldown_ms=2000, .max_per_night=2, .automatic_enabled=true, .profile_validated=true};
    ag_guard_t guard;
    ag_init(&guard, policy, save_checkpoint, NULL);
    ag_request_t request = automatic("first");
    assert(ag_start(&guard, &request, 100) == AG_BUDGET);
    ag_checkpoint_t checkpoint = {.night=42};
    assert(ag_restore(&guard, &checkpoint, 0));
    assert(ag_start(&guard, &request, 100) == AG_OK);
    assert(guard.active && saved.used == 1 && guard.deadline_ms == 1100);
    assert(ag_start(&guard, &request, 200) == AG_DUPLICATE);
    assert(guard.deadline_ms == 1100);
    ag_tick(&guard, 1099);
    assert(guard.percent == 20);
    ag_tick(&guard, 1100);
    assert(!guard.active && guard.percent == 0);
    request = automatic("second");
    assert(ag_start(&guard, &request, 1101) == AG_COOLDOWN);
    assert(ag_start(&guard, &request, 3100) == AG_OK);
    ag_stop(&guard, 3200, true);
    assert(guard.stop_latched && guard.percent == 0);
    request = automatic("third"); request.expires_ms=10000;
    assert(ag_start(&guard, &request, 5300) == AG_STOPPED);
    assert(ag_resume(&guard) == AG_OK);
    assert(ag_start(&guard, &request, 5300) == AG_BUDGET);
    ag_guard_t rebooted;
    ag_init(&rebooted, policy, save_checkpoint, NULL);
    assert(ag_restore(&rebooted, &saved, 0));
    assert(!rebooted.stop_latched);
    assert(ag_start(&rebooted, &request, 3000) == AG_BUDGET);
    checkpoint.used=0;
    assert(!ag_restore(&guard, &checkpoint, 6000)); /* no same-night budget rollback */

    ag_init(&guard, policy, save_checkpoint, NULL);
    assert(ag_restore(&guard, &checkpoint, 0));
    request = automatic("gates");
    request.hardware_ready=false;
    assert(ag_start(&guard, &request, 10) == AG_UNSAFE);
    request.hardware_ready=true; request.authorized=false;
    assert(ag_start(&guard, &request, 10) == AG_UNSAFE);
    request.authorized=true; request.evidence_fresh=false;
    assert(ag_start(&guard, &request, 10) == AG_UNSAFE);
    request.evidence_fresh=true; request.clock_valid=false;
    assert(ag_start(&guard, &request, 10) == AG_UNSAFE);
    request.clock_valid=true; request.percent=31;
    assert(ag_start(&guard, &request, 10) == AG_INVALID);
    request.percent=20; request.duration_ms=1001;
    assert(ag_start(&guard, &request, 10) == AG_INVALID);
    request.duration_ms=1000;
    assert(ag_start(&guard, &request, 5000) == AG_EXPIRED);
    request.night=43;
    assert(ag_start(&guard, &request, 10) == AG_BUDGET);
    request.night=42; save_ok=false;
    assert(ag_start(&guard, &request, 10) == AG_STORAGE);
    assert(!guard.active && guard.percent == 0);
    save_ok=true; guard.policy.profile_validated=false;
    assert(ag_start(&guard, &request, 10) == AG_DISABLED);

    /* Manual adjustment cannot renew the original deadline. */
    request = (ag_request_t){.source=AG_MANUAL, .command_id="manual",
        .percent=20, .duration_ms=1000, .expires_ms=5000};
    assert(ag_start(&guard, &request, 100) == AG_OK);
    assert(ag_adjust_manual(&guard, 25) == AG_OK);
    assert(guard.deadline_ms == 1100);
    ag_tick(&guard, 1100);
    assert(guard.percent == 0);
    assert(ag_adjust_manual(&guard, 25) == AG_STOPPED);
    assert(ag_start(&guard, &request, 1101) == AG_STOPPED); /* late slider cannot reopen */
    ag_stop(&guard, 1200, true);
    ag_init(&rebooted, policy, save_checkpoint, NULL);
    assert(ag_restore(&rebooted, &saved, 0));
    assert(rebooted.stop_latched);
    save_ok=false;
    assert(ag_resume(&rebooted) == AG_STORAGE && rebooted.stop_latched);
    save_ok=true;

    button_gesture_t button = {0};
    assert(button_gesture_update(&button, true, 100) == BUTTON_NONE);
    assert(button_gesture_update(&button, false, 110) == BUTTON_NONE); /* bounce */
    assert(button_gesture_update(&button, false, 150) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 200) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 220) == BUTTON_NONE);
    assert(button_gesture_update(&button, false, 400) == BUTTON_NONE);
    assert(button_gesture_update(&button, false, 420) == BUTTON_SHORT);
    assert(button_gesture_update(&button, false, 430) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 1000) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 1020) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 3019) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 3020) == BUTTON_LONG);
    assert(button_gesture_update(&button, true, 4000) == BUTTON_NONE);
    assert(button_gesture_update(&button, false, 4100) == BUTTON_NONE);
    assert(button_gesture_update(&button, false, 4120) == BUTTON_NONE); /* never short after long */
    /* A held active-low button at boot cannot become an inferred idle level. */
    button = (button_gesture_t){0};
    assert(button_gesture_update(&button, true, 0) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 20) == BUTTON_NONE);
    assert(button_gesture_update(&button, true, 2020) == BUTTON_LONG);
    puts("Actuation guard and short/long button checks passed (host only).");
}
