/* shims/uv-wasi-poll.c
 *
 * WHAT: The platform polling core of the wasm32-wasi libuv port —
 * uv__io_poll() plus the platform loop hooks (uv__platform_loop_init/
 * delete, uv__platform_invalidate_fd, uv__io_check_fd, uv__io_fork).
 * This is the file that replaces epoll.c/kqueue.c on this target.
 *
 * WHY / DESIGN: wasi-libc implements poll(2) on top of the WASI preview1
 * poll_oneoff() syscall: every pollfd POLLIN/POLLOUT becomes an fd_read/
 * fd_write subscription and a finite timeout becomes a monotonic-clock
 * subscription, so a single blocking poll() call gives us exactly the
 * event-driven wait libuv needs (verified empirically under Node 24's
 * node:wasi host: pure-timeout waits block for the right duration, and
 * fd_read subscriptions on piped stdin block until data arrives).
 *
 * The implementation is modeled directly on libuv's own portable
 * src/unix/posix-poll.c (MIT, in this source tree) with two deliberate
 * differences for the single-threaded WASI world:
 *
 *   1. NO BUSY-WAIT, EVER. Upstream's uv__io_poll returns immediately
 *      when no fds are watched (loop->nfds == 0); that is safe upstream
 *      only because every loop owns an async wakeup fd, so nfds >= 1
 *      always. Our async shim (uv-wasi-async.c) is fd-less, so a
 *      timer-only loop really can have nfds == 0 — in that case we must
 *      still SLEEP the full timeout via a pure clock subscription
 *      (poll(NULL, 0, timeout)), otherwise uv_run would spin hot until
 *      the timer expires. This property is also what makes the eventual
 *      Neovim build idle-when-idle (ladder rung 8's wakeup gate).
 *
 *   2. No signal masking (upstream blocks SIGPROF around poll() when
 *      UV_LOOP_BLOCK_SIGPROF is set). WASI has no signal delivery, so the
 *      sigset plumbing (uv__io_poll_prepare/check) is intentionally not
 *      called; the loop flag is accepted and ignored.
 *
 * Uses the `poll_fds` platform loop fields from uv/posix.h (enabled for
 * __wasi__ by patches/libuv-wasi.patch).
 *
 * CLEAN-ROOM PROVENANCE: Derived from libuv v1.52.1 src/unix/posix-poll.c
 * (MIT license, vendored in src-cache/libuv) + the WASI preview1
 * poll_oneoff specification + wasi-libc's poll() semantics. No excluded
 * project (MuNeNICK/nvim-wasm, MuNeNICK/monaco-neovim-wasm) was consulted
 * in any form.
 */

#include "uv.h"
#include "internal.h"

#include <assert.h>
#include <errno.h>
#include <limits.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int uv__platform_loop_init(uv_loop_t* loop) {
  loop->poll_fds = NULL;
  loop->poll_fds_used = 0;
  loop->poll_fds_size = 0;
  loop->poll_fds_iterating = 0;
  return 0;
}

void uv__platform_loop_delete(uv_loop_t* loop) {
  uv__free(loop->poll_fds);
  loop->poll_fds = NULL;
}

int uv__io_fork(uv_loop_t* loop) {
  /* There is no fork() under WASI; keep the upstream contract anyway. */
  uv__platform_loop_delete(loop);
  return uv__platform_loop_init(loop);
}

/* Allocate or dynamically resize our poll fds array. */
static void uv__pollfds_maybe_resize(uv_loop_t* loop) {
  size_t i;
  size_t n;
  struct pollfd* p;

  if (loop->poll_fds_used < loop->poll_fds_size)
    return;

  n = loop->poll_fds_size ? loop->poll_fds_size * 2 : 64;
  p = uv__reallocf(loop->poll_fds, n * sizeof(*loop->poll_fds));
  if (p == NULL)
    abort();

  loop->poll_fds = p;
  for (i = loop->poll_fds_size; i < n; i++) {
    loop->poll_fds[i].fd = -1;
    loop->poll_fds[i].events = 0;
    loop->poll_fds[i].revents = 0;
  }
  loop->poll_fds_size = n;
}

