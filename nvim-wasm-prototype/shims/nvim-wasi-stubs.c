/* shims/nvim-wasi-stubs.c
 *
 * WHAT: Definitions for the libc/BSD symbols Neovim references that
 * wasm32-wasi's libc.a never defines: the fork/exec/pty process-spawning
 * surface and stdio's tmpfile(). Compiled into libnvim-wasi-shim.a by
 * scripts/build-nvim.sh and appended to the final nvim link.
 *
 * WHY: WASI preview1 has no child processes, no ptys, no sessions and no
 * signal delivery, so every stub here fails HONESTLY (errno set, error
 * return) rather than pretending to succeed. Neovim's own error paths
 * then surface e.g. "forkpty failed" / E903 to the user when something
 * tries to spawn a job, while the vast non-process core (buffers, RPC,
 * Lua) is unaffected. This mirrors the design of the rung-3 libuv shims:
 * link everything, abort/fail loudly only at the genuinely impossible
 * runtime operations.
 *
 * Declarations live in shims/include/{pty.h,sys/wait.h} and
 * shims/nvim-wasi-fixups.h; wasi-libc's own headers declare tmpfile()
 * (deprecated-on-WASI) and kill() (emulated-signal).
 *
 * CLEAN-ROOM PROVENANCE: Behaviour written from the POSIX.1-2017
 * specifications of each interface (error conditions chosen from each
 * spec's ERRORS section: ENOSYS for missing kernel facilities, ECHILD
 * for waitpid with no children). No excluded project consulted.
 */

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>

#include <pty.h>       /* shims/include/pty.h */
#include <sys/wait.h>  /* shims/include/sys/wait.h */

/* --- pty allocation (no ptys, no fork under WASI) -------------------------- */

int openpty(int* amaster, int* aslave, char* name,
            const struct termios* termp, const struct winsize* winp) {
  (void) amaster; (void) aslave; (void) name; (void) termp; (void) winp;
  errno = ENOSYS;
  return -1;
}

pid_t forkpty(int* amaster, char* name, const struct termios* termp,
              const struct winsize* winp) {
  (void) amaster; (void) name; (void) termp; (void) winp;
  errno = ENOSYS;
  return -1;
}

/* --- process control (no processes under WASI) ----------------------------- */

pid_t setsid(void) {
  errno = ENOSYS;
  return -1;
}

int execvp(const char* file, char* const argv[]) {
  (void) file; (void) argv;
  errno = ENOSYS;
  return -1;
}

int kill(pid_t pid, int sig) {
  (void) pid; (void) sig;
  errno = ENOSYS;
  return -1;
}

/* No ptys: there is never a pty slave to name. */
char* ptsname(int fd) {
  (void) fd;
  errno = ENOTSUP;
  return NULL;
}

/* No process groups to signal. */
int killpg(pid_t pgrp, int sig) {
  (void) pgrp; (void) sig;
  errno = ENOSYS;
  return -1;
}

pid_t wait(int* status) {
  (void) status;
  errno = ECHILD;  /* there can never be children */
  return -1;
}

pid_t waitpid(pid_t pid, int* status, int options) {
  (void) pid; (void) status; (void) options;
  errno = ECHILD;
  return -1;
}

/* pthread_exit terminates a thread that, on this single-threaded target,
 * can only be the main (and only) thread -- and it is only reachable from
 * Neovim's luv-worker-thread OOM path, which requires a uv_thread that
 * uv_thread_create (UV_ENOSYS) can never have created. Abort loudly in the
 * spirit of the rung-3 "deadlocks made visible" convention. */
_Noreturn void pthread_exit(void* retval) {
  (void) retval;
  fprintf(stderr, "nvim-wasi-stubs: pthread_exit called on single-threaded "
                  "wasm32-wasi target\n");
  abort();
}

/* No process umask under WASI: report the conventional default and change
 * nothing. umask() cannot fail per POSIX, so this is the only honest shape
 * a stub can have. */
mode_t umask(mode_t mask) {
  (void) mask;
  return 022;
}

/* --- stdio odds and ends ---------------------------------------------------- */

/* wasi-libc declares tmpfile() but never defines it. NULL is the
 * documented can't-create failure; Lua's io.tmpfile and any C caller
 * treat it as a normal error. */
FILE* tmpfile(void) {
  errno = ENOTSUP;
  return NULL;
}

/* No shell in the sandbox (referenced by Lua's os.execute in liblua.a).
 * POSIX: system(NULL) asks "is a command processor available?" -- answer 0
 * (no); otherwise fail with the exec-failure status. */
int system(const char* command) {
  if (command == NULL) {
    return 0;
  }
  errno = ENOSYS;
  return -1;
}
