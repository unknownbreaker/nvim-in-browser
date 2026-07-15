/* shims/include/net/if.h
 *
 * WHAT: Minimal <net/if.h> for wasm32-wasi. libuv's uv-common.c includes
 * it for if_nametoindex()/if_indextoname() (uv_if_indextoname etc.).
 *
 * WHY: No network interfaces exist under WASI preview1; the functions are
 * defined in shims/wasi-libc-missing.c returning honest failures.
 *
 * CLEAN-ROOM PROVENANCE: POSIX.1-2017 <net/if.h> specification. No
 * excluded project consulted.
 */
#ifndef _WASI_SHIM_NET_IF_H
#define _WASI_SHIM_NET_IF_H

#ifdef __cplusplus
extern "C" {
#endif

#define IF_NAMESIZE 16
#define IFNAMSIZ IF_NAMESIZE

unsigned int if_nametoindex(const char *);
char *if_indextoname(unsigned int, char *);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_NET_IF_H */
