/* shims/uv-wasi-async.c
 *
 * WHAT: uv_async_t for the single-threaded wasm32-wasi libuv port —
 * uv_async_init/uv_async_send plus the internal hooks the rest of libuv
 * references (uv__async_io, uv__async_close, uv__async_stop,
 * uv__async_fork). Replaces upstream src/unix/async.c.
 *
 * WHY / DESIGN: Upstream async wakeups exist so *other threads* can
 * interrupt a loop blocked in the kernel: uv_async_send writes to an
 * eventfd/pipe the loop watches. Under single-threaded WASI there is no
 * pipe(2), no eventfd, and — crucially — no other thread: uv_async_send
 * can only ever run from the loop thread itself (inside some callback),
 * i.e. never while the loop is blocked in poll_oneoff. So no wakeup fd is
 * needed at all. Instead, send is "set the handle's pending flag and feed
 * the loop's async io-watcher into the pending queue". That has exactly
 * the right uv_run semantics for free, using only upstream machinery:
 *
 *   - a fed pending_queue makes uv_backend_timeout() return 0, so the
 *     next uv__io_poll cannot block — callbacks run promptly;
 *   - uv__run_pending dispatches the watcher through uv__io_cb's
 *     UV__ASYNC_IO case to our uv__async_io, which walks
 *     loop->async_handles and invokes callbacks whose pending flag is
 *     set — same drain shape as upstream;
 *   - when nothing is pending the loop still sleeps fully (rung-8
 *     idle-wakeups requirement: no polling, no spinning).
 *
 * The loop's async_io_watcher stays fd-less (fd == -1) and is therefore
 * never registered with the poll set; it is only ever dispatched via the
 * pending queue.
 *
 * CLEAN-ROOM PROVENANCE: Interface contract and handle bookkeeping
 * conventions from libuv v1.52.1 sources/docs (MIT, vendored in
 * src-cache/libuv). No excluded project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <assert.h>
#include <stddef.h>

/* Lazily initialize the loop's fd-less async watcher. uv_loop_init
 * memsets the loop, so a NULL pending_queue head means "not yet
 * initialized" (uv__io_init sets up both queues). The first uv_async_init
 * on a loop always runs during uv_loop_init itself (the internal
 * wq_async handle), so this is initialized before any user handle. */
static void uv__wasi_async_watcher_init(uv_loop_t* loop) {
  if (loop->async_io_watcher.pending_queue.next == NULL)
    uv__io_init(&loop->async_io_watcher, UV__ASYNC_IO, -1);
}

int uv_async_init(uv_loop_t* loop, uv_async_t* handle, uv_async_cb async_cb) {
  uv__wasi_async_watcher_init(loop);

  uv__handle_init(loop, (uv_handle_t*) handle, UV_ASYNC);
  handle->async_cb = async_cb;
  handle->pending = 0;

  uv__queue_insert_tail(&loop->async_handles, &handle->queue);
  uv__handle_start(handle);

  return 0;
}

int uv_async_send(uv_async_t* handle) {
  if (handle->pending != 0)
    return 0;

  handle->pending = 1;
  uv__io_feed(handle->loop, &handle->loop->async_io_watcher);
  return 0;
}

void uv__async_io(uv_loop_t* loop, uv__io_t* w, unsigned int events) {
  struct uv__queue queue;
  struct uv__queue* q;
  uv_async_t* h;

  (void) events;
  assert(w == &loop->async_io_watcher);

  /* Move the list aside so callbacks can safely init/close/send async
   * handles while we iterate (same drain shape as upstream async.c). */
  uv__queue_move(&loop->async_handles, &queue);
  while (!uv__queue_empty(&queue)) {
    q = uv__queue_head(&queue);
    h = uv__queue_data(q, uv_async_t, queue);

    uv__queue_remove(q);
    uv__queue_insert_tail(&loop->async_handles, q);

    if (h->pending == 0)
      continue;
    h->pending = 0;

    if (h->async_cb == NULL)
      continue;

    h->async_cb(h);
  }
}

void uv__async_close(uv_async_t* handle) {
  handle->pending = 0;
  uv__queue_remove(&handle->queue);
  uv__handle_stop(handle);
}

void uv__async_stop(uv_loop_t* loop) {
  /* No wakeup fd to tear down on this port. */
  (void) loop;
}

int uv__async_fork(uv_loop_t* loop) {
  /* No fork() under WASI; nothing to re-arm. */
  (void) loop;
  return 0;
}
