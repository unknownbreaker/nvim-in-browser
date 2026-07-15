/* shims/wasi-libc-missing.c
 *
 * WHAT: Definitions for POSIX functions that wasi-libc DECLARES (or that
 * our shims/include headers declare) but does not DEFINE in libc.a, and
 * that upstream libuv translation units reference. Without these the
 * final wasm link fails on undefined symbols even though the code paths
 * are unreachable or expected to fail at runtime. Plus one deliberate
 * REPLACEMENT of a function wasi-libc defines but unusably for
 * rights-agnostic hosts: access(), routed here via a macro in
 * uv-wasi-fixups.h (see uv__wasi_access_shim below).
 *
 * WHY / DESIGN: Every stub is honest about capability:
 *   - syscall-shaped functions set errno = ENOSYS and return -1, so
 *     libuv's UV__ERR(errno) translation produces UV_ENOSYS naturally;
 *   - pthread_sigmask/sigset ops "succeed" as no-ops because with no
 *     signal delivery an empty mask is genuinely in effect;
 *   - mkdtemp is implemented for real (getentropy + mkdir) because
 *     callers (uv_fs_mkdtemp -> Neovim tempdirs) need it to work inside
 *     the preopened filesystem;
 *   - the dl* family reports "not supported" through dlerror, matching
 *     a static-only world.
 *
 * CLEAN-ROOM PROVENANCE: Signatures from POSIX.1-2017; sigset_t layout
 * from wasi-libc's shipped headers. No excluded project consulted.
 */

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netdb.h>
#include <pwd.h>
#include <signal.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <termios.h>
#include <unistd.h>

static int uv__wasi_enosys(void) {
  errno = ENOSYS;
  return -1;
}

/* --- sockets (WASI preview1 cannot create or name sockets) --------------- */

int socket(int domain, int type, int protocol) {
  (void) domain; (void) type; (void) protocol;
  return uv__wasi_enosys();
}

int socketpair(int domain, int type, int protocol, int fds[2]) {
  (void) domain; (void) type; (void) protocol; (void) fds;
  return uv__wasi_enosys();
}

int bind(int fd, const struct sockaddr* addr, socklen_t len) {
  (void) fd; (void) addr; (void) len;
  return uv__wasi_enosys();
}

int connect(int fd, const struct sockaddr* addr, socklen_t len) {
  (void) fd; (void) addr; (void) len;
  return uv__wasi_enosys();
}

int listen(int fd, int backlog) {
  (void) fd; (void) backlog;
  return uv__wasi_enosys();
}

/* accept/accept4/getsockopt: already defined by wasi-libc (sock_accept
 * exists in preview1), so no stubs for those here. */

int getsockname(int fd, struct sockaddr* restrict addr,
                socklen_t* restrict len) {
  (void) fd; (void) addr; (void) len;
  return uv__wasi_enosys();
}

int getpeername(int fd, struct sockaddr* restrict addr,
                socklen_t* restrict len) {
  (void) fd; (void) addr; (void) len;
  return uv__wasi_enosys();
}

int setsockopt(int fd, int level, int optname,
               const void* optval, socklen_t optlen) {
  (void) fd; (void) level; (void) optname; (void) optval; (void) optlen;
  return uv__wasi_enosys();
}

ssize_t sendmsg(int fd, const struct msghdr* msg, int flags) {
  (void) fd; (void) msg; (void) flags;
  errno = ENOSYS;
  return -1;
}

ssize_t recvmsg(int fd, struct msghdr* msg, int flags) {
  (void) fd; (void) msg; (void) flags;
  errno = ENOSYS;
  return -1;
}

/* --- name resolution ------------------------------------------------------ */

int getaddrinfo(const char* restrict node, const char* restrict service,
                const struct addrinfo* restrict hints,
                struct addrinfo** restrict res) {
  (void) node; (void) service; (void) hints;
  if (res != NULL)
    *res = NULL;
  return EAI_FAIL;
}

void freeaddrinfo(struct addrinfo* ai) {
  /* Our getaddrinfo never allocates. */
  (void) ai;
}

int getnameinfo(const struct sockaddr* restrict addr, socklen_t addrlen,
                char* restrict host, socklen_t hostlen,
                char* restrict serv, socklen_t servlen, int flags) {
  (void) addr; (void) addrlen; (void) host; (void) hostlen;
  (void) serv; (void) servlen; (void) flags;
  return EAI_FAIL;
}

const char* gai_strerror(int ecode) {
  (void) ecode;
  return "name resolution is not available under WASI";
}

