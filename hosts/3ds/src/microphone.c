#include "microphone.h"

#include <3ds.h>
#include <3ds/allocator/linear.h>
#include <3ds/services/mic.h>
#include <stdlib.h>
#include <string.h>

#define MIC_SHARED_BYTES 0x10000

static uint8_t *shared_memory;
static uint32_t read_offset;
static bool initialized;
static bool sampling;

bool microphone_capture_start(void) {
  if (sampling) return true;
  if (shared_memory == NULL) shared_memory = linearAlloc(MIC_SHARED_BYTES);
  if (shared_memory == NULL) return false;

  if (initialized) {
    micExit();
    initialized = false;
  }
  if (R_FAILED(micInit(shared_memory, MIC_SHARED_BYTES))) return false;
  initialized = true;

  const uint32_t sample_bytes = micGetSampleDataSize();
  if (sample_bytes < 4 ||
      R_FAILED(MICU_StartSampling(MICU_ENCODING_PCM16_SIGNED,
                                 MICU_SAMPLE_RATE_16360,
                                 0,
                                 sample_bytes,
                                 true))) {
    micExit();
    initialized = false;
    return false;
  }

  /* Start at the next sample so stale bytes from an earlier recording are
   * never exposed to the app. The shared ring wraps on a 16-bit boundary. */
  read_offset = (micGetLastSampleOffset() + 2) % sample_bytes;
  sampling = true;
  return true;
}

size_t microphone_capture_read(uint8_t *output, size_t capacity) {
  if (!initialized || shared_memory == NULL || output == NULL || capacity < 2) return 0;
  const uint32_t sample_bytes = micGetSampleDataSize();
  if (sample_bytes < 4) return 0;

  const uint32_t end = (micGetLastSampleOffset() + 2) % sample_bytes;
  uint32_t available = (end + sample_bytes - read_offset) % sample_bytes;
  available &= ~1u;
  size_t count = available;
  if (count > capacity) count = capacity & ~(size_t)1;
  if (count == 0) return 0;

  const size_t first = count < sample_bytes - read_offset ? count : sample_bytes - read_offset;
  memcpy(output, shared_memory + read_offset, first);
  if (first < count) memcpy(output + first, shared_memory, count - first);
  read_offset = (read_offset + (uint32_t)count) % sample_bytes;
  return count;
}

void microphone_capture_stop(void) {
  if (!sampling) return;
  MICU_StopSampling();
  sampling = false;
}

void microphone_capture_shutdown(void) {
  microphone_capture_stop();
  if (initialized) {
    micExit();
    initialized = false;
  }
  if (shared_memory != NULL) {
    linearFree(shared_memory);
    shared_memory = NULL;
  }
  read_offset = 0;
}
