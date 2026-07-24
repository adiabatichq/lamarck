#define _GNU_SOURCE
#include <sys/wait.h>

#define main lamarck_net_helper_main
#include "net-helper.c"
#undef main

static struct timespec deadline_after(long milliseconds) {
  struct timespec deadline;
  if (clock_gettime(CLOCK_MONOTONIC, &deadline) != 0) _exit(90);
  deadline.tv_sec += milliseconds / 1000;
  deadline.tv_nsec += (milliseconds % 1000) * 1000000;
  if (deadline.tv_nsec >= 1000000000) {
    deadline.tv_sec += 1;
    deadline.tv_nsec -= 1000000000;
  }
  return deadline;
}

static int open_http_listener(int *port) {
  int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listener < 0) return -1;
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = 0;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0
      || listen(listener, 4) != 0) {
    close(listener);
    return -1;
  }
  socklen_t address_bytes = sizeof(address);
  if (getsockname(listener, (struct sockaddr *)&address, &address_bytes) != 0) {
    close(listener);
    return -1;
  }
  *port = ntohs(address.sin_port);
  return listener;
}

static int read_http_request(int fd) {
  unsigned char request[1024];
  size_t length = 0;
  while (length < sizeof(request)) {
    ssize_t received = read(fd, request + length, sizeof(request) - length);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) return -1;
    length += (size_t)received;
    for (size_t index = 3; index < length; index++) {
      if (request[index - 3] == '\r'
          && request[index - 2] == '\n'
          && request[index - 1] == '\r'
          && request[index] == '\n') {
        return 0;
      }
    }
  }
  return -1;
}

static int accept_http_request(int listener) {
  int client;
  do client = accept4(listener, NULL, NULL, SOCK_CLOEXEC); while (client < 0 && errno == EINTR);
  if (client < 0) return -1;
  if (read_http_request(client) != 0) {
    close(client);
    return -1;
  }
  return client;
}

static int child_exited_successfully(pid_t child) {
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 0;
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

int main(void) {
  static const unsigned char ready[] =
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n";
  static const unsigned char no_reason[] = "HTTP/1.0 204\r\n\r\n";
  static const unsigned char partial[] = "HTTP/1.1 200 OK\r\n";
  static const unsigned char warming[] = "HTTP/1.1 503 Service Unavailable\r\n\r\n";
  static const unsigned char gateway[] = "HTTP/1.1 502 Bad Gateway\r\n\r\n";
  static const unsigned char redirect[] = "HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n";
  static const unsigned char missing[] = "HTTP/1.1 404 Not Found\r\n\r\n";
  static const unsigned char malformed[] = "NOT-HTTP 200 OK\r\n\r\n";
  static const unsigned char nul_header[] = {
    'H','T','T','P','/','1','.','1',' ','2','0','0',' ','O','K','\r','\n',
    'X',':',' ','a','\0','b','\r','\n','\r','\n',
  };

  if (classify_viewer_http_response(ready, sizeof(ready) - 1) != VIEWER_HTTP_READY) return 1;
  if (classify_viewer_http_response(no_reason, sizeof(no_reason) - 1) != VIEWER_HTTP_READY) return 2;
  if (classify_viewer_http_response(partial, sizeof(partial) - 1) != VIEWER_HTTP_INCOMPLETE) return 3;
  if (classify_viewer_http_response(warming, sizeof(warming) - 1) != VIEWER_HTTP_RETRY) return 4;
  if (classify_viewer_http_response(gateway, sizeof(gateway) - 1) != VIEWER_HTTP_RETRY) return 5;
  if (classify_viewer_http_response(redirect, sizeof(redirect) - 1) != VIEWER_HTTP_REJECT) return 6;
  if (classify_viewer_http_response(missing, sizeof(missing) - 1) != VIEWER_HTTP_REJECT) return 7;
  if (classify_viewer_http_response(malformed, sizeof(malformed) - 1) != VIEWER_HTTP_REJECT) return 8;
  if (classify_viewer_http_response(nul_header, sizeof(nul_header)) != VIEWER_HTTP_REJECT) return 9;

  int sockets[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return 10;
  signal(SIGPIPE, SIG_IGN);
  close(sockets[1]);
  static const unsigned char request[] = "GET / HTTP/1.1\r\n\r\n";
  if (write_all(sockets[0], request, sizeof(request) - 1) == 0) return 11;
  close(sockets[0]);

  int retry_port = 0;
  int retry_listener = open_http_listener(&retry_port);
  if (retry_listener < 0) return 12;
  pid_t retry_server = fork();
  if (retry_server < 0) return 13;
  if (retry_server == 0) {
    int first = accept_http_request(retry_listener);
    if (first < 0
        || write_all(first, warming, sizeof(warming) - 1) != 0) {
      _exit(1);
    }
    close(first);
    int second = accept_http_request(retry_listener);
    if (second < 0
        || write_all(second, partial, sizeof(partial) - 1) != 0) {
      _exit(2);
    }
    struct timespec fragment_delay = { .tv_sec = 0, .tv_nsec = 10 * 1000000 };
    nanosleep(&fragment_delay, NULL);
    static const unsigned char header_end[] = "\r\n";
    if (write_all(second, header_end, sizeof(header_end) - 1) != 0) _exit(3);
    close(second);
    close(retry_listener);
    _exit(0);
  }
  struct timespec retry_deadline = deadline_after(1000);
  int retry_result = probe_loopback_port(retry_port, &retry_deadline);
  close(retry_listener);
  if (!child_exited_successfully(retry_server)) return 14;
  if (retry_result != 0) return 15;

  int stalled_port = 0;
  int stalled_listener = open_http_listener(&stalled_port);
  if (stalled_listener < 0) return 16;
  pid_t stalled_server = fork();
  if (stalled_server < 0) return 17;
  if (stalled_server == 0) {
    int client = accept_http_request(stalled_listener);
    if (client < 0) _exit(1);
    struct timespec stall = { .tv_sec = 0, .tv_nsec = 300 * 1000000 };
    nanosleep(&stall, NULL);
    close(client);
    close(stalled_listener);
    _exit(0);
  }
  struct timespec started;
  if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) return 18;
  struct timespec stalled_deadline = deadline_after(80);
  int stalled_result = probe_loopback_port(stalled_port, &stalled_deadline);
  struct timespec finished;
  if (clock_gettime(CLOCK_MONOTONIC, &finished) != 0) return 19;
  close(stalled_listener);
  if (!child_exited_successfully(stalled_server)) return 20;
  int64_t elapsed_ms = ((int64_t)finished.tv_sec - (int64_t)started.tv_sec) * 1000
      + ((int64_t)finished.tv_nsec - (int64_t)started.tv_nsec) / 1000000;
  if (stalled_result != 2) return 21;
  if (elapsed_ms < 40 || elapsed_ms > 250) return 22;
  return 0;
}
