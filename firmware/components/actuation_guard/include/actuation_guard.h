#pragma once
#include <stdbool.h>
#include <stdint.h>

#define AG_ID_SIZE 65
typedef enum { AG_MANUAL, AG_CLOUD, AG_LOCAL } ag_source_t;
typedef enum { AG_OK, AG_INVALID, AG_DISABLED, AG_UNSAFE, AG_EXPIRED,
               AG_BUSY, AG_DUPLICATE, AG_COOLDOWN, AG_BUDGET, AG_STORAGE,
               AG_STOPPED } ag_result_t;
typedef struct {
    uint8_t max_percent;
    uint32_t max_duration_ms, cooldown_ms, max_per_night;
    bool automatic_enabled, profile_validated;
} ag_policy_t;
typedef struct {
    uint32_t night, used;
    char last_command[AG_ID_SIZE];
    bool stop_latched;
} ag_checkpoint_t;
typedef bool (*ag_save_fn)(void *context, const ag_checkpoint_t *checkpoint);
typedef struct {
    ag_source_t source;
    const char *command_id;
    uint8_t percent;
    uint32_t duration_ms, night;
    uint64_t expires_ms;
    bool authorized, hardware_ready, evidence_fresh, clock_valid;
} ag_request_t;
typedef struct {
    ag_policy_t policy;
    ag_checkpoint_t checkpoint;
    ag_save_fn save;
    void *context;
    bool active, stop_latched, budget_restored;
    uint8_t percent;
    ag_source_t source;
    uint64_t deadline_ms, cooldown_until_ms;
} ag_guard_t;

void ag_init(ag_guard_t *guard, ag_policy_t policy, ag_save_fn save, void *context);
bool ag_restore(ag_guard_t *guard, const ag_checkpoint_t *checkpoint, uint64_t now_ms);
ag_result_t ag_start(ag_guard_t *guard, const ag_request_t *request, uint64_t now_ms);
ag_result_t ag_adjust_manual(ag_guard_t *guard, uint8_t percent);
void ag_stop(ag_guard_t *guard, uint64_t now_ms, bool latch);
void ag_tick(ag_guard_t *guard, uint64_t now_ms);
ag_result_t ag_resume(ag_guard_t *guard);
const char *ag_result_name(ag_result_t result);
