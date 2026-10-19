/* Privileged Linux regression for the production namespace helper. Same-App
 * Services and Jobs keep their localhost network while UI execution is replaced
 * sequentially. There are no socket-routing hooks or private listener aliases. */
#define main net_helper_main
#include "net-helper.c"
#undef main
#include <sys/wait.h>

static const char *network_a = NETNS_PREFIX "n-11111111111111111111111111111111";
static const char *old_ui = NETNS_PREFIX "a-22222222222222222222222222222222";
static const char *replacement = NETNS_PREFIX "a-33333333333333333333333333333333";
static const char *service = NETNS_PREFIX "a-44444444444444444444444444444444";
static const char *job = NETNS_PREFIX "a-55555555555555555555555555555555";
static const char *network_b = NETNS_PREFIX "n-66666666666666666666666666666666";
static pid_t children[8];
static size_t child_count;
static int original_network = -1;

static void check(int ok, const char *reason) {
  if (!ok) { perror(reason); exit(1); }
}

static pid_t server(int port, char marker) {
  int ready[2];
  check(pipe(ready) == 0, "pipe");
  pid_t pid = fork();
  check(pid >= 0, "fork server");
  if (!pid) {
    alarm(5);
    close(ready[0]);
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) _exit(101);
    struct sockaddr_in address = {
      .sin_family = AF_INET, .sin_port = htons((uint16_t)port),
      .sin_addr = { .s_addr = htonl(INADDR_LOOPBACK) },
    };
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 || listen(listener, 16) != 0) _exit(102);
    if (write(ready[1], "R", 1) != 1) _exit(103);
    close(ready[1]);
    alarm(0);
    for (;;) {
      int connection = accept(listener, NULL, NULL);
      if (connection < 0) _exit(104);
      if (write(connection, &marker, 1) != 1) _exit(105);
      close(connection);
    }
  }
  children[child_count++] = pid;
  close(ready[1]);
  char status = 0;
  ssize_t bytes = read(ready[0], &status, 1);
  close(ready[0]);
  check(bytes == 1 && status == 'R', "server readiness");
  return pid;
}

static void request(int port, char expected) {
  pid_t pid = fork();
  check(pid >= 0, "fork client");
  if (!pid) {
    alarm(5);
    int fd = connect_loopback(port);
    if (fd < 0) _exit(110);
    char value = 0;
    ssize_t count = read(fd, &value, 1);
    close(fd);
    _exit(count == 1 && value == expected ? 0 : 111);
  }
  int status;
  check(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0, "private localhost communication");
}

static void stop_child(pid_t pid) {
  check(kill(pid, SIGKILL) == 0, "stop process tree fixture");
  check(waitpid(pid, NULL, 0) == pid, "confirm stopped process");
  for (size_t i = 0; i < child_count; i++) if (children[i] == pid) children[i] = 0;
}

static void cleanup(void) {
  for (size_t i = 0; i < child_count; i++) {
    if (children[i]) { kill(children[i], SIGKILL); waitpid(children[i], NULL, 0); }
  }
  if (original_network >= 0) { setns(original_network, CLONE_NEWNET); close(original_network); }
  delete_namespace(old_ui);
  delete_namespace(replacement);
  delete_namespace(service);
  delete_namespace(job);
  delete_namespace(network_a);
  delete_namespace(network_b);
}

int main(void) {
  check(geteuid() == 0, "root required");
  original_network = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  check(original_network >= 0, "original namespace");
  check(atexit(cleanup) == 0, "cleanup registration");
  check(create_namespace(network_a) == 0, "App A private network");
  check(share_namespace(service, network_a) == 0 && share_namespace(job, network_a) == 0, "sibling network leases");
  check(share_namespace(old_ui, network_a) == 0 && share_namespace(replacement, network_a) == 0, "handoff network lease");
  pid_t service_pid = server(43101, 'S');
  pid_t job_pid = server(43103, 'J');
  pid_t old_pid = server(43102, 'O');
  request(43101, 'S'); request(43102, 'O'); request(43103, 'J');
  /* The replacement root/network is prepared, but its process starts only
   * after the old process has been killed and reaped. Both use the same port. */
  stop_child(old_pid);
  check(delete_namespace(old_ui) == 0, "retire old aggregate lease");
  check(enter_namespace(replacement) == 0, "replacement network");
  pid_t new_pid = server(43102, 'N');
  request(43101, 'S'); request(43102, 'N'); request(43103, 'J');
  /* Failed replacement leaves UI unavailable, without restarting either
   * sibling or automatically executing the old UI again. */
  stop_child(new_pid);
  int unavailable = connect_loopback(43102);
  check(unavailable < 0, "failed UI remains unavailable");
  request(43101, 'S'); request(43103, 'J');
  check(delete_namespace(replacement) == 0, "release failed replacement lease");
  check(enter_namespace(service) == 0, "Service keeps App network alive");
  request(43101, 'S'); request(43103, 'J');
  check(create_namespace(network_b) == 0, "App B isolated network");
  server(43101, 'B'); server(43103, 'b');
  request(43101, 'B'); request(43103, 'b');
  check(enter_namespace(job) == 0, "return to App A");
  request(43101, 'S'); request(43103, 'J');
  stop_child(service_pid);
  check(delete_namespace(service) == 0, "release Service aggregate");
  request(43103, 'J');
  stop_child(job_pid);
  check(delete_namespace(job) == 0 && delete_namespace(network_a) == 0, "release final network owner");
  puts("Sequential UI replacement, ordinary localhost, independent siblings and cross-App isolation passed");
  return 0;
}
