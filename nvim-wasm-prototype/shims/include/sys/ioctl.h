/* shims/include/sys/ioctl.h
 *
 * WHAT: <sys/ioctl.h> for wasm32-wasi that supersedes wasi-libc's own
 * (shims/include is searched first). wasi-libc's version declares ioctl()
 * plus FIONREAD/FIONBIO only; Neovim's pty layer additionally needs
 * `struct winsize` (embedded by value in PtyProc, so the type must be
 * complete everywhere nvim/os/pty_proc.h is included) and the TIOCSWINSZ /
 * TIOCSCTTY request constants.
 *
 * WHY: There are no ttys or ptys inside the WASI sandbox. wasi-libc's own
 * ioctl() exists in libc.a and fails at runtime for unknown requests; the
 * struct/constants below exist purely so the pty code COMPILES. The spawn
 * entry points fail honestly at runtime (fork/exec are ENOSYS).
 *
 * CLEAN-ROOM PROVENANCE: struct winsize members per the POSIX.1-2024
 * <termios.h> spec (historically exposed via <sys/ioctl.h>); FIONREAD /
 * FIONBIO values copied from wasi-libc's own __header_sys_ioctl.h so we
 * stay ABI-identical with its ioctl(); TIOC* request values are the
 * conventional Linux/musl ABI numbers. No excluded project consulted.
 */
#ifndef _WASI_SHIM_SYS_IOCTL_H
#define _WASI_SHIM_SYS_IOCTL_H

#ifdef __cplusplus
extern "C" {
#endif

/* Same values as wasi-libc's __header_sys_ioctl.h (which this file
 * shadows), so calls into wasi-libc's ioctl() keep their meaning. */
#define FIONREAD 1
#define FIONBIO 2

/* Conventional Linux/musl ABI request numbers; no wasi-libc counterpart. */
#define TIOCSCTTY  0x540E
#define TIOCGWINSZ 0x5413
#define TIOCSWINSZ 0x5414

struct winsize {
  unsigned short ws_row;
  unsigned short ws_col;
  unsigned short ws_xpixel;
  unsigned short ws_ypixel;
};

int ioctl(int, int, ...);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_SYS_IOCTL_H */
