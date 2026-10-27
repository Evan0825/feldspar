#include "motor.h"

#include "esp_log.h"
#include "driver/ledc.h"
#include "driver/gpio.h"

static const char *TAG = "motor";

/* ---- 可调整配置：电机 PWM 与方向 GPIO、LEDC 定时器 ---- */
#define MOTOR_PWM_GPIO      1
#define MOTOR_DIR_GPIO      2

#define MOTOR_PWM_FREQ_HZ       20000
/* ESP32-S3 LEDC (APB 80MHz): 20kHz 下最大可行分频数 = floor(80M/20k) = 4000
 * ⇒ duty 分位数 ≤ 11 bit (2^11 = 2048)。13bit (8192) 仅支持到 ~9.76kHz，
 * 与 20kHz 组合会触发 "can not be achieved" 报错并 abort。 */
#define MOTOR_DUTY_RESOLUTION   LEDC_TIMER_11_BIT   /* 0..2047 */
#define MOTOR_MAX_DUTY          2047
#define MOTOR_MIN_START_PCT     5                   /* 克服死区的最小占空比% */

static bool s_inited = false;
static int16_t s_speed = 0;

static uint32_t speed_to_duty(int16_t speed)
{
    uint32_t pct;
    if (speed == 0) return 0;
    pct = (uint32_t)abs(speed);
    if (pct < MOTOR_MIN_START_PCT) pct = MOTOR_MIN_START_PCT;
    return pct * MOTOR_MAX_DUTY / 100;
}

esp_err_t motor_init(void)
{
    if (s_inited) return ESP_OK;

    gpio_config_t dir_cfg = {
        .pin_bit_mask = 1ULL << MOTOR_DIR_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&dir_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio config err: %d", err);
        return err;
    }

    ledc_timer_config_t timer = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = LEDC_TIMER_1,
        .freq_hz = MOTOR_PWM_FREQ_HZ,
        .duty_resolution = MOTOR_DUTY_RESOLUTION,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    err = ledc_timer_config(&timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "timer config err: %d", err);
        return err;
    }

    ledc_channel_config_t ch = {
        .gpio_num = MOTOR_PWM_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = LEDC_CHANNEL_3,
        .timer_sel = LEDC_TIMER_1,
        .intr_type = LEDC_INTR_DISABLE,
        .hpoint = 0,
        .duty = 0,
    };
    err = ledc_channel_config(&ch);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "pwm channel config err: %d", err);
        return err;
    }

    s_inited = true;
    ESP_LOGI(TAG, "motor init ok (pwm=gpio%d, dir=gpio%d)", MOTOR_PWM_GPIO, MOTOR_DIR_GPIO);
    return ESP_OK;
}

esp_err_t motor_set_speed(int16_t speed)
{
    if (!s_inited) return ESP_ERR_INVALID_STATE;
    if (speed > 100) speed = 100;
    if (speed < -100) speed = -100;

    s_speed = speed;

    /* 方向 */
    int dir = (speed > 0) ? 1 : 0;
    gpio_set_level(MOTOR_DIR_GPIO, dir);

    /* 占空比 */
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_3, speed_to_duty(speed));
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_3);

    ESP_LOGI(TAG, "motor speed=%d, dir=%d", (int)speed, dir);
    return ESP_OK;
}

esp_err_t motor_stop(void)
{
    return motor_set_speed(0);
}
