/* shims/include/sys/statfs.h
 *
 * WHAT: Minimal <sys/statfs.h> for wasm32-wasi. libuv's fs.c includes it
 * (and calls statfs/fstatfs) on every non-Apple/non-BSD Unix, including
 * this port.
 *
 * WHY: wasi-libc only ships the POSIX <sys/statvfs.h> flavor.
 * shims/wasi-libc-missing.c implements statfs()/fstatfs() for real on top
 * of statvfs()/fstatvfs() (which wasi-libc backs with WASI fd_filestat /
 * path_filestat data), with f_type reported as 0 ("unknown filesystem").
 *
 * CLEAN-ROOM PROVENANCE: struct fields are the classic Linux statfs(2)
 * members that libuv's fs.c consumes; written from the statfs(2) man-page
 * interface description. No excluded project consulted.
 */
#ifndef _WASI_SHIM_SYS_STATFS_H
#define _WASI_SHIM_SYS_STATFS_H

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct { int __val[2]; } __statfs_fsid_t;

struct statfs {
  unsigned long f_type;
  unsigned long f_bsize;
  unsigned long long f_blocks;
  unsigned long long f_bfree;
  unsigned long long f_bavail;
  unsigned long long f_files;
  unsigned long long f_ffree;
  __statfs_fsid_t f_fsid;
  unsigned long f_namelen;
  unsigned long f_frsize;
  unsigned long f_flags;
  unsigned long f_spare[4];
};

int statfs(const char *, struct statfs *);
int fstatfs(int, struct statfs *);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_SYS_STATFS_H */
