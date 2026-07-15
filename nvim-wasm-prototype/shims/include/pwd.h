/* shims/include/pwd.h
 *
 * WHAT: Minimal <pwd.h> for wasm32-wasi. wasi-libc has no user database;
 * libuv's uv/unix.h includes <pwd.h> unconditionally and core.c calls
 * getpwuid_r() for uv_os_homedir()/uv_os_get_passwd() fallbacks.
 *
 * WHY: Declarations only, so upstream libuv sources compile unmodified.
 * The functions are defined in shims/wasi-libc-missing.c returning ENOSYS
 * (libuv falls back to $HOME etc. where it can).
 *
 * CLEAN-ROOM PROVENANCE: Written from the POSIX.1-2017 <pwd.h>
 * specification. No excluded project consulted.
 */
#ifndef _WASI_SHIM_PWD_H
#define _WASI_SHIM_PWD_H

#include <sys/types.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

struct passwd {
  char *pw_name;
  char *pw_passwd;
  uid_t pw_uid;
  gid_t pw_gid;
  char *pw_gecos;
  char *pw_dir;
  char *pw_shell;
};

struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
int getpwnam_r(const char *, struct passwd *, char *, size_t, struct passwd **);
int getpwuid_r(uid_t, struct passwd *, char *, size_t, struct passwd **);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_PWD_H */
