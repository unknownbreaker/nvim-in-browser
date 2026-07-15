/* shims/uv-wasi-threads.c
 *
 * WHAT: The uv_thread_* / uv_mutex_* / uv_rwlock_* / uv_sem_* /
 * uv_cond_* / uv_barrier_* / uv_once / uv_key_* surface for the
 * single-threaded wasm32-wasi libuv port. Replaces upstream
 * src/unix/thread.c and src/thread-common.c.
 *
 * WHY / DESIGN: This build targets non-threaded wasm32-wasi (no atomics,
 * no shared memory, THREAD_MODEL=single wasi-libc). There is exactly one
 * thread, ever, so:
 *
 *   - locks (mutex/rwlock) are no-ops that always succeed: single-threaded
 *     code cannot contend. Recursive-mutex semantics degenerate the same
 *     way.
 *   - semaphores keep a real counter; sem_wait on a zero count would
 *     deadlock forever (no thread can ever post) — that is a programming
 *     error under this port, so it aborts loudly rather than hanging.
 *   - condition variables: signal/broadcast are no-ops (nobody can be
 *     waiting); cond_wait aborts for the same deadlock reason;
 *     cond_timedwait "times out" immediately (the only honest outcome).
 *   - uv_thread_create fails with UV_ENOSYS (honest: threads cannot be
 *     spawned), per the port design "stub threads, no-op mutexes".
 *   - uv_once runs the callback inline exactly once, tracked in the
 *     pthread_once_t guard word (0 = pristine, per PTHREAD_ONCE_INIT).
 *   - TLS keys are a tiny table: with one thread, key/value pairs are
 *     just globals.
 *
 * CLEAN-ROOM PROVENANCE: API contract from libuv v1.52.1 include/uv.h and
 * docs (MIT, vendored in src-cache/libuv); pthread_once_t/pthread_key_t
 * representation facts from wasi-libc's shipped headers. No excluded
 * project consulted.
 */

#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void uv__wasi_deadlock(const char* what) {
  fprintf(stderr,
          "libuv-wasi: %s would deadlock forever on this single-threaded "
          "target; aborting\n",
          what);
  abort();
}

/* --- threads ------------------------------------------------------------ */

int uv_thread_create(uv_thread_t* tid, uv_thread_cb entry, void* arg) {
  (void) tid;
  (void) entry;
  (void) arg;
  return UV_ENOSYS;
}

int uv_thread_create_ex(uv_thread_t* tid,
                        const uv_thread_options_t* params,
                        uv_thread_cb entry,
                        void* arg) {
  (void) params;
  return uv_thread_create(tid, entry, arg);
}

int uv_thread_detach(uv_thread_t* tid) {
  (void) tid;
  return UV_ENOSYS;
}

int uv_thread_join(uv_thread_t* tid) {
  (void) tid;
  return UV_ENOSYS;
}

uv_thread_t uv_thread_self(void) {
  /* One thread; any stable non-zero token works. wasi-libc's own
   * single-thread pthread_self() returns its static thread structure. */
  return pthread_self();
}

int uv_thread_equal(const uv_thread_t* t1, const uv_thread_t* t2) {
  return *t1 == *t2;
}

int uv_thread_setaffinity(uv_thread_t* tid,
                          char* cpumask,
                          char* oldmask,
                          size_t mask_size) {
  (void) tid;
  (void) cpumask;
  (void) oldmask;
  (void) mask_size;
  return UV_ENOTSUP;
}

int uv_thread_getaffinity(uv_thread_t* tid, char* cpumask, size_t mask_size) {
  (void) tid;
  (void) cpumask;
  (void) mask_size;
  return UV_ENOTSUP;
}

int uv_thread_getcpu(void) {
  return 0;
}

int uv_thread_setname(const char* name) {
  (void) name;
  return UV_ENOSYS;
}

int uv_thread_getname(uv_thread_t* tid, char* name, size_t size) {
  (void) tid;
  if (name == NULL || size == 0)
    return UV_EINVAL;
  name[0] = '\0';
  return UV_ENOSYS;
}

int uv__thread_setname(const char* name) {
  (void) name;
  return UV_ENOSYS;
}

int uv__thread_getname(uv_thread_t* tid, char* name, size_t size) {
  return uv_thread_getname(tid, name, size);
}

size_t uv__thread_stack_size(void) {
  return 0;
}

/* --- once --------------------------------------------------------------- */

void uv_once(uv_once_t* guard, void (*callback)(void)) {
  /* pthread_once_t is plain int in wasi-libc; PTHREAD_ONCE_INIT == 0.
   * 0 = pristine, 1 = callback currently running, 2 = complete. */
  if (*guard == 2)
    return;

  if (*guard == 1) {
    /* Re-entrant call: the guarded callback is itself (directly or
     * transitively) calling uv_once() on the same guard while it is still
     * running. There is only one thread, so this can never be "someone
     * else already finished it" -- it can only be a genuine self-deadlock
     * (the original call is still on the stack, waiting for this one to
     * return before it can set guard = 2). Silently treating this as
     * "already done" would let the caller proceed against a partially
     * initialized result, which is worse than the honest deadlock upstream
     * would have produced. */
    uv__wasi_deadlock("uv_once() reentered on a guard still initializing");
    return;
  }

  *guard = 1;
  callback();
  *guard = 2;
}

/* --- mutexes (no contention possible: always succeed) -------------------- */

int uv_mutex_init(uv_mutex_t* mutex) {
  memset(mutex, 0, sizeof(*mutex));
  return 0;
}

