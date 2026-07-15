/* shims/uv-wasi-signal.c
 *
 * WHAT: uv_signal_t for the wasm32-wasi libuv port — the public
 * uv_signal_* API plus the internal hooks other libuv files reference
 * (uv__signal_global_once_init, uv__signal_loop_cleanup,
 * uv__signal_loop_fork, uv__signal_close, uv__signal_event,
 * uv__signal_cleanup). Replaces upstream src/unix/signal.c.
 *
 * WHY / DESIGN: "Register and never fire." WASI preview1 has no
 * asynchronous signal delivery at all (wasi-libc's emulated <signal.h>
 * only supports raise() of synchronous signals), so a faithful port
 * cannot ever invoke a signal callback. But Neovim registers handlers for
 * SIGHUP/SIGTERM/etc. at startup and treats registration failure as an
 * error, so uv_signal_start must SUCCEED and simply never fire — the
 * handle behaves like a valid watcher for a condition that cannot occur.
 * Signal numbers are validated against the emulated <signal.h> range so
 * garbage input still fails with UV_EINVAL like upstream.
 *
 * CLEAN-ROOM PROVENANCE: API contract from libuv v1.52.1 include/uv.h,
 * src/unix/signal.c structure (MIT, vendored in src-cache/libuv), and the
 * WASI preview1 spec (absence of signal delivery). No excluded project
 * consulted.
 */

#include "uv.h"
#include "internal.h"

#include <signal.h>
#include <stddef.h>

#ifndef _NSIG
#define _NSIG 65  /* matches wasi-libc's emulated signal numbering */
#endif

void uv__signal_global_once_init(void) {
  /* Upstream installs a fork-safe self-pipe here; nothing to do. */
}

void uv__signal_cleanup(void) {
}

void uv__signal_loop_cleanup(uv_loop_t* loop) {
  (void) loop;
}

int uv__signal_loop_fork(uv_loop_t* loop) {
  (void) loop;
  return 0;
}

int uv_signal_init(uv_loop_t* loop, uv_signal_t* handle) {
  uv__handle_init(loop, (uv_handle_t*) handle, UV_SIGNAL);
  handle->signum = 0;
  handle->caught_signals = 0;
  handle->dispatched_signals = 0;
  return 0;
}

static int uv__signal_start(uv_signal_t* handle,
                            uv_signal_cb signal_cb,
                            int signum) {
  if (uv__is_closing(handle))
    return UV_EINVAL;

  /* Same range check idea as upstream: reject obvious garbage. _NSIG is
   * 65 in the emulated <signal.h>. */
  if (signum <= 0 || signum >= _NSIG)
    return UV_EINVAL;

  /* No OS handler to install: signals cannot be delivered under WASI.
   * Record the registration and keep the handle active so the loop
   * reflects a live watcher; the callback will simply never run. */
  handle->signum = signum;
  handle->signal_cb = signal_cb;
  uv__handle_start(handle);

  return 0;
}

int uv_signal_start(uv_signal_t* handle, uv_signal_cb signal_cb, int signum) {
  return uv__signal_start(handle, signal_cb, signum);
}

int uv_signal_start_oneshot(uv_signal_t* handle,
                            uv_signal_cb signal_cb,
                            int signum) {
  return uv__signal_start(handle, signal_cb, signum);
}

int uv_signal_stop(uv_signal_t* handle) {
  if (uv__is_active(handle)) {
    handle->signum = 0;
    uv__handle_stop(handle);
  }
  return 0;
}

void uv__signal_close(uv_signal_t* handle) {
  uv_signal_stop(handle);
}

void uv__signal_event(uv_loop_t* loop, uv__io_t* w, unsigned int events) {
  /* No signal io-watcher is ever registered on this port. */
  (void) loop;
  (void) w;
  (void) events;
  UNREACHABLE();
}