/* --- signals (no delivery; empty masks are genuinely in effect) ----------- */

int pthread_sigmask(int how, const sigset_t* restrict set,
                    sigset_t* restrict old) {
  (void) how; (void) set;
  if (old != NULL)
    memset(old, 0, sizeof(*old));
  return 0;
}

int sigemptyset(sigset_t* set) {
  memset(set, 0, sizeof(*set));
  return 0;
}

int sigfillset(sigset_t* set) {
  memset(set, 0xff, sizeof(*set));
  return 0;
}

int sigaddset(sigset_t* set, int sig) {
  unsigned s = (unsigned) sig - 1;
  if (sig < 1 || s >= 8 * sizeof(*set)) {
    errno = EINVAL;
    return -1;
  }
  ((unsigned char*) set)[s / 8] |= (unsigned char) (1u << (s % 8));
  return 0;
}

int sigdelset(sigset_t* set, int sig) {
  unsigned s = (unsigned) sig - 1;
  if (sig < 1 || s >= 8 * sizeof(*set)) {
    errno = EINVAL;
    return -1;
  }
  ((unsigned char*) set)[s / 8] &= (unsigned char) ~(1u << (s % 8));
  return 0;
}

/* --- users/groups (no user database in the sandbox) ----------------------- */

struct passwd* getpwnam(const char* name) {
  (void) name;
  errno = ENOSYS;
  return NULL;
}

struct passwd* getpwuid(uid_t uid) {
  (void) uid;
  errno = ENOSYS;
  return NULL;
}

int getpwnam_r(const char* name, struct passwd* pwd, char* buf,
               size_t buflen, struct passwd** result) {
  (void) name; (void) pwd; (void) buf; (void) buflen;
  *result = NULL;
  return ENOSYS;
}

int getpwuid_r(uid_t uid, struct passwd* pwd, char* buf,
               size_t buflen, struct passwd** result) {
  (void) uid; (void) pwd; (void) buf; (void) buflen;
  *result = NULL;
  return ENOSYS;
}

struct group* getgrnam(const char* name) {
  (void) name;
  errno = ENOSYS;
  return NULL;
}

struct group* getgrgid(gid_t gid) {
  (void) gid;
  errno = ENOSYS;
  return NULL;
}

int getgrnam_r(const char* name, struct group* grp, char* buf,
               size_t buflen, struct group** result) {
  (void) name; (void) grp; (void) buf; (void) buflen;
  *result = NULL;
  return ENOSYS;
}

int getgrgid_r(gid_t gid, struct group* grp, char* buf,
               size_t buflen, struct group** result) {
  (void) gid; (void) grp; (void) buf; (void) buflen;
  *result = NULL;
  return ENOSYS;
}

uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
gid_t getegid(void) { return 0; }
pid_t getppid(void) { return 0; }

/* No identity switching in the sandbox (luv's misc.c setuid/setgid
 * bindings): fail honestly with EPERM. */
int setuid(uid_t uid) {
  (void) uid;
  errno = EPERM;
  return -1;
}

int setgid(gid_t gid) {
  (void) gid;
  errno = EPERM;
  return -1;
}

/* No protocol database in the sandbox (luv's constants.c): NULL means
 * "unknown protocol", which the bindings surface as nil. */
struct protoent* getprotobyname(const char* name) {
  (void) name;
  return NULL;
}

struct protoent* getprotobynumber(int proto) {
  (void) proto;
  return NULL;
}

/* --- scheduling introspection (single thread, no scheduler) ---------------- */

int sched_get_priority_max(int policy) {
  (void) policy;
  return 0;
}

int sched_get_priority_min(int policy) {
  (void) policy;
  return 0;
}

int pthread_getschedparam(pthread_t t, int* policy,
                          struct sched_param* param) {
  (void) t; (void) policy; (void) param;
  return ENOSYS;
}

int pthread_setschedparam(pthread_t t, int policy,
                          const struct sched_param* param) {
  (void) t; (void) policy; (void) param;
  return ENOSYS;
}

/* --- ownership / limits / priority ---------------------------------------- */

int chown(const char* path, uid_t uid, gid_t gid) {
  (void) path; (void) uid; (void) gid;
  return uv__wasi_enosys();
}

int fchown(int fd, uid_t uid, gid_t gid) {
  (void) fd; (void) uid; (void) gid;
  return uv__wasi_enosys();
}

