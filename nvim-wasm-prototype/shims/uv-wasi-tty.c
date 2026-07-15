/* shims/uv-wasi-tty.c
 *
 * WHAT: uv_tty_t and uv_guess_handle() for the wasm32-wasi libuv port.
 * Replaces upstream src/unix/tty.c.
 *
 * WHY / DESIGN: "TTYs as plain pipes/streams." There are no terminal
 * devices inside the WASI sandbox — stdio is whatever the host wired up
 * (pipes under the Node/browser hosts this prototype targets). So:
 *
 *   - uv_tty_init() opens the fd as an ordinary libuv stream (same
 *     io-watcher machinery as uv_pipe_open), which is exactly what makes
 *     reads/writes on it event-driven via our poll_oneoff core;
 *   - uv_tty_set_mode() succeeds as a no-op (there is no line discipline
 *     to toggle; failing would make callers that insist on raw mode bail
 *     out even though byte-stream semantics are already "raw");
 *   - uv_tty_get_winsize() is honest UV_ENOTSUP — the embedding host
 *     drives the UI size over RPC, not via a kernel winsize;
 *   - uv_guess_handle() classifies by fstat/isatty like upstream, with
 *     socket-typed fds reported as UV_NAMED_PIPE because host pipes may
 *     surface as socketpairs while real sockets don't exist under
 *     preview1.
 *
 * CLEAN-ROOM PROVENANCE: API contract from libuv v1.52.1 include/uv.h and
 * src/unix/tty.c structure (MIT, vendored in src-cache/libuv). No
 * excluded project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int uv_tty_init(uv_loop_t* loop, uv_tty_t* tty, uv_file fd, int unused) {
  int flags;
  struct stat s;

  (void) unused;

  if (fd < 0)
    return UV_EBADF;

  if (fstat(fd, &s) != 0)
    return UV__ERR(errno);

  uv__stream_init(loop, (uv_stream_t*) tty, UV_TTY);

  /* Stdio fds under the WASI hosts are bidirectional byte streams as far
   * as libuv's bookkeeping is concerned; actual EBADF on the wrong
   * direction still surfaces from read/write at use time. */
  flags = UV_HANDLE_READABLE | UV_HANDLE_WRITABLE;

  /* Match uv_pipe_open(): streams must be non-blocking so the read loop
   * yields EAGAIN instead of stalling the (only) thread. */
  (void) uv__nonblock(fd, 1);

  tty->mode = UV_TTY_MODE_NORMAL;
  memset(&tty->orig_termios, 0, sizeof(tty->orig_termios));

  return uv__stream_open((uv_stream_t*) tty, fd, flags);
}

int uv_tty_set_mode(uv_tty_t* tty, uv_tty_mode_t mode) {
  /* No line discipline exists; every mode is already in effect. */
  tty->mode = (int) mode;
  return 0;
}

int uv_tty_reset_mode(void) {
  return 0;
}

int uv_tty_get_winsize(uv_tty_t* tty, int* width, int* height) {
  (void) tty;
  (void) width;
  (void) height;
  return UV_ENOTSUP;
}

void uv__tty_close(uv_tty_t* handle) {
  uv__stream_close((uv_stream_t*) handle);
}

void uv_tty_set_vterm_state(uv_tty_vtermstate_t state) {
  /* Windows-only concept upstream; accepted and ignored here too. */
  (void) state;
}

int uv_tty_get_vterm_state(uv_tty_vtermstate_t* state) {
  (void) state;
  return UV_ENOTSUP;
}

uv_handle_type uv_guess_handle(uv_file file) {
  struct stat s;

  if (file < 0)
    return UV_UNKNOWN_HANDLE;

  if (isatty(file))
    return UV_TTY;

  if (fstat(file, &s) != 0)
    return UV_UNKNOWN_HANDLE;

  if (S_ISREG(s.st_mode))
    return UV_FILE;

  if (S_ISCHR(s.st_mode))
    return UV_FILE;  /* character device that isn't a tty */

  if (S_ISFIFO(s.st_mode))
    return UV_NAMED_PIPE;

  if (S_ISSOCK(s.st_mode))
    /* Host pipes can surface as socketpairs; preview1 has no real
     * sockets, so a pipe is the only thing this can be. */
    return UV_NAMED_PIPE;

  return UV_UNKNOWN_HANDLE;
}