/* Add a watcher's fd to our poll fds array with its pending events. */
static void uv__pollfds_add(uv_loop_t* loop, uv__io_t* w) {
  size_t i;
  struct pollfd* pe;

  /* If the fd is already in the set just update its events. */
  assert(!loop->poll_fds_iterating);
  for (i = 0; i < loop->poll_fds_used; ++i) {
    if (loop->poll_fds[i].fd == w->fd) {
      loop->poll_fds[i].events = w->pevents;
      return;
    }
  }

  /* Otherwise, allocate a new slot in the set for the fd. */
  uv__pollfds_maybe_resize(loop);
  pe = &loop->poll_fds[loop->poll_fds_used++];
  pe->fd = w->fd;
  pe->events = w->pevents;
}

/* Remove a watcher's fd from our poll fds array. */
static void uv__pollfds_del(uv_loop_t* loop, int fd) {
  size_t i;
  assert(!loop->poll_fds_iterating);
  for (i = 0; i < loop->poll_fds_used;) {
    if (loop->poll_fds[i].fd == fd) {
      /* swap to last position and remove */
      --loop->poll_fds_used;
      loop->poll_fds[i] = loop->poll_fds[loop->poll_fds_used];
      loop->poll_fds[loop->poll_fds_used].fd = -1;
      loop->poll_fds[loop->poll_fds_used].events = 0;
      loop->poll_fds[loop->poll_fds_used].revents = 0;
      /* This method is called with an fd of -1 to purge the invalidated
       * fds, so we may possibly have multiples to remove. */
      if (-1 != fd)
        return;
    } else {
      /* We must only increment the loop counter when the fds do not
       * match. Otherwise, when we are purging an invalidated fd, the
       * value just swapped here from the previous end of the array will
       * be skipped. */
      ++i;
    }
  }
}

/* Sleep without watching any fds: a pure monotonic-clock subscription via
 * wasi-libc poll(NULL, 0, ms). Never spins. A negative timeout means
 * "block forever"; since nothing outside the loop can wake a
 * single-threaded WASI program, that is served as repeated long sleeps
 * (an honest reflection of "this program is now permanently idle").
 *
 * poll()'s return is checked: a host whose poll_oneoff rejects a clock-only
 * subscription (or otherwise errors) must not be allowed to fail silently
 * -- ignoring rc here would either busy-spin this function's infinite loop
 * (rc<0 every iteration, no actual sleeping) or return "done" immediately on
 * the finite branch when no time has actually elapsed, both of which
 * violate this port's no-busy-wait invariant. EINTR is the one expected,
 * recoverable errno (a spurious wake with nothing to report) -- just
 * recompute and continue the wait. Anything else is a genuinely unexpected
 * host/libc condition, so it aborts loudly, consistent with this file's
 * other abort-on-unexpected-errno handling in uv__io_poll below. */
static void uv__wasi_sleep(int timeout) {
  static const int chunk_ms = 3600 * 1000;
  int rc;

  if (timeout == 0)
    return;

  if (timeout < 0) {
    for (;;) {
      rc = poll(NULL, 0, chunk_ms);
      if (rc < 0 && errno != EINTR) {
        fprintf(stderr,
                "libuv-wasi: uv__wasi_sleep: poll() failed unexpectedly "
                "(errno=%d)\n",
                errno);
        abort();
      }
    }
  }

  rc = poll(NULL, 0, timeout);
  if (rc < 0 && errno != EINTR) {
    fprintf(stderr,
            "libuv-wasi: uv__wasi_sleep: poll() failed unexpectedly "
            "(errno=%d)\n",
            errno);
    abort();
  }
}

