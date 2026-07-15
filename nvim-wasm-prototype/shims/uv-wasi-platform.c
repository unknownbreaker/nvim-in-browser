/* shims/uv-wasi-platform.c
 *
 * WHAT: Miscellaneous per-platform entry points every libuv port must
 * provide, for wasm32-wasi: exepath, memory/cpu/uptime/loadavg queries,
 * rss, and the internal uv__random_getentropy used by the __wasi__ branch
 * patched into src/random.c. Upstream keeps these in the per-OS files
 * (linux.c, darwin.c, ...) that this port does not compile.
 *
 * WHY / DESIGN: Queries that cannot be answered under WASI preview1
 * return honest UV_ENOSYS (exepath, cpu_info). Memory queries return
 * real, if coarse, numbers derived from the wasm linear memory
 * (memory.size * 64KiB used; a fixed 4 GiB-per-wasm32 ceiling for
 * "total") so callers doing arithmetic get sane values instead of lies.
 * Randomness maps to getentropy(), which wasi-libc implements directly on
 * the WASI random_get syscall — no /dev/urandom, no dlsym probing.
 *
 * CLEAN-ROOM PROVENANCE: Entry-point contract from libuv v1.52.1
 * include/uv.h + src/unix/internal.h (MIT, vendored in src-cache/libuv);
 * WASI facts from the preview1 spec and wasi-libc headers. No excluded
 * project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <unistd.h>

/* wasm32 linear memory: pages are 64 KiB; address space caps at 4 GiB. */
#define UV__WASI_PAGE_SIZE 65536ULL
#define UV__WASI_MEM_CEILING (4096ULL * 1024 * 1024)

static uint64_t uv__wasi_memory_used(void) {
  return (uint64_t) __builtin_wasm_memory_size(0) * UV__WASI_PAGE_SIZE;
}

int uv_exepath(char* buffer, size_t* size) {
  /* There is no "path to the running executable" inside the sandbox. */
  if (buffer == NULL || size == NULL || *size == 0)
    return UV_EINVAL;
  return UV_ENOSYS;
}

uint64_t uv_get_free_memory(void) {
  uint64_t used = uv__wasi_memory_used();
  return used < UV__WASI_MEM_CEILING ? UV__WASI_MEM_CEILING - used : 0;
}

uint64_t uv_get_total_memory(void) {
  return UV__WASI_MEM_CEILING;
}

uint64_t uv_get_constrained_memory(void) {
  return 0;  /* "no constraint configured", same as upstream defaults */
}

uint64_t uv_get_available_memory(void) {
  return uv_get_free_memory();
}

int uv_resident_set_memory(size_t* rss) {
  *rss = (size_t) uv__wasi_memory_used();
  return 0;
}

int uv_uptime(double* uptime) {
  /* Closest observable notion: monotonic time since module start. */
  *uptime = (double) uv_hrtime() / 1e9;
  return 0;
}

int uv_cpu_info(uv_cpu_info_t** cpu_infos, int* count) {
  *cpu_infos = NULL;
  *count = 0;
  return UV_ENOSYS;
}

void uv_loadavg(double avg[3]) {
  avg[0] = 0.0;
  avg[1] = 0.0;
  avg[2] = 0.0;
}

int uv_interface_addresses(uv_interface_address_t** addresses, int* count) {
  *addresses = NULL;
  *count = 0;
  return UV_ENOSYS;
}

/* uv_free_interface_addresses is NOT defined here: it lives in upstream
 * src/uv-common.c (compiled into libuv.a unmodified) and is a plain no-op
 * free-of-nothing there too, since uv_interface_addresses() above always
 * reports UV_ENOSYS and never allocates. Defining it a second time here
 * used to produce a duplicate strong symbol that only failed at final-link
 * time for any consumer pulling in both this object and uv-common.o (see
 * test/uv-linkall.c, which guards against this class of regression). */

/* uv__get_rlimit_max_memory stays in upstream core.c; our getrlimit stub
 * makes it report "no limit configured" (0). */

int uv__random_getentropy(void* buf, size_t buflen) {
  size_t pos;
  size_t stride;

  /* getentropy() rejects requests larger than 256 bytes. */
  for (pos = 0, stride = 256; pos + stride < buflen; pos += stride)
    if (getentropy((char*) buf + pos, stride))
      return UV__ERR(errno);

  if (getentropy((char*) buf + pos, buflen - pos))
    return UV__ERR(errno);

  return 0;
}
