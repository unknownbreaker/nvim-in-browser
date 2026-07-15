/* shims/uv-wasi-threadpool.c
 *
 * WHAT: The internal work-queue API (uv__work_submit / uv__work_done /
 * uv__threadpool_cleanup) and its public face (uv_queue_work, uv_cancel)
 * for the single-threaded wasm32-wasi libuv port. Replaces upstream
 * src/threadpool.c.
 *
 * WHY / DESIGN: Upstream runs work_cb on a pool of worker threads and
 * posts completions back to the loop through the wq_async handle. With no
 * threads under WASI, uv__work_submit runs the work callback INLINE
 * (synchronously, at submit time) and then posts the completion to
 * loop->wq exactly like a worker would, waking the loop via
 * uv_async_send(&loop->wq_async). The done callback therefore still runs
 * asynchronously from the loop (on the next uv_run iteration), preserving
 * upstream's "done is never invoked reentrantly from submit" contract —
 * only the work callback's timing changes (it can no longer overlap the
 * loop, which is inherently true of a single-threaded target).
 *
 * uv_cancel: by the time a caller could cancel, the inline work has
 * already executed, which in upstream terms means "already running/ran" —
 * so cancellation always reports UV_EBUSY (honest).
 *
 * CLEAN-ROOM PROVENANCE: Contract and structure shapes from libuv v1.52.1
 * src/threadpool.c + include/uv/threadpool.h (MIT, vendored in
 * src-cache/libuv). No excluded project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <assert.h>
#include <stddef.h>

void uv__work_submit(uv_loop_t* loop,
                     struct uv__work* w,
                     enum uv__work_kind kind,
                     void (*work)(struct uv__work* w),
                     void (*done)(struct uv__work* w, int status)) {
  (void) kind;

  w->loop = loop;
  w->work = work;
  w->done = done;

  /* Run the "worker" part right now (there is nobody else to run it)... */
  w->work(w);

  /* ...then hand completion to the loop, exactly like a worker thread
   * finishing: queue on loop->wq and wake the loop's wq_async handle. The
   * done callback runs from uv__work_done on the next loop iteration. */
  w->work = NULL;  /* upstream marker for "no longer executing" */
  uv__queue_insert_tail(&loop->wq, &w->wq);
  uv_async_send(&loop->wq_async);
}

/* uv__work_cancel is not in any header (threadpool-private upstream); our
 * uv_cancel below is self-contained instead. */

void uv__work_done(uv_async_t* handle) {
  struct uv__work* w;
  uv_loop_t* loop;
  struct uv__queue* q;
  struct uv__queue wq;

  loop = handle->loop;
  uv__queue_move(&loop->wq, &wq);

  while (!uv__queue_empty(&wq)) {
    q = uv__queue_head(&wq);
    uv__queue_remove(q);

    w = uv__queue_data(q, struct uv__work, wq);
    /* Inline execution means work always completed successfully by the
     * time it lands here; cancellation is impossible (see uv_cancel). */
    w->done(w, 0);
  }
}

void uv__threadpool_cleanup(void) {
  /* No pool to tear down. */
}

/* --- public API ----------------------------------------------------------- */

static void uv__queue_work(struct uv__work* w) {
  uv_work_t* req = container_of(w, uv_work_t, work_req);

  req->work_cb(req);
}

static void uv__queue_done(struct uv__work* w, int err) {
  uv_work_t* req;

  req = container_of(w, uv_work_t, work_req);
  uv__req_unregister(req->loop);

  if (req->after_work_cb == NULL)
    return;

  req->after_work_cb(req, err);
}

int uv_queue_work(uv_loop_t* loop,
                  uv_work_t* req,
                  uv_work_cb work_cb,
                  uv_after_work_cb after_work_cb) {
  if (work_cb == NULL)
    return UV_EINVAL;

  uv__req_init(loop, req, UV_WORK);
  req->loop = loop;
  req->work_cb = work_cb;
  req->after_work_cb = after_work_cb;
  uv__work_submit(loop, &req->work_req, UV__WORK_CPU,
                  uv__queue_work, uv__queue_done);
  return 0;
}

int uv_cancel(uv_req_t* req) {
  switch (req->type) {
  case UV_FS:
  case UV_GETADDRINFO:
  case UV_GETNAMEINFO:
  case UV_RANDOM:
  case UV_WORK:
    /* Work always ran inline at submit time on this port. */
    return UV_EBUSY;
  default:
    return UV_EINVAL;
  }
}