void uv__io_poll(uv_loop_t* loop, int timeout) {
  uv__loop_internal_fields_t* lfields;
  uint64_t time_base;
  uint64_t time_diff;
  struct uv__queue* q;
  uv__io_t* w;
  size_t i;
  unsigned int nevents;
  int nfds;
  struct pollfd* pe;
  int fd;
  int user_timeout;
  int reset_timeout;

  lfields = uv__get_internal_fields(loop);

  if (loop->nfds == 0) {
    assert(uv__queue_empty(&loop->watcher_queue));
    /* Deliberate deviation from upstream posix-poll.c (which returns
     * immediately here): with no async wakeup fd on this port, returning
     * without sleeping would busy-spin uv_run until the next timer. Sleep
     * the full backend timeout on a WASI clock subscription instead. */
    uv__wasi_sleep(timeout);
    return;
  }

  /* Take queued watchers and add their fds to our poll fds array. */
  while (!uv__queue_empty(&loop->watcher_queue)) {
    q = uv__queue_head(&loop->watcher_queue);
    uv__queue_remove(q);
    uv__queue_init(q);

    w = uv__queue_data(q, uv__io_t, watcher_queue);
    assert(w->pevents != 0);
    assert(w->fd >= 0);
    assert(w->fd < (int) loop->nwatchers);

    uv__pollfds_add(loop, w);

    w->events = w->pevents;
  }

  assert(timeout >= -1);
  time_base = loop->time;

  if (lfields->flags & UV_METRICS_IDLE_TIME) {
    reset_timeout = 1;
    user_timeout = timeout;
    timeout = 0;
  } else {
    reset_timeout = 0;
  }

  /* Loop calls to poll() and processing of results. If we get some
   * results from poll() but they turn out not to be interesting to
   * our caller then we need to loop around and poll() again. */
  for (;;) {
    if (timeout != 0)
      uv__metrics_set_provider_entry_time(loop);

    nfds = poll(loop->poll_fds, (nfds_t) loop->poll_fds_used, timeout);

    if (nfds == 0) {
      if (reset_timeout != 0) {
        timeout = user_timeout;
        reset_timeout = 0;
        if (timeout == -1)
          continue;
        if (timeout > 0)
          goto update_timeout;
      }

      assert(timeout != -1);
      return;
    }

    if (nfds == -1) {
      if (errno != EINTR)
        abort();

      if (reset_timeout != 0) {
        timeout = user_timeout;
        reset_timeout = 0;
      }

      if (timeout == -1)
        continue;

      if (timeout == 0)
        return;

      /* Interrupted by a signal. Update timeout and poll again. */
      goto update_timeout;
    }

    /* Tell uv__platform_invalidate_fd not to manipulate our array
     * while we are iterating over it. */
    loop->poll_fds_iterating = 1;

    /* Initialize a count of events that we care about. */
    nevents = 0;

    /* Loop over the entire poll fds array looking for returned events. */
    for (i = 0; i < loop->poll_fds_used; i++) {
      pe = loop->poll_fds + i;
      fd = pe->fd;

      /* Skip invalidated events, see uv__platform_invalidate_fd. */
      if (fd == -1)
        continue;

      assert(fd >= 0);
      assert((unsigned) fd < loop->nwatchers);

      w = loop->watchers[fd];

      if (w == NULL) {
        /* File descriptor that we've stopped watching, ignore. */
        uv__platform_invalidate_fd(loop, fd);
        continue;
      }

      /* Filter out events that the user has not requested us to watch
       * (e.g. POLLNVAL). */
      pe->revents &= w->pevents | POLLERR | POLLHUP;

      if (pe->revents != 0) {
        uv__metrics_update_idle_time(loop);
        uv__io_cb(loop, w, pe->revents);
        nevents++;
      }
    }

    uv__metrics_inc_events(loop, nevents);
    if (reset_timeout != 0) {
      timeout = user_timeout;
      reset_timeout = 0;
      uv__metrics_inc_events_waiting(loop, nevents);
    }

    loop->poll_fds_iterating = 0;

    /* Purge invalidated fds from our poll fds array. */
    uv__pollfds_del(loop, -1);

    if (nevents != 0)
      return;

    if (timeout == 0)
      return;

    if (timeout == -1)
      continue;

update_timeout:
    assert(timeout > 0);

    uv__update_time(loop);
    time_diff = loop->time - time_base;
    if (time_diff >= (uint64_t) timeout)
      return;

    timeout -= time_diff;
  }
}

/* Remove the given fd from our poll fds array because no one
 * is interested in its events anymore. */
void uv__platform_invalidate_fd(uv_loop_t* loop, int fd) {
  size_t i;

  assert(fd >= 0);

  if (loop->poll_fds_iterating) {
    /* uv__io_poll is currently iterating; just invalidate the fd. */
    for (i = 0; i < loop->poll_fds_used; i++)
      if (loop->poll_fds[i].fd == fd) {
        loop->poll_fds[i].fd = -1;
        loop->poll_fds[i].events = 0;
        loop->poll_fds[i].revents = 0;
      }
  } else {
    /* uv__io_poll is not iterating; delete the fd from the set. */
    uv__pollfds_del(loop, fd);
  }
}

/* Check whether the given fd is supported by poll(). */
int uv__io_check_fd(uv_loop_t* loop, int fd) {
  struct pollfd p[1];
  int rv;

  p[0].fd = fd;
  p[0].events = POLLIN;

  do
    rv = poll(p, 1, 0);
  while (rv == -1 && (errno == EINTR || errno == EAGAIN));

  if (rv == -1)
    return UV__ERR(errno);

  if (p[0].revents & POLLNVAL)
    return UV_EINVAL;

  return 0;
}
