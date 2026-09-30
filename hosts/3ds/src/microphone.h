#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

bool microphone_capture_start(void);
size_t microphone_capture_read(uint8_t *output, size_t capacity);
void microphone_capture_stop(void);
void microphone_capture_shutdown(void);
