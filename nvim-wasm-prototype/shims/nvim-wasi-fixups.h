/* shims/nvim-wasi-fixups.h
 *
 * WHAT: Force-included (clang -include) into every Neovim translation unit
 * of the wasm32-wasi build, exactly like shims/uv-wasi-fixups.h is for
 * libuv TUs. Re-declares the small process-management surface that
 * wasi-libc's headers hide behind `__wasilibc_unmodified_upstream`
 * ("WASI has no fork/exec / no process groups") but that Neovim's
 * job-control/pty code calls unconditionally.
 *
 * WHY: Neovim's os/pty_proc_unix.c and friends are compiled AS-IS (no
 * source patches); they only ever exercise these calls when spawning
 * child processes, which WASI preview1 cannot do. Every function below is
 * defined in shims/nvim-wasi-stubs.c as an honest errno-setting failure,
 * so :terminal/jobstart fail cleanly at runtime instead of failing the
 * link at build time.
 *
 * CLEAN-ROOM PROVENANCE: Prototypes per POSIX.1-2017 (setsid, execvp,
 * kill). The corresponding hidden declarations in wasi-libc's own
 * unistd.h/signal.h were inspected only to confirm they are guarded out.
 * No excluded project consulted.
 */
#ifndef _NVIM_WASI_FIXUPS_H
#define _NVIM_WASI_FIXUPS_H

#include <fcntl.h>
#include <signal.h>   /* sigset_t (mask functions are hidden, declared below) */
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* wasi-libc's <fcntl.h> has no dup-style commands (preview1 has no general
 * fd duplication). channel.c's embedded-mode stdio redirect uses this;
 * wasi-libc's fcntl() rejects unknown commands with EINVAL, which the
 * caller treats as "dup failed" (rung-5 note: the embed path needs a real
 * answer here). Value is the conventional Linux/musl one. */
#ifndef F_DUPFD_CLOEXEC
# define F_DUPFD_CLOEXEC 1030
#endif

/* hidden in wasi-libc <unistd.h> ("WASI has no fd duplication"); honest
 * ENOSYS definitions live in shims/wasi-libc-missing.c (in libuv.a). */
int dup(int);
int dup2(int, int);

/* hidden in wasi-libc <sys/stat.h> (no process umask in WASI); no-op
 * definition in shims/nvim-wasi-stubs.c (fileio.c only saves/restores it
 * around mch_copy_sec-style permission fiddling). */
mode_t umask(mode_t);

/* hidden in wasi-libc <unistd.h> ("WASI has no fork/exec") */
int execvp(const char *, char *const[]);
/* hidden in wasi-libc <unistd.h> ("WASI has no getpid etc.") */
pid_t setsid(void);
/* declared by wasi-libc <signal.h> under _WASI_EMULATED_SIGNAL but never
 * defined by libwasi-emulated-signal.a; declared here too for TUs that
 * include neither <signal.h> variant. */
int kill(pid_t, int);

/* hidden in wasi-libc <pthread.h> (single-threaded target). Only reachable
 * from a luv worker thread, which uv_thread_create (ENOSYS) can never
 * create; the stub aborts loudly. */
_Noreturn void pthread_exit(void *);

/* pty slave naming + process-group signalling (os/pty_proc_unix.c); no
 * ptys/process groups under WASI, stubs in shims/nvim-wasi-stubs.c. */
char *ptsname(int);
int killpg(pid_t, int);

/* Signal-mask API, same story as shims/uv-wasi-fixups.h: wasi-libc's
 * <signal.h> defines sigset_t but hides the mask-manipulation functions.
 * os/signal.c blocks SIGTSTP around suspend; the no-op definitions live in
 * shims/wasi-libc-missing.c (in libuv.a). */
#ifndef SIG_BLOCK
# define SIG_BLOCK 0
# define SIG_UNBLOCK 1
# define SIG_SETMASK 2
#endif
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int pthread_sigmask(int, const sigset_t *__restrict, sigset_t *__restrict);


#ifdef __cplusplus
}
#endif

#endif /* _NVIM_WASI_FIXUPS_H */
