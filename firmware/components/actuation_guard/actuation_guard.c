#include "actuation_guard.h"
#include <string.h>

void ag_init(ag_guard_t *g, ag_policy_t policy, ag_save_fn save, void *context) {
    memset(g, 0, sizeof(*g));
    g->policy = policy;
    g->save = save;
    g->context = context;
}

bool ag_restore(ag_guard_t *g, const ag_checkpoint_t *checkpoint, uint64_t now) {
    if (!checkpoint || g->active ||
        !memchr(checkpoint->last_command, 0, AG_ID_SIZE)) return false;
    if (g->budget_restored && (checkpoint->night < g->checkpoint.night ||
        (checkpoint->night == g->checkpoint.night && checkpoint->used < g->checkpoint.used))) return false;
    g->checkpoint = *checkpoint;
    g->budget_restored = checkpoint->night != 0;
    g->stop_latched = checkpoint->stop_latched;
    /* On reboot do not assume that a previous cooldown has elapsed. */
    if (checkpoint->used) g->cooldown_until_ms = now + g->policy.cooldown_ms;
    return true;
}

void ag_stop(ag_guard_t *g, uint64_t now, bool latch) {
    if (g->active && g->source != AG_MANUAL)
        g->cooldown_until_ms = now + g->policy.cooldown_ms;
    g->active = false;
    g->percent = 0;
    g->deadline_ms = 0;
    if (latch) {
        g->stop_latched = true;
        g->checkpoint.stop_latched = true;
        if (!g->save || !g->save(g->context, &g->checkpoint)) g->budget_restored = false;
    }
}

void ag_tick(ag_guard_t *g, uint64_t now) {
    if (g->active && now >= g->deadline_ms) {
        bool manual = g->source == AG_MANUAL;
        ag_stop(g, now, false);
        /* Timer context cannot write flash. Require explicit resume so a late
         * slider packet cannot immediately start another manual interval. */
        if (manual) {
            g->stop_latched = true;
            g->checkpoint.stop_latched = true;
        }
    }
}

ag_result_t ag_start(ag_guard_t *g, const ag_request_t *r, uint64_t now) {
    ag_tick(g, now);
    if (g->stop_latched) return AG_STOPPED;
    if (!r || (unsigned)r->source > AG_LOCAL || !r->command_id || !r->command_id[0] ||
        !memchr(r->command_id, 0, AG_ID_SIZE) || !r->percent ||
        r->percent > g->policy.max_percent || !r->duration_ms ||
        r->duration_ms > g->policy.max_duration_ms || UINT64_MAX - now < r->duration_ms) return AG_INVALID;
    if (r->expires_ms <= now) return AG_EXPIRED;
    bool automatic = r->source != AG_MANUAL;
    if (automatic && !strcmp(r->command_id, g->checkpoint.last_command)) return AG_DUPLICATE;
    if (g->active) return AG_BUSY;
    if (automatic) {
        if (!g->policy.automatic_enabled || !g->policy.profile_validated) return AG_DISABLED;
        if (!r->authorized || !r->hardware_ready || !r->evidence_fresh || !r->clock_valid) return AG_UNSAFE;
        if (!g->budget_restored || !r->night || r->night != g->checkpoint.night ||
            g->checkpoint.used >= g->policy.max_per_night) return AG_BUDGET;
        if (now < g->cooldown_until_ms) return AG_COOLDOWN;
        ag_checkpoint_t next = g->checkpoint;
        next.used++;
        strcpy(next.last_command, r->command_id);
        /* Commit budget and ID before enabling any output. */
        if (!g->save || !g->save(g->context, &next)) return AG_STORAGE;
        g->checkpoint = next;
    }
    g->source = r->source;
    g->deadline_ms = now + r->duration_ms;
    g->percent = r->percent;
    g->active = true;
    return AG_OK;
}

ag_result_t ag_adjust_manual(ag_guard_t *g, uint8_t percent) {
    if (g->stop_latched) return AG_STOPPED;
    if (!g->active || g->source != AG_MANUAL || !percent || percent > g->policy.max_percent) return AG_INVALID;
    g->percent = percent;
    return AG_OK;
}

ag_result_t ag_resume(ag_guard_t *g) {
    if (g->active) return AG_BUSY;
    ag_checkpoint_t next = g->checkpoint;
    next.stop_latched = false;
    if (!g->save || !g->save(g->context, &next)) return AG_STORAGE;
    g->checkpoint = next;
    g->stop_latched = false;
    return AG_OK;
}

const char *ag_result_name(ag_result_t result) {
    static const char *names[] = {"ok", "invalid", "disabled", "unsafe", "expired",
        "busy", "duplicate", "cooldown", "budget", "storage", "stopped"};
    return (unsigned)result < sizeof(names)/sizeof(names[0]) ? names[result] : "invalid";
}
