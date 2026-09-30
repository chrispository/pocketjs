/* All network service calls and key IO belong to this worker. The UI only
 * reads atomics and copies fixed-size SPSC slots. No mutex or socket on UI. */
#include "offload.h"
#include "soc.h"
#include "offload_queue.h"
#include <3ds.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef POCKETJS_OFFLOAD_KEY
#define POCKETJS_OFFLOAD_KEY "sdmc:/pocketjs/offload/unpaired.key"
#endif
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "Offload requires lock-free 32-bit atomics");
static OffloadQueue outgoing, incoming;
static _Atomic int connection;
static _Atomic bool running;
static Thread worker;
static unsigned sends, takes;
static _Atomic unsigned measured_frames, over_budget;
void offload_measure(unsigned us) {
  atomic_fetch_add_explicit(&measured_frames, 1, memory_order_relaxed);
  if (us > 16667) atomic_fetch_add_explicit(&over_budget, 1, memory_order_relaxed);
}
/* Phase costs summed and maxed over one metrics window, then reset by the
 * worker when it reports. A torn read across phases only blurs one window. */
enum { PHASE_JS, PHASE_TICK, PHASE_DRAW, PHASE_GPU, PHASE_GAP, PHASES };
static _Atomic unsigned phase_sum[PHASES], phase_max[PHASES], phase_frames, phase_slow;
void offload_measure_phases(unsigned js, unsigned tick, unsigned draw, unsigned gpu, unsigned interval) {
  const unsigned values[PHASES] = { js, tick, draw, gpu, interval };
  for (int i = 0; i < PHASES; i++) {
    atomic_fetch_add_explicit(&phase_sum[i], values[i], memory_order_relaxed);
    if (values[i] > atomic_load_explicit(&phase_max[i], memory_order_relaxed))
      atomic_store_explicit(&phase_max[i], values[i], memory_order_relaxed);
  }
  atomic_fetch_add_explicit(&phase_frames, 1, memory_order_relaxed);
  /* 1.5 frames at 60 Hz: the frame missed its vblank. */
  if (interval > 25000) atomic_fetch_add_explicit(&phase_slow, 1, memory_order_relaxed);
}
static OffloadRecord ui_record;

void offload_frame(void) { sends = takes = 0; }
int offload_session(void) { return atomic_load_explicit(&connection, memory_order_acquire); }
bool offload_submit(const char *bytes, size_t length) {
  int epoch = offload_session();
  if (epoch <= 0 || sends >= 2 || length > OFFLOAD_BYTES) return false;
  sends++;
  return offload_push(&outgoing, bytes, (uint32_t)length, (uint32_t)epoch);
}
size_t offload_take(char *out) {
  if (takes++ >= 1 || !offload_pop(&incoming, &ui_record)) return 0;
  if ((int)ui_record.generation != offload_session()) return 0;
  memcpy(out, ui_record.bytes, ui_record.length);
  return ui_record.length;
}
static bool transfer(int fd, char *p, size_t n, bool send_data) {
  u64 deadline = osGetTime() + 10000;
  while (n && atomic_load(&running)) {
    int done = send_data ? send(fd, p, n, 0) : recv(fd, p, n, 0);
    if (done > 0) { n -= (size_t)done; p += done; continue; }
    if (done == 0 || (errno != EAGAIN && errno != EWOULDBLOCK) || osGetTime() > deadline) return false;
    svcSleepThread(1000000);
  }
  return n == 0;
}
/* One send per record. libctru's TCP_NODELAY is an enum, not a macro, so
 * an #ifdef guard compiled the option out and left Nagle on; the length
 * header then went alone and the body waited for its ACK, ~200 ms per
 * record over Wi-Fi. One buffer also keeps the pair in one segment. */
