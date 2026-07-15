/* test/uv-linkall.c — link-all gate for the wasm32-wasi libuv port.
 *
 * WHAT: Compiles and LINKS (never runs) against every object file that ends
 * up inside build/deps/lib/libuv.a: all nine shims/uv-wasi-*.c ports plus a
 * handful of upstream-heavy libuv entry points (uv-common.c, unix/tcp.c,
 * unix/fs.c, unix/getaddrinfo.c, src/random.c, unix/posix-hrtime.c,
 * unix/loop.c).
 *
 * WHY: A static archive (.a) does not itself detect duplicate global
 * symbols across its member object files -- `ar` happily archives two .o's
 * that both define the same name; wasm-ld only notices at the FINAL link,
 * and only if that link's symbol resolution needs to pull in BOTH
 * conflicting objects. test/uv-smoke.c never referenced enough of the
 * public surface to force that, so a genuine duplicate strong symbol slipped
 * through rung 3 unnoticed: shims/uv-wasi-platform.c and upstream
 * src/uv-common.c both defined uv_free_interface_addresses (Finding 1).
 * This file closes that gate: take the address of one exported symbol from
 * every shim object file, plus enough upstream-heavy symbols to guarantee
 * uv-common.o and its neighbors are pulled into the SAME link, so any future
 * accidental duplicate between "the shim layer" and "upstream" fails here,
 * before it ever reaches a real consumer (luv, the eventual Neovim binary).
 *
 * Wired into test/uv-smoke.sh as the first step ("link-all check"): compile
 * + link only, never executed. There is nothing behavioural to observe here
 * -- a successful link IS the assertion.
 *
 * CLEAN-ROOM PROVENANCE: symbol names and signatures from libuv v1.52.1
 * include/uv.h (MIT, vendored in src-cache/libuv) and this port's own
 * shims/ header comments (which document, per file, what each replaces
 * upstream and what it exports). No excluded project consulted.
 */

#include <uv.h>

#include <stddef.h>
#include <stdint.h>

/* shims/uv-wasi-poll.c defines only internal libuv platform hooks (declared
 * in src/unix/internal.h, which is not staged into build/deps/include --
 * only the public uv.h and the staged uv/ headers are). Redeclare the one
 * we need with its known upstream signature so it can be referenced without
 * pulling in the internal header. */
extern int uv__platform_loop_init(uv_loop_t* loop);

typedef void (*uv_linkall_fn)(void);

/* One address-of per shim object file (each entry's comment names the
 * shims/uv-wasi-*.c it pins), plus upstream-heavy symbols whose own
 * translation units carry the bulk of libuv's public API and therefore the
 * greatest chance of an accidental duplicate with a shim. `volatile` keeps
 * the optimizer from deciding these "unused" addresses can be dropped --
 * every entry must actually reach the linker's symbol table. */
static volatile uv_linkall_fn uv_linkall_refs[] = {
  /* shims/uv-wasi-async.c */
  (uv_linkall_fn) uv_async_init,
  /* shims/uv-wasi-platform.c -- uv_free_interface_addresses is Finding 1's
   * former duplicate strong symbol (also defined in upstream
   * src/uv-common.c); referencing it here is what reproduces wasm-ld's
   * duplicate-symbol failure before that fix, and proves it stays gone
   * after. */
  (uv_linkall_fn) uv_cpu_info,
  (uv_linkall_fn) uv_free_interface_addresses,
  /* shims/uv-wasi-poll.c */
  (uv_linkall_fn) uv__platform_loop_init,
  /* shims/uv-wasi-process.c */
  (uv_linkall_fn) uv_spawn,
  /* shims/uv-wasi-signal.c */
  (uv_linkall_fn) uv_signal_start,
  /* shims/uv-wasi-threadpool.c */
  (uv_linkall_fn) uv_queue_work,
  /* shims/uv-wasi-threads.c (uv_once is also Finding 4's re-entrancy fix) */
  (uv_linkall_fn) uv_thread_create,
  (uv_linkall_fn) uv_once,
  /* shims/uv-wasi-tty.c */
  (uv_linkall_fn) uv_tty_init,
  /* shims/uv-wasi-udp.c */
  (uv_linkall_fn) uv_udp_open,

  /* Upstream-heavy symbols: force in the upstream translation units most
   * likely to collide with some shim (uv-common.c, unix/tcp.c, unix/fs.c,
   * unix/getaddrinfo.c, src/random.c, unix/posix-hrtime.c, unix/loop.c). */
  (uv_linkall_fn) uv_strerror,
  (uv_linkall_fn) uv_interface_addresses,
  (uv_linkall_fn) uv_loop_init,
  (uv_linkall_fn) uv_tcp_init,
  (uv_linkall_fn) uv_udp_init,
  (uv_linkall_fn) uv_getaddrinfo,
  (uv_linkall_fn) uv_fs_open,
  (uv_linkall_fn) uv_random,
  (uv_linkall_fn) uv_hrtime,
};

int main(void) {
  size_t i;
  volatile uintptr_t sink = 0;

  /* Touch every entry so nothing above can be proven dead and dropped. */
  for (i = 0; i < sizeof(uv_linkall_refs) / sizeof(uv_linkall_refs[0]); i++)
    sink += (uintptr_t) uv_linkall_refs[i];
  (void) sink;

  return 0;
}
