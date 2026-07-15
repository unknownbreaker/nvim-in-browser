/* shims/include/termios.h
 *
 * WHAT: Minimal <termios.h> for wasm32-wasi. wasi-libc ships no termios at
 * all, but libuv's public header uv/unix.h embeds `struct termios` in
 * uv_tty_t (UV_TTY_PRIVATE_FIELDS), so the type must exist merely to
 * *compile* anything that includes <uv.h>. Neovim's tty code compiles
 * against these declarations too (rung 4).
 *
 * WHY: There are no terminals inside the WASI sandbox; stdio is plain
 * pipes/streams. The struct layout only needs to be self-consistent (it is
 * never shared with a kernel), and every function is defined in
 * shims/wasi-libc-missing.c as an honest ENOTSUP/no-op stub.
 *
 * CLEAN-ROOM PROVENANCE: Written from the POSIX.1-2017 <termios.h>
 * specification (struct members, symbolic constants, function signatures).
 * Constant values are the conventional Linux/musl ABI numbers, chosen so
 * code that hardcodes expectations behaves sanely; no excluded project was
 * consulted.
 */
#ifndef _WASI_SHIM_TERMIOS_H
#define _WASI_SHIM_TERMIOS_H

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned char cc_t;
typedef unsigned int speed_t;
typedef unsigned int tcflag_t;

#define NCCS 32

struct termios {
  tcflag_t c_iflag;
  tcflag_t c_oflag;
  tcflag_t c_cflag;
  tcflag_t c_lflag;
  cc_t c_line;
  cc_t c_cc[NCCS];
  speed_t __c_ispeed;
  speed_t __c_ospeed;
};

/* c_cc subscripts */
#define VINTR    0
#define VQUIT    1
#define VERASE   2
#define VKILL    3
#define VEOF     4
#define VTIME    5
#define VMIN     6
#define VSWTC    7
#define VSTART   8
#define VSTOP    9
#define VSUSP   10
#define VEOL    11
#define VREPRINT 12
#define VDISCARD 13
#define VWERASE 14
#define VLNEXT  15
#define VEOL2   16

/* c_iflag bits */
#define IGNBRK  0000001
#define BRKINT  0000002
#define IGNPAR  0000004
#define PARMRK  0000010
#define INPCK   0000020
#define ISTRIP  0000040
#define INLCR   0000100
#define IGNCR   0000200
#define ICRNL   0000400
#define IUCLC   0001000
#define IXON    0002000
#define IXANY   0004000
#define IXOFF   0010000
#define IMAXBEL 0020000
#define IUTF8   0040000

/* c_oflag bits */
#define OPOST   0000001
#define OLCUC   0000002
#define ONLCR   0000004
#define OCRNL   0000010
#define ONOCR   0000020
#define ONLRET  0000040
#define OFILL   0000100
#define OFDEL   0000200
#define NLDLY   0000400
#define NL0     0000000
#define NL1     0000400
#define CRDLY   0003000
#define CR0     0000000
#define CR1     0001000
#define CR2     0002000
#define CR3     0003000
#define TABDLY  0014000
#define TAB0    0000000
#define TAB1    0004000
#define TAB2    0010000
#define TAB3    0014000
#define BSDLY   0020000
#define BS0     0000000
#define BS1     0020000
#define FFDLY   0100000
#define FF0     0000000
#define FF1     0100000
#define VTDLY   0040000
#define VT0     0000000
#define VT1     0040000

/* baud rates */
#define B0       0000000
#define B50      0000001
#define B75      0000002
#define B110     0000003
#define B134     0000004
#define B150     0000005
#define B200     0000006
#define B300     0000007
#define B600     0000010
#define B1200    0000011
#define B1800    0000012
#define B2400    0000013
#define B4800    0000014
#define B9600    0000015
#define B19200   0000016
#define B38400   0000017
#define B57600   0010001
#define B115200  0010002
#define B230400  0010003

/* c_cflag bits */
#define CSIZE   0000060
#define CS5     0000000
#define CS6     0000020
#define CS7     0000040
#define CS8     0000060
#define CSTOPB  0000100
#define CREAD   0000200
#define PARENB  0000400
#define PARODD  0001000
#define HUPCL   0002000
#define CLOCAL  0004000

/* c_lflag bits */
#define ISIG    0000001
#define ICANON  0000002
#define XCASE   0000004
#define ECHO    0000010
#define ECHOE   0000020
#define ECHOK   0000040
#define ECHONL  0000100
#define NOFLSH  0000200
#define TOSTOP  0000400
#define ECHOCTL 0001000
#define ECHOPRT 0002000
#define ECHOKE  0004000
#define FLUSHO  0010000
#define PENDIN  0040000
#define IEXTEN  0100000
#define EXTPROC 0200000

/* tcsetattr() actions */
#define TCSANOW   0
#define TCSADRAIN 1
#define TCSAFLUSH 2

/* tcflush() queue selectors */
#define TCIFLUSH  0
#define TCOFLUSH  1
#define TCIOFLUSH 2

/* tcflow() actions */
#define TCOOFF 0
#define TCOON  1
#define TCIOFF 2
#define TCION  3

int tcgetattr(int, struct termios *);
int tcsetattr(int, int, const struct termios *);
int tcsendbreak(int, int);
int tcdrain(int);
int tcflush(int, int);
int tcflow(int, int);
void cfmakeraw(struct termios *);
speed_t cfgetispeed(const struct termios *);
speed_t cfgetospeed(const struct termios *);
int cfsetispeed(struct termios *, speed_t);
int cfsetospeed(struct termios *, speed_t);

#ifdef __cplusplus
}
#endif

#endif /* _WASI_SHIM_TERMIOS_H */
