CC ?= cc
CFLAGS ?= -O2 -pipe
CPPFLAGS ?=
LDFLAGS ?=

all: lamarck-vsock-relay lamarck-net-helper

lamarck-vsock-relay: vsock-relay.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -Wall -Wextra -Werror -o $@ $< $(LDFLAGS)

lamarck-net-helper: net-helper.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -std=c11 -Wall -Wextra -Werror -o $@ $< $(LDFLAGS)

clean:
	rm -f lamarck-vsock-relay lamarck-net-helper

.PHONY: all clean
