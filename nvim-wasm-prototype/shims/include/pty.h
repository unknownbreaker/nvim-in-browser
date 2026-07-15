/* shims/include/pty.h
 *
 * WHAT: Minimal <pty.h> for wasm32-wasi. wasi-libc ships none, but
 * Neovim's os/pty_proc_unix.c lands in the `#include <pty.h>` fallback
 * branch of its platform-specific forkpty-header dance on any platform
 * that is not a BSD/Apple/Solaris.
 *
 * WHY: WASI preview1 has no processes and no ptys; forkpty()/openpty()
 * are defined in shims/nvim-wasi-stubs.c as honest ENOSYS failures, so
 * :terminal job spawns fail cleanly at runtime instead of linking dead.
 *
 * CLEAN-ROOM PROVENANCE: Signatures per the Linux man-pages/glibc <pty.h>
 * interface contract (forkpty/openpty are not POSIX; this is the
 * conventional prototype set). No excluded project consulted.
 */
#ifndef _WASI_SHIM_PTY_H
#define _WASI_SHIM_PTY_H

#include <sys/ioctl.h>
#include <sys/types.h>
#include <termios.h>

#ifdef __cplusplus
extern "C" {
#endif

int openpty(int *, int *, char *, const struct termios *,
            const struct winsize *);
pid_t forkpty(int *, char *, const struct termios *,
              const struct winsize *);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_PTY_H */