int lchown(const char* path, uid_t uid, gid_t gid) {
  (void) path; (void) uid; (void) gid;
  return uv__wasi_enosys();
}

int getrlimit(int resource, struct rlimit* rlim) {
  (void) resource; (void) rlim;
  return uv__wasi_enosys();
}

int setrlimit(int resource, const struct rlimit* rlim) {
  (void) resource; (void) rlim;
  return uv__wasi_enosys();
}

int getpriority(int which, id_t who) {
  (void) which; (void) who;
  return uv__wasi_enosys();
}

int setpriority(int which, id_t who, int prio) {
  (void) which; (void) who; (void) prio;
  return uv__wasi_enosys();
}

/* --- network interfaces (none exist in the sandbox) ------------------------ */

/* Declared by wasi-libc's own <ifaddrs.h> but absent from libc.a. No
 * network interfaces exist in the sandbox; libuv's tcp.c only consults
 * this for IPv6 link-local scope ids and treats failure as scope 0. */
int getifaddrs(struct ifaddrs** ifap) {
  (void) ifap;
  errno = ENOSYS;
  return -1;
}

void freeifaddrs(struct ifaddrs* ifa) {
  (void) ifa;
}

unsigned int if_nametoindex(const char* name) {
  (void) name;
  errno = ENXIO;
  return 0;
}

char* if_indextoname(unsigned int index, char* buf) {
  (void) index; (void) buf;
  errno = ENXIO;
  return NULL;
}

/* --- pipes ----------------------------------------------------------------- */

int pipe(int fds[2]) {
  (void) fds;
  return uv__wasi_enosys();
}

int pipe2(int fds[2], int flags) {
  (void) fds; (void) flags;
  return uv__wasi_enosys();
}

int dup(int fd) {
  (void) fd;
  return uv__wasi_enosys();
}

int dup2(int oldfd, int newfd) {
  (void) oldfd; (void) newfd;
  return uv__wasi_enosys();
}

/* --- access (REAL replacement for wasi-libc's rights-based one) ------------ */

/* wasi-libc implements access(amode != F_OK) by testing the requested
 * rights against the preopen directory fd's fs_rights_inheriting.
 * Rights-agnostic hosts (e.g. @bjorn3/browser_wasi_shim, used by the parent
 * engine host) report ZERO rights on directory fds, so every R_OK/W_OK/X_OK
 * probe fails EACCES even for perfectly readable files — which breaks
 * Neovim's os_file_is_readable() and with it nvim__get_runtime()'s Lua
 * module search (every runtime `require` fails). The preview1 rights system
 * carries no permission-bit information anyway (filestat has no mode), so
 * the honest capability answer is: existence == accessible, and the actual
 * open may still fail. X_OK is granted only for directories (traversal);
 * nothing is executable under WASI (no processes), so granting X_OK on
 * files would only mislead os_can_exe().
 *
 * NOT a link-level override of the `access` symbol: wasi-libc defines
 * access() in its monolithic posix.c.obj, which the link extracts anyway
 * for other symbols — a same-named strong definition here is a guaranteed
 * duplicate-symbol error (caught by test/uv-linkall.c's link-all gate).
 * Instead, shims/uv-wasi-fixups.h (force-included into every libuv TU)
 * #defines access to this function, so libuv's uv_fs_access — the only
 * access() caller in the whole link (verified: neither Neovim nor PUC Lua
 * call it directly) — is routed here at compile time. */
int uv__wasi_access_shim(const char* path, int amode) {
  struct stat st;

  if (stat(path, &st) != 0)
    return -1;  /* errno from stat (ENOENT, ENOTDIR, ...) */
  if ((amode & X_OK) != 0 && !S_ISDIR(st.st_mode)) {
    errno = EACCES;
    return -1;
  }
  return 0;
}

/* --- statfs on top of statvfs (REAL implementation) ------------------------ */

int statfs(const char* path, struct statfs* buf) {
  struct statvfs v;

  if (statvfs(path, &v) != 0)
    return -1;

  memset(buf, 0, sizeof(*buf));
  buf->f_type = 0;  /* unknown filesystem type */
  buf->f_bsize = v.f_bsize;
  buf->f_frsize = v.f_frsize;
  buf->f_blocks = v.f_blocks;
  buf->f_bfree = v.f_bfree;
  buf->f_bavail = v.f_bavail;
  buf->f_files = v.f_files;
  buf->f_ffree = v.f_ffree;
  buf->f_namelen = v.f_namemax;
  buf->f_flags = v.f_flag;
  return 0;
}

