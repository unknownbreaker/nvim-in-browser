/* shims/uv-wasi-udp.c
 *
 * WHAT: uv_udp_t for the wasm32-wasi libuv port. Replaces upstream
 * src/unix/udp.c.
 *
 * WHY / DESIGN: WASI preview1 has no UDP sockets at all (and no socket()
 * to create one), and upstream udp.c leans on multicast/mreq kernel
 * surface that wasi-libc deliberately omits — so instead of fabricating a
 * pile of fake constants to compile dead code, the whole module is a thin
 * honest port: uv_udp_init() produces a valid, closable handle
 * (AF_UNSPEC init never needs a socket); every operation that would
 * require an actual socket fails with UV_ENOSYS. uv-common.c's public
 * uv_udp_* wrappers link against these internals; Neovim itself calls
 * none of them.
 *
 * CLEAN-ROOM PROVENANCE: Contract and handle-lifecycle shapes from libuv
 * v1.52.1 src/unix/udp.c + uv-common.h (MIT, vendored in
 * src-cache/libuv). No excluded project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <stddef.h>

int uv__udp_init_ex(uv_loop_t* loop,
                    uv_udp_t* handle,
                    unsigned flags,
                    int domain) {
  (void) flags;

  /* Creating an actual socket is impossible; only the fd-less AF_UNSPEC
   * form (plain uv_udp_init) can produce a coherent handle. */
  if (domain != AF_UNSPEC)
    return UV_ENOSYS;

  uv__handle_init(loop, (uv_handle_t*) handle, UV_UDP);
  handle->alloc_cb = NULL;
  handle->recv_cb = NULL;
  handle->send_queue_size = 0;
  handle->send_queue_count = 0;
  uv__io_init(&handle->io_watcher, UV__UDP_IO, -1);
  uv__queue_init(&handle->write_queue);
  uv__queue_init(&handle->write_completed_queue);

  return 0;
}

void uv__udp_close(uv_udp_t* handle) {
  uv__io_close(handle->loop, &handle->io_watcher);
  uv__handle_stop(handle);
}

void uv__udp_finish_close(uv_udp_t* handle) {
  /* No sends can ever be queued (uv__udp_send is ENOSYS). */
  handle->recv_cb = NULL;
  handle->alloc_cb = NULL;
}

void uv__udp_io(uv_loop_t* loop, uv__io_t* w, unsigned int revents) {
  (void) loop;
  (void) w;
  (void) revents;
  UNREACHABLE();  /* no UDP fd can ever be watched */
}

int uv__udp_bind(uv_udp_t* handle,
                 const struct sockaddr* addr,
                 unsigned int addrlen,
                 unsigned int flags) {
  (void) handle; (void) addr; (void) addrlen; (void) flags;
  return UV_ENOSYS;
}

int uv__udp_connect(uv_udp_t* handle,
                    const struct sockaddr* addr,
                    unsigned int addrlen) {
  (void) handle; (void) addr; (void) addrlen;
  return UV_ENOSYS;
}

int uv__udp_disconnect(uv_udp_t* handle) {
  (void) handle;
  return UV_ENOTCONN;
}

int uv__udp_send(uv_udp_send_t* req,
                 uv_udp_t* handle,
                 const uv_buf_t bufs[],
                 unsigned int nbufs,
                 const struct sockaddr* addr,
                 unsigned int addrlen,
                 uv_udp_send_cb send_cb) {
  (void) req; (void) handle; (void) bufs; (void) nbufs;
  (void) addr; (void) addrlen; (void) send_cb;
  return UV_ENOSYS;
}

int uv__udp_try_send(uv_udp_t* handle,
                     const uv_buf_t bufs[],
                     unsigned int nbufs,
                     const struct sockaddr* addr,
                     unsigned int addrlen) {
  (void) handle; (void) bufs; (void) nbufs; (void) addr; (void) addrlen;
  return UV_ENOSYS;
}

int uv__udp_try_send2(uv_udp_t* handle,
                      unsigned int count,
                      uv_buf_t* bufs[],
                      unsigned int nbufs[],
                      struct sockaddr* addrs[]) {
  (void) handle; (void) count; (void) bufs; (void) nbufs; (void) addrs;
  return UV_ENOSYS;
}

int uv__udp_recv_start(uv_udp_t* handle,
                       uv_alloc_cb alloc_cb,
                       uv_udp_recv_cb recv_cb) {
  (void) handle; (void) alloc_cb; (void) recv_cb;
  return UV_ENOSYS;
}

int uv__udp_recv_stop(uv_udp_t* handle) {
  (void) handle;
  return 0;
}

/* --- public API pieces upstream udp.c owns -------------------------------- */

int uv_udp_using_recvmmsg(const uv_udp_t* handle) {
  (void) handle;
  return 0;
}

int uv_udp_open(uv_udp_t* handle, uv_os_sock_t sock) {
  (void) handle; (void) sock;
  return UV_ENOSYS;
}

int uv_udp_open_ex(uv_udp_t* handle, uv_os_sock_t sock, unsigned int flags) {
  (void) handle; (void) sock; (void) flags;
  return UV_ENOSYS;
}

int uv_udp_set_membership(uv_udp_t* handle,
                          const char* multicast_addr,
                          const char* interface_addr,
                          uv_membership membership) {
  (void) handle; (void) multicast_addr; (void) interface_addr;
  (void) membership;
  return UV_ENOSYS;
}

int uv_udp_set_source_membership(uv_udp_t* handle,
                                 const char* multicast_addr,
                                 const char* interface_addr,
                                 const char* source_addr,
                                 uv_membership membership) {
  (void) handle; (void) multicast_addr; (void) interface_addr;
  (void) source_addr; (void) membership;
  return UV_ENOSYS;
}

int uv_udp_set_broadcast(uv_udp_t* handle, int on) {
  (void) handle; (void) on;
  return UV_ENOSYS;
}

int uv_udp_set_ttl(uv_udp_t* handle, int ttl) {
  (void) handle; (void) ttl;
  return UV_ENOSYS;
}

int uv_udp_set_multicast_ttl(uv_udp_t* handle, int ttl) {
  (void) handle; (void) ttl;
  return UV_ENOSYS;
}

int uv_udp_set_multicast_loop(uv_udp_t* handle, int on) {
  (void) handle; (void) on;
  return UV_ENOSYS;
}

int uv_udp_set_multicast_interface(uv_udp_t* handle,
                                   const char* interface_addr) {
  (void) handle; (void) interface_addr;
  return UV_ENOSYS;
}

int uv_udp_getpeername(const uv_udp_t* handle,
                       struct sockaddr* name,
                       int* namelen) {
  (void) handle; (void) name; (void) namelen;
  return UV_ENOTCONN;
}

int uv_udp_getsockname(const uv_udp_t* handle,
                       struct sockaddr* name,
                       int* namelen) {
  (void) handle; (void) name; (void) namelen;
  return UV_ENOSYS;
}
