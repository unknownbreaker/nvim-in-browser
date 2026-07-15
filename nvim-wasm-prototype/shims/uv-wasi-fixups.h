/* shims/uv-wasi-fixups.h
 *
 * WHAT: Force-included (clang -include) into every libuv translation unit
 * of the wasm32-wasi build. Declares POSIX functions that wasi-libc's
 * headers deliberately omit (guarded by __wasilibc_unmodified_upstream)
 * but that upstream libuv sources call unconditionally.
 *
 * WHY: This keeps upstream libuv sources compiling completely unmodified.
 * The matching definitions are honest ENOSYS stubs in
 * shims/wasi-libc-missing.c.
 *
 * CLEAN-ROOM PROVENANCE: Signatures from POSIX.1-2017. No excluded
 * project consulted.
 */
#ifndef UV_WASI_FIXUPS_H
#define UV_WASI_FIXUPS_H

#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <signal.h>
#include <pthread.h>

#ifdef __cplusplus
extern "C" {
#endif

/* wasi-libc's unistd.h hides these behind __wasilibc_unmodified_upstream
 * ("WASI has no chown"); libuv fs.c calls them unconditionally. */
int chown(const char *, uid_t, gid_t);
int fchown(int, uid_t, gid_t);
int lchown(const char *, uid_t, gid_t);

/* access(): wasi-libc's implementation checks the requested rights against
 * the preopen directory fd's fs_rights_inheriting, so under rights-agnostic
 * hosts (zero-rights fdstat, e.g. @bjorn3/browser_wasi_shim) every
 * R_OK/W_OK/X_OK probe fails EACCES even for readable files — breaking
 * Neovim's os_file_is_readable() and every runtime-Lua `require`. Route
 * libuv's uv_fs_access (the only access() caller in the link) to the
 * stat-based replacement in wasi-libc-missing.c. A link-level override of
 * the `access` symbol is impossible: wasi-libc defines it in the monolithic
 * posix.c.obj, which is extracted anyway (duplicate-symbol error, caught by
 * the uv-linkall gate). The function-like macro also rewrites unistd.h's
 * own declaration into a (consistent) declaration of the shim — harmless. */
int uv__wasi_access_shim(const char *, int);
#define access(path, amode) uv__wasi_access_shim(path, amode)

/* Socket options wasi-libc's wasip1 <sys/socket.h> omits (it only defines
 * SO_TYPE/SOL_SOCKET for preview1). Values follow the conventional
 * Linux/musl ABI; on this target every setsockopt/getsockopt fails with
 * ENOSYS anyway, so only compilability matters. */
#ifndef SO_REUSEADDR
#define SO_REUSEADDR 2
#endif
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_SNDBUF
#define SO_SNDBUF 7
#endif
#ifndef SO_RCVBUF
#define SO_RCVBUF 8
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef SO_OOBINLINE
#define SO_OOBINLINE 10
#endif
#ifndef SO_LINGER
#define SO_LINGER 13  /* struct linger comes from wasi-libc sys/socket.h */
#endif
#ifndef SOMAXCONN
#define SOMAXCONN 128
#endif

/* Socket functions wasi-libc's wasip1 headers hide behind
 * __wasilibc_unmodified_upstream. Standard POSIX signatures; identical
 * redeclaration is harmless where wasi-libc does declare one. The
 * definitions are either wasi-libc's own (accept/getsockopt/recv/send/
 * shutdown) or honest ENOSYS stubs in shims/wasi-libc-missing.c. */
int socket(int, int, int);
int socketpair(int, int, int, int[2]);
int bind(int, const struct sockaddr *, socklen_t);
int connect(int, const struct sockaddr *, socklen_t);
int listen(int, int);
int getsockname(int, struct sockaddr *__restrict, socklen_t *__restrict);
int getpeername(int, struct sockaddr *__restrict, socklen_t *__restrict);
int setsockopt(int, int, int, const void *, socklen_t);
ssize_t sendmsg(int, const struct msghdr *, int);
ssize_t recvmsg(int, struct msghdr *, int);

/* Ancillary-data (SCM_RIGHTS fd passing) machinery, absent from wasi-libc.
 * Layout follows the conventional Linux/musl ABI; on this target sendmsg/
 * recvmsg always fail, so these only ever traverse empty control buffers. */
#ifndef SCM_RIGHTS
#define SCM_RIGHTS 0x01

struct cmsghdr {
  socklen_t cmsg_len;
  int cmsg_level;
  int cmsg_type;
};

#define CMSG_ALIGN(len) (((len) + sizeof(size_t) - 1) & ~(sizeof(size_t) - 1))
#define CMSG_SPACE(len) (CMSG_ALIGN(len) + CMSG_ALIGN(sizeof(struct cmsghdr)))
#define CMSG_LEN(len) (CMSG_ALIGN(sizeof(struct cmsghdr)) + (len))
#define CMSG_DATA(cmsg) ((unsigned char *)(((struct cmsghdr *)(cmsg)) + 1))

#define __CMSG_LEN(cmsg) \
  (((cmsg)->cmsg_len + sizeof(long) - 1) & ~(long)(sizeof(long) - 1))
#define __CMSG_NEXT(cmsg) ((unsigned char *)(cmsg) + __CMSG_LEN(cmsg))
#define __MHDR_END(mhdr) \
  ((unsigned char *)(mhdr)->msg_control + (mhdr)->msg_controllen)

#define CMSG_FIRSTHDR(mhdr)                                               \
  ((size_t)(mhdr)->msg_controllen >= sizeof(struct cmsghdr)               \
       ? (struct cmsghdr *)(mhdr)->msg_control                            \
       : (struct cmsghdr *)0)
#define CMSG_NXTHDR(mhdr, cmsg)                                           \
  ((cmsg)->cmsg_len < sizeof(struct cmsghdr) ||                           \
           __CMSG_LEN(cmsg) + sizeof(struct cmsghdr) >=                   \
               (size_t)(__MHDR_END(mhdr) - (unsigned char *)(cmsg))       \
       ? (struct cmsghdr *)0                                              \
       : (struct cmsghdr *)__CMSG_NEXT(cmsg))
#endif /* SCM_RIGHTS */

/* wasi-libc's struct sockaddr_un has no sun_path member ("WASI has no
 * UNIX-domain sockets"), but libuv's pipe.c manipulates sun_path
 * throughout. <sys/un.h> is already included above (its include guard
 * makes later includes no-ops), so from here on the tag resolves to this
 * complete classic layout instead. connect()/bind() on it fail with
 * ENOSYS at runtime anyway. */
struct uv__wasi_sockaddr_un {
  sa_family_t sun_family;
  char sun_path[108];
};
#define sockaddr_un uv__wasi_sockaddr_un

/* Signal-mask API: no signal delivery exists under WASI; these compile
 * against honest no-op definitions in shims/wasi-libc-missing.c. */
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int pthread_sigmask(int, const sigset_t *__restrict, sigset_t *__restrict);

/* Temp-file helpers hidden by wasi-libc's stdlib.h guards; real
 * implementations (getentropy + mkdir/open) in shims/wasi-libc-missing.c. */
char *mkdtemp(char *);
int mkstemp(char *);

/* unistd-family calls wasi-libc omits (no processes, no fd duplication in
 * preview1). ENOSYS stubs live in shims/wasi-libc-missing.c. */
int dup(int);
int dup2(int, int);
int pipe(int[2]);
pid_t getppid(void);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
int setuid(uid_t);
int setgid(gid_t);

/* Resource limits / priorities: wasip1's <sys/resource.h> only carries the
 * emulated rusage bits; everything below is hidden upstream musl surface.
 * Conventional Linux/musl values; getrlimit & co. are ENOSYS stubs. */
#ifndef RLIM_INFINITY
typedef unsigned long long rlim_t;
struct rlimit {
  rlim_t rlim_cur;
  rlim_t rlim_max;
};
#define RLIM_INFINITY (~0ULL)
#define RLIMIT_CPU 0
#define RLIMIT_FSIZE 1
#define RLIMIT_DATA 2
#define RLIMIT_STACK 3
#define RLIMIT_CORE 4
#define RLIMIT_NOFILE 7
#define RLIMIT_AS 9
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#endif
#ifndef PRIO_PROCESS
#define PRIO_PROCESS 0
#define PRIO_PGRP 1
#define PRIO_USER 2
#define PRIO_MIN (-20)
#define PRIO_MAX 20
#endif
int getpriority(int, id_t);
int setpriority(int, id_t, int);

/* Scheduling introspection (uv_thread_{get,set}priority): struct
 * sched_param is always visible in wasi-libc's <sched.h>, the functions
 * are not. ENOSYS stubs in shims/wasi-libc-missing.c. */
struct sched_param;
int sched_get_priority_max(int);
int sched_get_priority_min(int);
int pthread_getschedparam(pthread_t, int *, struct sched_param *);
int pthread_setschedparam(pthread_t, int, const struct sched_param *);
#ifndef SCHED_OTHER
#define SCHED_OTHER 0
#define SCHED_FIFO 1
#define SCHED_RR 2
#endif

#ifdef __cplusplus
}
#endif

#endif /* UV_WASI_FIXUPS_H */
