idf_component_register(
    SRCS "mic.c"
    INCLUDE_DIRS "include"
    REQUIRES driver acoustic_features
    PRIV_REQUIRES esp_timer haptic audio
)