int fstatfs(int fd, struct statfs* buf) {
  struct statvfs v;

  if (fstatvfs(fd, &v) != 0)
    return -1;

  memset(buf, 0, sizeof(*buf));
  buf->f_type = 0;
  buf->f_bsize = v.f_bsize;
  buf->f_frsize = v.f_frsize;
  buf->f_blocks = v.f_blocks;
  buf->f_bfree = v.f_bfree;
  buf->f_bavail = v.f_bavail;
  buf->f_files = v.f_files;
  buf->f_ffree = v.f_ffree;
  buf->f_namelen = v.f_namemax;
  buf->f_flags = v.f_flag;
  return 0;
}

/* --- mkdtemp (REAL implementation: needed by uv_fs_mkdtemp) ---------------- */

char* mkdtemp(char* tmpl) {
  size_t len;
  char* xs;
  int tries;
  static const char alphabet[] =
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  len = strlen(tmpl);
  if (len < 6 || strcmp(tmpl + len - 6, "XXXXXX") != 0) {
    errno = EINVAL;
    return NULL;
  }
  xs = tmpl + len - 6;

  for (tries = 0; tries < 100; tries++) {
    unsigned char rnd[6];
    int i;

    if (getentropy(rnd, sizeof(rnd)) != 0)
      return NULL;
    for (i = 0; i < 6; i++)
      xs[i] = alphabet[rnd[i] % (sizeof(alphabet) - 1)];

    if (mkdir(tmpl, 0700) == 0)
      return tmpl;
    if (errno != EEXIST)
      return NULL;
  }

  errno = EEXIST;
  return NULL;
}

int mkstemp(char* tmpl) {
  size_t len;
  char* xs;
  int tries;
  static const char alphabet[] =
      "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

  len = strlen(tmpl);
  if (len < 6 || strcmp(tmpl + len - 6, "XXXXXX") != 0) {
    errno = EINVAL;
    return -1;
  }
  xs = tmpl + len - 6;

  for (tries = 0; tries < 100; tries++) {
    unsigned char rnd[6];
    int i;
    int fd;

    if (getentropy(rnd, sizeof(rnd)) != 0)
      return -1;
    for (i = 0; i < 6; i++)
      xs[i] = alphabet[rnd[i] % (sizeof(alphabet) - 1)];

    fd = open(tmpl, O_RDWR | O_CREAT | O_EXCL, 0600);
    if (fd >= 0)
      return fd;
    if (errno != EEXIST)
      return -1;
  }

  errno = EEXIST;
  return -1;
}

/* --- dynamic loading (static-only world) ------------------------------------ */

void* dlopen(const char* file, int mode) {
  (void) file; (void) mode;
  return NULL;
}

int dlclose(void* handle) {
  (void) handle;
  return 0;
}

void* dlsym(void* restrict handle, const char* restrict name) {
  (void) handle; (void) name;
  return NULL;
}

char* dlerror(void) {
  return (char*) "dynamic loading is not supported under WASI";
}

/* --- termios (no terminals in the sandbox) ---------------------------------- */

int tcgetattr(int fd, struct termios* t) {
  (void) fd;
  memset(t, 0, sizeof(*t));
  errno = ENOTSUP;
  return -1;
}

int tcsetattr(int fd, int actions, const struct termios* t) {
  (void) fd; (void) actions; (void) t;
  errno = ENOTSUP;
  return -1;
}

int tcsendbreak(int fd, int duration) {
  (void) fd; (void) duration;
  errno = ENOTSUP;
  return -1;
}

int tcdrain(int fd) {
  (void) fd;
  return 0;
}

int tcflush(int fd, int queue) {
  (void) fd; (void) queue;
  return 0;
}

int tcflow(int fd, int action) {
  (void) fd; (void) action;
  errno = ENOTSUP;
  return -1;
}

void cfmakeraw(struct termios* t) {
  memset(t, 0, sizeof(*t));
  t->c_cflag = CS8 | CREAD;
  t->c_cc[VMIN] = 1;
  t->c_cc[VTIME] = 0;
}

speed_t cfgetispeed(const struct termios* t) {
  return t->__c_ispeed;
}

speed_t cfgetospeed(const struct termios* t) {
  return t->__c_ospeed;
}

int cfsetispeed(struct termios* t, speed_t s) {
  t->__c_ispeed = s;
  return 0;
}

int cfsetospeed(struct termios* t, speed_t s) {
  t->__c_ospeed = s;
  return 0;
}