int uv_mutex_init_recursive(uv_mutex_t* mutex) {
  return uv_mutex_init(mutex);
}

void uv_mutex_destroy(uv_mutex_t* mutex) {
  (void) mutex;
}

void uv_mutex_lock(uv_mutex_t* mutex) {
  (void) mutex;
}

int uv_mutex_trylock(uv_mutex_t* mutex) {
  (void) mutex;
  return 0;
}

void uv_mutex_unlock(uv_mutex_t* mutex) {
  (void) mutex;
}

/* --- rwlocks ------------------------------------------------------------ */

int uv_rwlock_init(uv_rwlock_t* rwlock) {
  memset(rwlock, 0, sizeof(*rwlock));
  return 0;
}

void uv_rwlock_destroy(uv_rwlock_t* rwlock) {
  (void) rwlock;
}

void uv_rwlock_rdlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
}

int uv_rwlock_tryrdlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
  return 0;
}

void uv_rwlock_rdunlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
}

void uv_rwlock_wrlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
}

int uv_rwlock_trywrlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
  return 0;
}

void uv_rwlock_wrunlock(uv_rwlock_t* rwlock) {
  (void) rwlock;
}

/* --- semaphores (real counter; blocking on zero is a deadlock) ----------- */

/* uv_sem_t is sem_t; we only use its first machine word as the counter.
 * sizeof(sem_t) >= sizeof(int) on wasi-libc (verified against the shipped
 * <semaphore.h>). */

static int* uv__sem_count(uv_sem_t* sem) {
  return (int*) sem;
}

int uv_sem_init(uv_sem_t* sem, unsigned int value) {
  memset(sem, 0, sizeof(*sem));
  *uv__sem_count(sem) = (int) value;
  return 0;
}

void uv_sem_destroy(uv_sem_t* sem) {
  (void) sem;
}

void uv_sem_post(uv_sem_t* sem) {
  ++*uv__sem_count(sem);
}

void uv_sem_wait(uv_sem_t* sem) {
  if (*uv__sem_count(sem) <= 0)
    uv__wasi_deadlock("uv_sem_wait() on an unavailable semaphore");
  --*uv__sem_count(sem);
}

int uv_sem_trywait(uv_sem_t* sem) {
  if (*uv__sem_count(sem) <= 0)
    return UV_EAGAIN;
  --*uv__sem_count(sem);
  return 0;
}

/* --- condition variables -------------------------------------------------- */

int uv_cond_init(uv_cond_t* cond) {
  memset(cond, 0, sizeof(*cond));
  return 0;
}

void uv_cond_destroy(uv_cond_t* cond) {
  (void) cond;
}

void uv_cond_signal(uv_cond_t* cond) {
  (void) cond;
}

void uv_cond_broadcast(uv_cond_t* cond) {
  (void) cond;
}

void uv_cond_wait(uv_cond_t* cond, uv_mutex_t* mutex) {
  (void) cond;
  (void) mutex;
  uv__wasi_deadlock("uv_cond_wait()");
}

int uv_cond_timedwait(uv_cond_t* cond, uv_mutex_t* mutex, uint64_t timeout) {
  struct timespec ts;

  (void) cond;
  (void) mutex;

  /* Nobody can ever signal; sleep out the timeout (so callers pacing on
   * a timed wait do not spin), then report the only possible outcome. */
  ts.tv_sec = (time_t) (timeout / 1000000000ULL);
  ts.tv_nsec = (long) (timeout % 1000000000ULL);
  nanosleep(&ts, NULL);
  return UV_ETIMEDOUT;
}

/* --- barriers ------------------------------------------------------------ */

int uv_barrier_init(uv_barrier_t* barrier, unsigned int count) {
  if (count == 0)
    return UV_EINVAL;
  if (count > 1)
    return UV_ENOTSUP;  /* >1 participants can never rendezvous. */
  memset(barrier, 0, sizeof(*barrier));
  return 0;
}

int uv_barrier_wait(uv_barrier_t* barrier) {
  (void) barrier;
  return 1;  /* "serial thread" return: sole participant. */
}

void uv_barrier_destroy(uv_barrier_t* barrier) {
  (void) barrier;
}

/* --- thread-local keys (one thread: plain table) -------------------------- */

#define UV__WASI_MAX_KEYS 64

static void* uv__wasi_key_values[UV__WASI_MAX_KEYS];
static unsigned char uv__wasi_key_used[UV__WASI_MAX_KEYS];

int uv_key_create(uv_key_t* key) {
  unsigned int i;
  for (i = 0; i < UV__WASI_MAX_KEYS; i++) {
    if (!uv__wasi_key_used[i]) {
      uv__wasi_key_used[i] = 1;
      uv__wasi_key_values[i] = NULL;
      *(unsigned int*) key = i;
      return 0;
    }
  }
  return UV_ENOMEM;
}

void uv_key_delete(uv_key_t* key) {
  unsigned int i = *(unsigned int*) key;
  if (i < UV__WASI_MAX_KEYS) {
    uv__wasi_key_used[i] = 0;
    uv__wasi_key_values[i] = NULL;
  }
}

void* uv_key_get(uv_key_t* key) {
  unsigned int i = *(unsigned int*) key;
  return i < UV__WASI_MAX_KEYS ? uv__wasi_key_values[i] : NULL;
}

void uv_key_set(uv_key_t* key, void* value) {
  unsigned int i = *(unsigned int*) key;
  if (i >= UV__WASI_MAX_KEYS)
    abort();
  uv__wasi_key_values[i] = value;
}
