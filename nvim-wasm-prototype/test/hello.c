/* Rung-1 smoke test for the wasm32-wasi toolchain: print a line and exit 0. */
#include <stdio.h>

int main(void) {
    printf("hello wasi\n");
    return 0;
}
