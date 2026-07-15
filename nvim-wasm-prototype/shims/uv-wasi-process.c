/* shims/uv-wasi-process.c
 *
 * WHAT: uv_process_t and friends for the wasm32-wasi libuv port —
 * uv_spawn / uv_process_kill / uv_kill / uv_disable_stdio_inheritance,
 * plus the internal hooks referenced from loop.c and core.c
 * (uv__process_init, uv__process_close, uv__wait_children, uv__make_pipe).
 * Replaces upstream src/unix/process.c.
 *
 * WHY / DESIGN: WASI preview1 has no fork/exec, no child processes, and
 * no kill(2) — process spawning is impossible, and the port fails
 * honestly with UV_ENOSYS rather than pretending. uv__make_pipe also
 * lives here (as upstream) and returns UV_ENOSYS because preview1 cannot
 * create pipes at runtime (fds only come from the preopen/stdio table);
 * that makes the public uv_pipe(2fds) constructor fail honestly too,
 * while uv_pipe_open() on already-existing fds (stdio) works fully.
 *
 * CLEAN-ROOM PROVENANCE: API contract from libuv v1.52.1 include/uv.h and
 * src/unix/process.c (MIT, vendored in src-cache/libuv); WASI preview1
 * spec for the missing capabilities. No excluded project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <stddef.h>

int uv__process_init(uv_loop_t* loop) {
  (void) loop;
  return 0;
}

void uv__wait_children(uv_loop_t* loop) {
  /* Never any children to reap; UV_LOOP_REAP_CHILDREN can't be set
   * because uv_spawn never succeeds. */
  (void) loop;
}

int uv_spawn(uv_loop_t* loop,
             uv_process_t* process,
             const uv_process_options_t* options) {
  /* Mirror upstream's error shape: the handle is initialized (so it is
   * safe to uv_close) but disarmed, and the spawn itself fails. */
  uv__handle_init(loop, (uv_handle_t*) process, UV_PROCESS);
  uv__queue_init(&process->queue);
  process->status = 0;
  process->pid = -1;

  (void) options;
  return UV_ENOSYS;
}

int uv_process_kill(uv_process_t* process, int signum) {
  (void) process;
  (void) signum;
  return UV_ENOSYS;
}

int uv_kill(int pid, int signum) {
  (void) pid;
  (void) signum;
  return UV_ENOSYS;
}

/* uv_process_get_pid lives in upstream uv-data-getter-setters.c. */

void uv__process_close(uv_process_t* handle) {
  uv__queue_remove(&handle->queue);
  uv__handle_stop(handle);
}

/* uv_disable_stdio_inheritance lives in upstream core.c; uv__make_pipe in
 * upstream pipe.c (it fails via our pipe()/pipe2() ENOSYS libc stubs —
 * WASI preview1 cannot create new pipes at runtime). */
