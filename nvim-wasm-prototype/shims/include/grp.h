/* shims/include/grp.h
 *
 * WHAT: Minimal <grp.h> for wasm32-wasi. wasi-libc has no group database;
 * libuv's core.c includes <grp.h> and calls getgrgid_r() for
 * uv_os_get_group().
 *
 * WHY: Declarations only; definitions live in shims/wasi-libc-missing.c
 * and return ENOSYS.
 *
 * CLEAN-ROOM PROVENANCE: Written from the POSIX.1-2017 <grp.h>
 * specification. No excluded project consulted.
 */
#ifndef _WASI_SHIM_GRP_H
#define _WASI_SHIM_GRP_H

#include <sys/types.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

struct group {
  char *gr_name;
  char *gr_passwd;
  gid_t gr_gid;
  char **gr_mem;
};

struct group *getgrnam(const char *);
struct group *getgrgid(gid_t);
int getgrnam_r(const char *, struct group *, char *, size_t, struct group **);
int getgrgid_r(gid_t, struct group *, char *, size_t, struct group **);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_GRP_H */
