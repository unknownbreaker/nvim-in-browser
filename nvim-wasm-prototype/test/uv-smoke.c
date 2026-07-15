/* test/uv-smoke.c — ladder rung 3 acceptance gate for the wasm32-wasi
 * libuv port (shims/ + patches/libuv-wasi.patch).
 *
 * What it proves, in one uv_run():
 *   1. uv_loop_init() succeeds (platform hooks, threads/async/threadpool
 *      shims all engaged during init);
 *   2. a 10ms uv_timer fires — and only after >= 10ms of real time, which
 *      requires the poll_oneoff clock subscription to actually sleep;
 *   3. a line arriving on stdin (fd 0, uv_pipe/uv_stream read path through
 *      the poll_oneoff fd_read subscription) is read and echoed verbatim
 *      to stdout (fd 1) via uv_write;
 *   4. every handle closes cleanly, uv_run() drains to 0, and
 *      uv_loop_close() returns 0.
 *
 * Exits 0 and prints "UV-SMOKE PASS" on stderr iff all of the above hold.
 * Run under Node's WASI host with piped stdin: see test/uv-smoke.sh.
 *
 * Clean-room provenance: written against libuv's public API documentation
 * only; no excluded project consulted.
 */

#include <uv.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uv_loop_t loop;
static uv_timer_t timer;
static uv_pipe_t stdin_pipe;
static uv_pipe_t stdout_pipe;
static uv_write_t write_req;

static uint64_t start_ms;
static int timer_fired = 0;
static int line_echoed = 0;
static int write_completed = 0;
static int failures = 0;

static char read_buf[4096];
static char line_buf[4096];
static size_t line_len = 0;

static void fail(const char* what) {
  fprintf(stderr, "UV-SMOKE FAIL: %s\n", what);
  failures++;
}

static void maybe_finish(void) {
  if (!timer_fired || !write_completed)
    return;
  /* Both events observed: tear everything down so uv_run can drain. */
  uv_close((uv_handle_t*) &stdin_pipe, NULL);
  uv_close((uv_handle_t*) &stdout_pipe, NULL);
  /* timer already stopped itself (no repeat); close it too */
  uv_close((uv_handle_t*) &timer, NULL);
}

static void on_timer(uv_timer_t* t) {
  uint64_t elapsed = uv_now(t->loop) - start_ms;

  timer_fired = 1;
  fprintf(stderr, "uv-smoke: timer fired after %llu ms\n",
          (unsigned long long) elapsed);
  if (elapsed < 10)
    fail("timer fired before its 10ms timeout");
  if (elapsed > 5000)
    fail("timer took implausibly long (loop stalled?)");
  maybe_finish();
}

static void on_write(uv_write_t* req, int status) {
  (void) req;
  if (status != 0)
    fail(uv_strerror(status));
  write_completed = 1;
  fprintf(stderr, "uv-smoke: echo write completed (status=%d)\n", status);
  maybe_finish();
}

static void on_alloc(uv_handle_t* handle, size_t suggested, uv_buf_t* buf) {
  (void) handle;
  (void) suggested;
  buf->base = read_buf;
  buf->len = sizeof(read_buf);
}

static void on_read(uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
  if (nread == UV_EOF) {
    if (!line_echoed)
      fail("stdin closed before a full line arrived");
    uv_read_stop(stream);
    return;
  }
  if (nread < 0) {
    fail(uv_strerror((int) nread));
    uv_read_stop(stream);
    maybe_finish();
    return;
  }

  if (line_len + (size_t) nread >= sizeof(line_buf)) {
    fail("line too long");
    return;
  }
  memcpy(line_buf + line_len, buf->base, (size_t) nread);
  line_len += (size_t) nread;

  if (line_echoed)
    return;

  if (memchr(line_buf, '\n', line_len) == NULL)
    return;  /* keep reading until a full line is in */

  line_echoed = 1;
  fprintf(stderr, "uv-smoke: got %zu-byte line from stdin\n", line_len);
  uv_read_stop(stream);

  uv_buf_t out = uv_buf_init(line_buf, (unsigned int) line_len);
  int rc = uv_write(&write_req, (uv_stream_t*) &stdout_pipe, &out, 1,
                    on_write);
  if (rc != 0) {
    fail(uv_strerror(rc));
    write_completed = 1;  /* unblock teardown */
    maybe_finish();
  }
}

int main(void) {
  int rc;

  rc = uv_loop_init(&loop);
  if (rc != 0) {
    fprintf(stderr, "UV-SMOKE FAIL: uv_loop_init: %s\n", uv_strerror(rc));
    return 1;
  }
  start_ms = uv_now(&loop);

  rc = uv_timer_init(&loop, &timer);
  if (rc == 0)
    rc = uv_timer_start(&timer, on_timer, 10, 0);
  if (rc != 0) {
    fprintf(stderr, "UV-SMOKE FAIL: timer setup: %s\n", uv_strerror(rc));
    return 1;
  }

  rc = uv_pipe_init(&loop, &stdin_pipe, 0);
  if (rc == 0)
    rc = uv_pipe_open(&stdin_pipe, 0);
  if (rc != 0) {
    fprintf(stderr, "UV-SMOKE FAIL: stdin pipe: %s\n", uv_strerror(rc));
    return 1;
  }

  rc = uv_pipe_init(&loop, &stdout_pipe, 0);
  if (rc == 0)
    rc = uv_pipe_open(&stdout_pipe, 1);
  if (rc != 0) {
    fprintf(stderr, "UV-SMOKE FAIL: stdout pipe: %s\n", uv_strerror(rc));
    return 1;
  }

  rc = uv_read_start((uv_stream_t*) &stdin_pipe, on_alloc, on_read);
  if (rc != 0) {
    fprintf(stderr, "UV-SMOKE FAIL: uv_read_start: %s\n", uv_strerror(rc));
    return 1;
  }

  rc = uv_run(&loop, UV_RUN_DEFAULT);
  if (rc != 0)
    fail("uv_run returned nonzero (loop did not drain)");

  if (!timer_fired)
    fail("timer never fired");
  if (!line_echoed)
    fail("stdin line never echoed");
  if (!write_completed)
    fail("echo write never completed");

  rc = uv_loop_close(&loop);
  if (rc != 0)
    fail("uv_loop_close returned nonzero");

  if (failures == 0) {
    fprintf(stderr, "UV-SMOKE PASS\n");
    return 0;
  }
  fprintf(stderr, "UV-SMOKE: %d failure(s)\n", failures);
  return 1;
}
