/* shims/include/sys/wait.h
 *
 * WHAT: Minimal <sys/wait.h> for wasm32-wasi. wasi-libc ships none (WASI
 * preview1 has no child processes), but Neovim's os/pty_proc_unix.c
 * includes it unconditionally and calls waitpid() on job-control paths.
 *
 * WHY: The declarations exist so the pty/job code COMPILES; waitpid() is
 * defined in shims/nvim-wasi-stubs.c as an honest ECHILD failure (there
 * can never be children to wait for). The W* status macros operate on the
 * conventional Unix status-word encoding so the code's status plumbing is
 * self-consistent even though no real status ever exists.
 *
 * CLEAN-ROOM PROVENANCE: Written from the POSIX.1-2017 <sys/wait.h>
 * specification; macro encodings are the conventional Linux/musl ABI
 * ones. No excluded project consulted.
 */
#ifndef _WASI_SHIM_SYS_WAIT_H
#define _WASI_SHIM_SYS_WAIT_H

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WNOHANG    1
#define WUNTRACED  2
#define WCONTINUED 8

#define WEXITSTATUS(s)  (((s) & 0xff00) >> 8)
#define WTERMSIG(s)     ((s) & 0x7f)
#define WSTOPSIG(s)     WEXITSTATUS(s)
#define WIFEXITED(s)    (WTERMSIG(s) == 0)
#define WIFSIGNALED(s)  (((signed char)(((s) & 0x7f) + 1) >> 1) > 0)
#define WIFSTOPPED(s)   (((s) & 0xff) == 0x7f)
#define WIFCONTINUED(s) ((s) == 0xffff)
#define WCOREDUMP(s)    ((s) & 0x80)

pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_SYS_WAIT_H */
