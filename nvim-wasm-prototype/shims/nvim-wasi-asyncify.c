/* shims/nvim-wasi-asyncify.c
 *
 * WHAT: Reserves the Binaryen-Asyncify scratch region inside the module's
 * own linear memory and exports the three discovery helpers the parent
 * engine host (src/engine/nvim-host.ts) calls unconditionally at boot:
 *
 *   nvim_asyncify_get_data_ptr()    -> 8-byte asyncify data descriptor
 *   nvim_asyncify_get_stack_start() -> first byte of the unwind stack
 *   nvim_asyncify_get_stack_end()   -> one past the last byte
 *
 * The host initializes the descriptor as the standard Asyncify [current,
 * end] i32 pair (current = stack_start, end = stack_end) and passes the
 * descriptor pointer to asyncify_start_unwind()/asyncify_start_rewind().
 *
 * WHY: When wasm-opt --asyncify suspends a call stack it serializes the
 * locals + call-path of every live frame into this region. It must live in
 * data the rest of the program never touches. Putting it in .bss (rather
 * than having the host memory.grow a page range) keeps the contract
 * explicit and lets the module, not the host, size it. 4 MiB comfortably
 * exceeds nvim's deepest poll-suspension chains (the linked module already
 * reserves an 8 MiB conventional stack; asyncify frames are far smaller
 * than native frames since only live locals are spilled).
 *
 * These functions are referenced by nothing inside the module, so they are
 * linked as a standalone object file (never an archive member — an
 * archive member with no undefined-symbol pull would be silently dropped
 * and the exports would vanish). __attribute__((export_name)) makes
 * wasm-ld both retain and export them.
 *
 * CLEAN-ROOM PROVENANCE: contract derived from the parent repo's own
 * src/engine/nvim-host.ts (ours) and the Binaryen Asyncify pass
 * documentation (src/passes/Asyncify.cpp header comment in the pinned
 * binaryen release describes the data-descriptor layout). No excluded
 * project consulted.
 */

#include <stdint.h>

#define NVIM_ASYNCIFY_STACK_SIZE (4u * 1024u * 1024u)

/* [current, end] i32 pair; written by the host before the first unwind. */
static uint32_t nvim_asyncify_data[2];

static uint8_t nvim_asyncify_stack[NVIM_ASYNCIFY_STACK_SIZE]
    __attribute__((aligned(16)));

__attribute__((export_name("nvim_asyncify_get_data_ptr")))
uint32_t nvim_asyncify_get_data_ptr(void) {
  return (uint32_t)(uintptr_t)nvim_asyncify_data;
}

__attribute__((export_name("nvim_asyncify_get_stack_start")))
uint32_t nvim_asyncify_get_stack_start(void) {
  return (uint32_t)(uintptr_t)nvim_asyncify_stack;
}

__attribute__((export_name("nvim_asyncify_get_stack_end")))
uint32_t nvim_asyncify_get_stack_end(void) {
  return (uint32_t)(uintptr_t)(nvim_asyncify_stack + NVIM_ASYNCIFY_STACK_SIZE);
}
