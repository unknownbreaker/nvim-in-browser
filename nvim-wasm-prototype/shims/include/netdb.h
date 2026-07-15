/* shims/include/netdb.h
 *
 * WHAT: Minimal <netdb.h> for wasm32-wasi. wasi-libc ships none, but
 * libuv's public uv.h needs `struct addrinfo` (uv_getaddrinfo_t embeds a
 * pointer and the callback signature uses it), and uv/unix.h includes
 * <netdb.h> unconditionally. libuv's getaddrinfo.c/getnameinfo.c and
 * uv-common.c's EAI_* -> UV_EAI_* error translation compile against the
 * constants below.
 *
 * WHY: There is no name resolution inside the WASI preview1 sandbox.
 * getaddrinfo()/getnameinfo() are defined in shims/wasi-libc-missing.c
 * returning EAI_FAIL, so uv_getaddrinfo() fails honestly at runtime while
 * everything still compiles and links.
 *
 * CLEAN-ROOM PROVENANCE: Written from the POSIX.1-2017 <netdb.h>
 * specification; constant values follow the conventional Linux/musl ABI
 * (glibc value for the nonstandard EAI_ADDRFAMILY/EAI_CANCELED). No
 * excluded project consulted.
 */
#ifndef _WASI_SHIM_NETDB_H
#define _WASI_SHIM_NETDB_H

#include <sys/socket.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct addrinfo {
  int ai_flags;
  int ai_family;
  int ai_socktype;
  int ai_protocol;
  socklen_t ai_addrlen;
  struct sockaddr *ai_addr;
  char *ai_canonname;
  struct addrinfo *ai_next;
};

/* ai_flags */
#define AI_PASSIVE     0x01
#define AI_CANONNAME   0x02
#define AI_NUMERICHOST 0x04
#define AI_V4MAPPED    0x08
#define AI_ALL         0x10
#define AI_ADDRCONFIG  0x20
#define AI_NUMERICSERV 0x400

/* getaddrinfo()/getnameinfo() error codes */
#define EAI_BADFLAGS   (-1)
#define EAI_NONAME     (-2)
#define EAI_AGAIN      (-3)
#define EAI_FAIL       (-4)
#define EAI_NODATA     (-5)
#define EAI_FAMILY     (-6)
#define EAI_SOCKTYPE   (-7)
#define EAI_SERVICE    (-8)
#define EAI_ADDRFAMILY (-9)
#define EAI_MEMORY     (-10)
#define EAI_SYSTEM     (-11)
#define EAI_OVERFLOW   (-12)
#define EAI_CANCELED   (-101)

/* getnameinfo() flags and buffer sizes */
#define NI_MAXHOST 1025
#define NI_MAXSERV 32
#define NI_NUMERICHOST 0x01
#define NI_NUMERICSERV 0x02
#define NI_NOFQDN      0x04
#define NI_NAMEREQD    0x08
#define NI_DGRAM       0x10

int getaddrinfo(const char *__restrict, const char *__restrict,
                const struct addrinfo *__restrict,
                struct addrinfo **__restrict);
void freeaddrinfo(struct addrinfo *);
int getnameinfo(const struct sockaddr *__restrict, socklen_t,
                char *__restrict, socklen_t, char *__restrict, socklen_t,
                int);
const char *gai_strerror(int);

/* Protocol database (luv's constants.c getprotobyname/getprotobynumber
 * bindings). No /etc/protocols exists in the sandbox; the lookups in
 * shims/wasi-libc-missing.c always return NULL (honest "unknown"). */
struct protoent {
  char *p_name;
  char **p_aliases;
  int p_proto;
};
struct protoent *getprotobyname(const char *);
struct protoent *getprotobynumber(int);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_NETDB_H */