static char tx[OFFLOAD_BYTES + 4];
static bool send_record(int fd, const char *bytes, uint32_t length) {
  uint32_t header = htonl(length);
  memcpy(tx, &header, 4); memcpy(tx + 4, bytes, length);
  return transfer(fd, tx, length + 4, true);
}
static void serve(void *unused) {
  (void)unused;
  char key[64];
  FILE *file = fopen(POCKETJS_OFFLOAD_KEY, "rb");
  if (!file) return;
  size_t count = fread(key, 1, sizeof key, file);
  fclose(file);
  if (count != sizeof key) return;
  /* Retry on this worker; a competing initializer never makes the UI wait. */
  while (atomic_load(&running) && !soc_ensure(NULL, 0)) svcSleepThread(10000000);
  if (!atomic_load(&running)) return;
  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) return;
  int reuse = 1;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(8741), .sin_addr.s_addr = INADDR_ANY };
  if (bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1)) goto close_listener;
  fcntl(listener, F_SETFL, O_NONBLOCK);
  int generation = 0;
  while (atomic_load(&running)) {
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) { svcSleepThread(10000000); continue; }
    fcntl(fd, F_SETFL, O_NONBLOCK);
    int no_delay = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &no_delay, sizeof no_delay);
    char offered[64]; unsigned mismatch = 0;
    if (!transfer(fd, offered, sizeof offered, false)) { close(fd); continue; }
    for (unsigned i = 0; i < sizeof key; i++) mismatch |= key[i] ^ offered[i];
    if (mismatch) { close(fd); continue; }
    generation++;
    atomic_store_explicit(&connection, generation, memory_order_release);
    OffloadRecord record;
    char rx[OFFLOAD_BYTES + 4]; size_t have = 0, want = 4;
    u64 last_progress = osGetTime();
    bool alive = true, ready = false;
    u64 metrics_at = osGetTime();
    while (alive && atomic_load(&running)) {
      if (osGetTime() - metrics_at >= 2000) {
        metrics_at = osGetTime();
        unsigned mean[PHASES], peak[PHASES];
        unsigned n = atomic_exchange(&phase_frames, 0), slow = atomic_exchange(&phase_slow, 0);
        for (int i = 0; i < PHASES; i++) {
          unsigned sum = atomic_exchange(&phase_sum[i], 0);
          mean[i] = n ? sum / n : 0; peak[i] = atomic_exchange(&phase_max[i], 0);
        }
        /* The companion rejects a metrics payload over 160 characters; the
         * window's phases are mean/max microseconds. */
        char payload[161];
        snprintf(payload, sizeof payload,
          "frames=%u over16ms=%u n=%u slow=%u js=%u/%u tick=%u/%u draw=%u/%u gpu=%u/%u gap=%u/%u",
          atomic_load(&measured_frames), atomic_load(&over_budget), n, slow,
          mean[PHASE_JS], peak[PHASE_JS], mean[PHASE_TICK], peak[PHASE_TICK], mean[PHASE_DRAW], peak[PHASE_DRAW],
          mean[PHASE_GPU], peak[PHASE_GPU], mean[PHASE_GAP], peak[PHASE_GAP]);
        char metrics[256];
        int size = snprintf(metrics, sizeof metrics,
          "{\"v\":1,\"id\":0,\"method\":\"offload.metrics\",\"payload\":\"%s\"}", payload);
        alive = send_record(fd, metrics, (uint32_t)size);
        if (!alive) break;
      }
      if (offload_pop(&outgoing, &record) && record.generation == (uint32_t)generation) {
        alive = send_record(fd, record.bytes, record.length);
      }
      if (ready) {
        if (offload_push(&incoming, rx + 4, (uint32_t)(want - 4), (uint32_t)generation)) { ready = false; have = 0; want = 4; }
      } else {
        int n = recv(fd, rx + have, want - have, 0);
        if (n > 0) {
          have += (size_t)n; last_progress = osGetTime();
          if (have == 4 && want == 4) {
            uint32_t length; memcpy(&length, rx, 4); length = ntohl(length);
            if (!length || length > OFFLOAD_BYTES) { alive = false; continue; }
            want = 4 + length;
          } else if (have == want) ready = true;
        } else if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) alive = false;
        if (have && osGetTime() - last_progress > 10000) alive = false;
      }
      svcSleepThread(1000000);
    }
    atomic_store_explicit(&connection, -generation, memory_order_release);
    close(fd);
  }
close_listener:
  close(listener);
  /* Process-wide SOC stays alive until every transport has stopped. */
}
bool offload_start(void) {
  atomic_store(&running, true);
  /* Lower priority than rendering; core -2 supports Old and New 3DS. */
  worker = threadCreate(serve, NULL, 32 * 1024, 0x3f, -2, false);
  return worker != NULL;
}
void offload_stop(void) {
  atomic_store(&running, false);
  if (worker) { threadJoin(worker, U64_MAX); threadFree(worker); worker = NULL; }
}
