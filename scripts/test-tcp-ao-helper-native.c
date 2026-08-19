// SPDX-License-Identifier: MIT
/* Native Linux integration driver for scripts/test-tcp-ao-helper.sh. */

#define main netnexus_tcp_ao_helper_program_main
#include "tcp-ao-helper.c"
#undef main

#include <sys/stat.h>
#include <sys/wait.h>

static const unsigned char sha_key[] = "netnexus-native-test-key";
static const unsigned char sha_wrong_key[] = "netnexus-native-wrongkey";
static const unsigned char cmac_key[] = "0123456789abcdef";
static const unsigned char cmac_wrong_key[] = "fedcba9876543210";
static const unsigned char rotation_key_one[] = "netnexus-rotation-key-one";
static const unsigned char rotation_key_two[] = "netnexus-rotation-key-two";

static bool parse_test_family(const char *value, int *family) {
    if (strcmp(value, "4") == 0) {
        *family = AF_INET;
        return true;
    }
    if (strcmp(value, "6") == 0) {
        *family = AF_INET6;
        return true;
    }
    return false;
}

static void initialize_loopback_profile(ao_profile_config *profile, int family) {
    memset(profile, 0, sizeof(*profile));
    profile->family = family;
    profile->prefix = family == AF_INET ? 32U : 128U;
    if (family == AF_INET) {
        if (inet_pton(AF_INET, "127.0.0.1", &profile->address.v4) != 1) abort();
    } else if (inet_pton(AF_INET6, "::1", &profile->address.v6) != 1) {
        abort();
    }
}

static bool initialize_test_key(ao_key_config *key, const char *algorithm, uint8_t key_id, bool wrong) {
    const unsigned char *material;
    size_t material_length;
    memset(key, 0, sizeof(*key));
    key->snd_id = key_id;
    key->rcv_id = key_id;
    key->mac_length = 12U;

    if (strcmp(algorithm, "cmac(aes128)") == 0) {
        material = wrong ? cmac_wrong_key : cmac_key;
        material_length = sizeof(cmac_key) - 1U;
    } else if (strcmp(algorithm, "hmac(sha1)") == 0 || strcmp(algorithm, "hmac(sha256)") == 0) {
        material = wrong ? sha_wrong_key : sha_key;
        material_length = sizeof(sha_key) - 1U;
    } else {
        return false;
    }
    strcpy(key->algorithm, algorithm);
    key->key_length = (uint8_t)material_length;
    memcpy(key->key, material, material_length);
    return true;
}

static int connect_with_timeout(int socket_fd, const ao_profile_config *profile, uint16_t port,
                                int timeout_ms) {
    struct pollfd descriptor = {.fd = socket_fd, .events = POLLOUT};
    int original_flags = fcntl(socket_fd, F_GETFL, 0);
    int result;
    if (original_flags < 0 || fcntl(socket_fd, F_SETFL, original_flags | O_NONBLOCK) < 0) return -1;

    if (profile->family == AF_INET) {
        struct sockaddr_in address;
        memset(&address, 0, sizeof(address));
        address.sin_family = AF_INET;
        address.sin_port = htons(port);
        address.sin_addr = profile->address.v4;
        result = connect(socket_fd, (struct sockaddr *)&address, sizeof(address));
    } else {
        struct sockaddr_in6 address;
        memset(&address, 0, sizeof(address));
        address.sin6_family = AF_INET6;
        address.sin6_port = htons(port);
        address.sin6_addr = profile->address.v6;
        result = connect(socket_fd, (struct sockaddr *)&address, sizeof(address));
    }
    if (result == 0) goto connected;
    if (errno != EINPROGRESS) return -1;

    do {
        result = poll(&descriptor, 1, timeout_ms);
    } while (result < 0 && errno == EINTR);
    if (result <= 0) {
        if (result == 0) errno = ETIMEDOUT;
        return -1;
    }
    int socket_error = 0;
    socklen_t error_length = sizeof(socket_error);
    if (getsockopt(socket_fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_length) < 0) return -1;
    if (socket_error != 0) {
        errno = socket_error;
        return -1;
    }

connected:
    if (fcntl(socket_fd, F_SETFL, original_flags) < 0) return -1;
    return 0;
}

static bool receive_exact(int socket_fd, unsigned char *buffer, size_t length) {
    size_t offset = 0U;
    while (offset < length) {
        const ssize_t count = recv(socket_fd, buffer + offset, length - offset, 0);
        if (count > 0) {
            offset += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        return false;
    }
    return true;
}

static bool round_trip(int socket_fd, uint32_t sequence) {
    unsigned char sent[8] = {'N', 'N', 'A', 'O', 0, 0, 0, 0};
    unsigned char received[sizeof(sent)];
    sent[4] = (unsigned char)(sequence >> 24U);
    sent[5] = (unsigned char)(sequence >> 16U);
    sent[6] = (unsigned char)(sequence >> 8U);
    sent[7] = (unsigned char)sequence;
    return send_all(socket_fd, sent, sizeof(sent)) && receive_exact(socket_fd, received, sizeof(received)) &&
           memcmp(sent, received, sizeof(sent)) == 0;
}

static int run_echo_server(uint16_t port) {
    struct sockaddr_in address;
    int enabled = 1;
    int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (listener < 0) return EXIT_FAILURE;
    if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) < 0) return EXIT_FAILURE;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0 || listen(listener, 16) < 0) {
        return EXIT_FAILURE;
    }
    socklen_t address_length = sizeof(address);
    if (getsockname(listener, (struct sockaddr *)&address, &address_length) < 0) return EXIT_FAILURE;
    printf("echo-ready %u\n", (unsigned int)ntohs(address.sin_port));
    fflush(stdout);

    while (true) {
        int client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
        if (client < 0) {
            if (errno == EINTR) continue;
            return EXIT_FAILURE;
        }
        while (true) {
            unsigned char buffer[4096];
            const ssize_t count = recv(client, buffer, sizeof(buffer), 0);
            if (count == 0) break;
            if (count < 0) {
                if (errno == EINTR) continue;
                break;
            }
            if (!send_all(client, buffer, (size_t)count)) break;
        }
        close(client);
    }
}

static int pick_unused_loopback_port(void) {
    struct sockaddr_in address;
    int socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (socket_fd < 0) return EXIT_FAILURE;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        close(socket_fd);
        return EXIT_FAILURE;
    }
    socklen_t address_length = sizeof(address);
    if (getsockname(socket_fd, (struct sockaddr *)&address, &address_length) < 0) {
        close(socket_fd);
        return EXIT_FAILURE;
    }
    printf("%u\n", (unsigned int)ntohs(address.sin_port));
    close(socket_fd);
    return EXIT_SUCCESS;
}

static int run_algorithm_probe(void) {
    static const char *const algorithms[] = {"hmac(sha1)", "cmac(aes128)", "hmac(sha256)"};
    ao_profile_config profile;
    initialize_loopback_profile(&profile, AF_INET);
    for (size_t index = 0; index < sizeof(algorithms) / sizeof(algorithms[0]); index++) {
        ao_key_config key;
        int socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
        if (socket_fd < 0 || !initialize_test_key(&key, algorithms[index], 1U, false) ||
            install_ao_key(socket_fd, &profile, &key) < 0) {
            fprintf(stderr, "algorithm probe failed for %s: %s\n", algorithms[index], strerror(errno));
            if (socket_fd >= 0) close(socket_fd);
            return EXIT_FAILURE;
        }
        close(socket_fd);
    }
    puts("algorithm-probe-ok");
    return EXIT_SUCCESS;
}

static int run_connection_test(uint16_t port, const char *mode, const char *algorithm, int family) {
    const bool use_ao = strcmp(mode, "none") != 0;
    const bool expect_success = strcmp(mode, "correct") == 0;
    const bool wrong = strcmp(mode, "wrong") == 0;
    ao_profile_config profile;
    ao_key_config key;
    int socket_fd;

    if (!expect_success && !wrong && strcmp(mode, "none") != 0) return EXIT_FAILURE;
    initialize_loopback_profile(&profile, family);
    socket_fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (socket_fd < 0) return EXIT_FAILURE;
    if (use_ao && (!initialize_test_key(&key, algorithm, 1U, wrong) ||
                   install_ao_key(socket_fd, &profile, &key) < 0 ||
                   set_socket_current_key(socket_fd, &key) < 0)) {
        fprintf(stderr, "client TCP-AO setup failed: %s\n", strerror(errno));
        close(socket_fd);
        return EXIT_FAILURE;
    }

    const int connect_result = connect_with_timeout(socket_fd, &profile, port, 1800);
    if (!expect_success) {
        close(socket_fd);
        if (connect_result == 0) {
            fprintf(stderr, "%s client unexpectedly connected\n", mode);
            return EXIT_FAILURE;
        }
        printf("%s-key-rejected-ok\n", mode);
        return EXIT_SUCCESS;
    }
    if (connect_result < 0 || !round_trip(socket_fd, 1U)) {
        fprintf(stderr, "authenticated round trip failed: %s\n", strerror(errno));
        close(socket_fd);
        return EXIT_FAILURE;
    }
    close(socket_fd);
    puts("authenticated-round-trip-ok");
    return EXIT_SUCCESS;
}

static int run_rotation_test(uint16_t port, uint64_t switch_epoch) {
    ao_profile_config profile;
    ao_key_config first;
    ao_key_config second;
    int socket_fd;
    uint32_t sequence = 1U;
    bool switched = false;
    bool deleted = false;

    initialize_loopback_profile(&profile, AF_INET);
    if (!initialize_test_key(&first, "hmac(sha1)", 1U, false) ||
        !initialize_test_key(&second, "hmac(sha1)", 2U, false)) {
        return EXIT_FAILURE;
    }
    first.key_length = (uint8_t)(sizeof(rotation_key_one) - 1U);
    memcpy(first.key, rotation_key_one, sizeof(rotation_key_one) - 1U);
    second.key_length = (uint8_t)(sizeof(rotation_key_two) - 1U);
    memcpy(second.key, rotation_key_two, sizeof(rotation_key_two) - 1U);

    socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (socket_fd < 0 || install_ao_key(socket_fd, &profile, &first) < 0 ||
        install_ao_key(socket_fd, &profile, &second) < 0 || set_socket_current_key(socket_fd, &first) < 0 ||
        connect_with_timeout(socket_fd, &profile, port, 3000) < 0) {
        fprintf(stderr, "rotation client setup failed: %s\n", strerror(errno));
        if (socket_fd >= 0) close(socket_fd);
        return EXIT_FAILURE;
    }

    while (true) {
        const time_t now_time = time(NULL);
        if (now_time < 0) return EXIT_FAILURE;
        const uint64_t now = (uint64_t)now_time;
        if (!switched && now >= switch_epoch) {
            if (set_socket_current_key(socket_fd, &second) < 0) return EXIT_FAILURE;
            switched = true;
        }
        if (!deleted && now >= switch_epoch + 2U) {
            if (delete_ao_key(socket_fd, &profile, &first, false) < 0) return EXIT_FAILURE;
            deleted = true;
        }
        if (!round_trip(socket_fd, sequence++)) {
            fprintf(stderr, "rotation round trip failed: %s\n", strerror(errno));
            close(socket_fd);
            return EXIT_FAILURE;
        }
        if (now >= switch_epoch + 3U) break;
        const struct timespec pause = {.tv_sec = 0, .tv_nsec = 100000000L};
        (void)nanosleep(&pause, NULL);
    }
    close(socket_fd);
    puts("live-rotation-ok");
    return EXIT_SUCCESS;
}

static int run_rotation_connection_test(uint16_t port, uint8_t key_id, bool expect_success) {
    ao_profile_config profile;
    ao_key_config key;
    int socket_fd;
    initialize_loopback_profile(&profile, AF_INET);
    if (!initialize_test_key(&key, "hmac(sha1)", key_id, false)) return EXIT_FAILURE;
    if (key_id == 1U) {
        key.key_length = (uint8_t)(sizeof(rotation_key_one) - 1U);
        memcpy(key.key, rotation_key_one, sizeof(rotation_key_one) - 1U);
    } else if (key_id == 2U) {
        key.key_length = (uint8_t)(sizeof(rotation_key_two) - 1U);
        memcpy(key.key, rotation_key_two, sizeof(rotation_key_two) - 1U);
    } else {
        return EXIT_FAILURE;
    }
    socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (socket_fd < 0 || install_ao_key(socket_fd, &profile, &key) < 0 ||
        set_socket_current_key(socket_fd, &key) < 0) {
        if (socket_fd >= 0) close(socket_fd);
        return EXIT_FAILURE;
    }
    const int result = connect_with_timeout(socket_fd, &profile, port, 1800);
    if (expect_success) {
        const bool ok = result == 0 && round_trip(socket_fd, 1U);
        close(socket_fd);
        if (!ok) return EXIT_FAILURE;
        puts("rotation-new-key-connect-ok");
        return EXIT_SUCCESS;
    }
    close(socket_fd);
    if (result == 0) return EXIT_FAILURE;
    puts("rotation-expired-key-rejected-ok");
    return EXIT_SUCCESS;
}

static int run_clock_guard_test(void) {
    uint64_t last = 1000U;
    if (!advance_wall_clock(&last, 1000U) || !advance_wall_clock(&last, 1001U) || last != 1001U ||
        advance_wall_clock(&last, 1000U) || last != 1001U) {
        return EXIT_FAILURE;
    }
    puts("clock-rollback-fail-closed-ok");
    return EXIT_SUCCESS;
}

static uint16_t decode_uint16_be(const unsigned char *input) {
    uint16_t encoded;
    memcpy(&encoded, input, sizeof(encoded));
    return ntohs(encoded);
}

static bool decode_capability_argument(const char *encoded,
                                       unsigned char capability[FORWARD_CAPABILITY_BYTES]) {
    if (encoded == NULL || strlen(encoded) != FORWARD_CAPABILITY_BYTES * 2U) return false;
    for (size_t index = 0; index < FORWARD_CAPABILITY_BYTES; index++) {
        const int high = hex_value(encoded[index * 2U]);
        const int low = hex_value(encoded[index * 2U + 1U]);
        if (high < 0 || low < 0) {
            secure_zero(capability, FORWARD_CAPABILITY_BYTES);
            return false;
        }
        capability[index] = (unsigned char)(((unsigned int)high << 4U) | (unsigned int)low);
    }
    return true;
}

static bool validate_forward_header(const unsigned char header[FORWARD_PEER_HEADER_BYTES], int family,
                                    uint16_t public_port,
                                    const unsigned char capability[FORWARD_CAPABILITY_BYTES]) {
    static const unsigned char ipv4_loopback[4] = {127U, 0U, 0U, 1U};
    static const unsigned char ipv6_loopback[16] = {0U, 0U, 0U, 0U, 0U, 0U, 0U, 0U,
                                                    0U, 0U, 0U, 0U, 0U, 0U, 0U, 1U};
    if (memcmp(header, "NNAO", 4U) != 0 || header[4] != FORWARD_PEER_HEADER_VERSION ||
        header[5] != (family == AF_INET ? 4U : 6U) ||
        decode_uint16_be(header + 6U) != FORWARD_PEER_HEADER_BYTES ||
        decode_uint16_be(header + 8U) == 0U || decode_uint16_be(header + 10U) != public_port ||
        header[12] != 0U || header[13] != 0U || header[14] != 0U || header[15] != 0U ||
        memcmp(header + 48U, capability, FORWARD_CAPABILITY_BYTES) != 0) {
        return false;
    }
    if (family == AF_INET) {
        static const unsigned char zero_padding[12] = {0};
        return memcmp(header + 16U, zero_padding, sizeof(zero_padding)) == 0 &&
               memcmp(header + 28U, ipv4_loopback, sizeof(ipv4_loopback)) == 0 &&
               memcmp(header + 32U, zero_padding, sizeof(zero_padding)) == 0 &&
               memcmp(header + 44U, ipv4_loopback, sizeof(ipv4_loopback)) == 0;
    }
    return memcmp(header + 16U, ipv6_loopback, sizeof(ipv6_loopback)) == 0 &&
           memcmp(header + 32U, ipv6_loopback, sizeof(ipv6_loopback)) == 0;
}

static int run_unix_forward_echo(const char *socket_path, const char *encoded_capability, int family,
                                 uint16_t public_port) {
    struct sockaddr_un address;
    unsigned char capability[FORWARD_CAPABILITY_BYTES] = {0};
    unsigned char header[FORWARD_PEER_HEADER_BYTES] = {0};
    const size_t path_length = socket_path == NULL ? 0U : strlen(socket_path);
    int listener = -1;
    int client = -1;
    int result = EXIT_FAILURE;

    if (path_length == 0U || path_length >= sizeof(address.sun_path) || socket_path[0] != '/' ||
        !decode_capability_argument(encoded_capability, capability)) {
        goto cleanup;
    }
    listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener < 0) goto cleanup;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_path, path_length + 1U);
    const socklen_t address_length =
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_length + 1U);
    if (bind(listener, (struct sockaddr *)&address, address_length) < 0 || chmod(socket_path, 0600) < 0 ||
        listen(listener, 4) < 0) {
        goto cleanup;
    }
    puts("unix-echo-ready");
    fflush(stdout);

    do {
        client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    } while (client < 0 && errno == EINTR);
    if (client < 0 || !receive_exact(client, header, sizeof(header)) ||
        !validate_forward_header(header, family, public_port, capability)) {
        goto cleanup;
    }
    while (true) {
        unsigned char buffer[4096];
        const ssize_t count = recv(client, buffer, sizeof(buffer), 0);
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            goto cleanup;
        }
        if (!send_all(client, buffer, (size_t)count)) goto cleanup;
    }
    printf("unix-forward-metadata-ok-%d\n", family == AF_INET ? 4 : 6);
    result = EXIT_SUCCESS;

cleanup:
    if (client >= 0) close(client);
    if (listener >= 0) close(listener);
    if (path_length > 0U && path_length < sizeof(address.sun_path)) (void)unlink(socket_path);
    secure_zero(header, sizeof(header));
    secure_zero(capability, sizeof(capability));
    return result;
}

static int run_unix_forward_supervisor(const char *helper_path, const char *socket_path,
                                       const char *encoded_capability, int family,
                                       uint16_t public_port, uint16_t listen_port) {
    struct sockaddr_un address;
    unsigned char capability[FORWARD_CAPABILITY_BYTES] = {0};
    unsigned char header[FORWARD_PEER_HEADER_BYTES] = {0};
    const size_t path_length = socket_path == NULL ? 0U : strlen(socket_path);
    pid_t helper_pid = -1;
    int listener = -1;
    int client = -1;
    int result = EXIT_FAILURE;

    if (helper_path == NULL || helper_path[0] != '/' || path_length == 0U ||
        path_length >= sizeof(address.sun_path) || socket_path[0] != '/' ||
        !decode_capability_argument(encoded_capability, capability)) {
        goto cleanup;
    }
    listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener < 0) goto cleanup;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_path, path_length + 1U);
    const socklen_t address_length =
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_length + 1U);
    if (bind(listener, (struct sockaddr *)&address, address_length) < 0 || chmod(socket_path, 0600) < 0 ||
        listen(listener, 4) < 0) {
        goto cleanup;
    }

    helper_pid = fork();
    if (helper_pid < 0) goto cleanup;
    if (helper_pid == 0) {
        char parent_pid_text[32];
        char listen_port_text[16];
        if (snprintf(parent_pid_text, sizeof(parent_pid_text), "%ld", (long)getppid()) < 0 ||
            snprintf(listen_port_text, sizeof(listen_port_text), "%u", (unsigned int)listen_port) < 0) {
            _exit(126);
        }
        execl(helper_path, helper_path, "--parent-pid", parent_pid_text, "--listen-port",
              listen_port_text, "--forward-socket", socket_path, "--max-clients", "32", "--backlog",
              "32", (char *)NULL);
        _exit(127);
    }

    puts("unix-supervisor-ready");
    fflush(stdout);
    do {
        client = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    } while (client < 0 && errno == EINTR);
    if (client < 0 || !receive_exact(client, header, sizeof(header)) ||
        !validate_forward_header(header, family, public_port, capability)) {
        goto cleanup;
    }
    while (true) {
        unsigned char buffer[4096];
        const ssize_t count = recv(client, buffer, sizeof(buffer), 0);
        if (count == 0) break;
        if (count < 0) {
            if (errno == EINTR) continue;
            goto cleanup;
        }
        if (!send_all(client, buffer, (size_t)count)) goto cleanup;
    }
    printf("unix-forward-metadata-ok-%d\n", family == AF_INET ? 4 : 6);
    fflush(stdout);
    result = EXIT_SUCCESS;

cleanup:
    if (client >= 0) close(client);
    if (listener >= 0) close(listener);
    if (helper_pid > 0) {
        int helper_status = 0;
        (void)kill(helper_pid, SIGTERM);
        while (waitpid(helper_pid, &helper_status, 0) < 0 && errno == EINTR) {
        }
        if (!WIFEXITED(helper_status) || WEXITSTATUS(helper_status) != EXIT_SUCCESS) {
            result = EXIT_FAILURE;
        }
    }
    if (path_length > 0U && path_length < sizeof(address.sun_path)) (void)unlink(socket_path);
    secure_zero(header, sizeof(header));
    secure_zero(capability, sizeof(capability));
    return result;
}

int main(int argc, char **argv) {
    uint16_t port;
    if (argc == 2 && strcmp(argv[1], "probe-algorithms") == 0) return run_algorithm_probe();
    if (argc == 2 && strcmp(argv[1], "clock-guard") == 0) return run_clock_guard_test();
    if (argc == 2 && strcmp(argv[1], "pick-port") == 0) return pick_unused_loopback_port();
    if (argc == 2 && strcmp(argv[1], "echo-auto") == 0) return run_echo_server(0U);
    if (argc == 3 && strcmp(argv[1], "echo") == 0 && parse_port(argv[2], &port)) return run_echo_server(port);
    if (argc == 6 && strcmp(argv[1], "unix-echo") == 0 && parse_port(argv[5], &port)) {
        int family;
        if (!parse_test_family(argv[4], &family)) return EXIT_FAILURE;
        return run_unix_forward_echo(argv[2], argv[3], family, port);
    }
    if (argc == 8 && strcmp(argv[1], "unix-supervise") == 0 && parse_port(argv[6], &port)) {
        int family;
        uint16_t listen_port;
        if (!parse_test_family(argv[5], &family) || !parse_port(argv[7], &listen_port)) {
            return EXIT_FAILURE;
        }
        return run_unix_forward_supervisor(argv[2], argv[3], argv[4], family, port, listen_port);
    }
    if (argc == 6 && strcmp(argv[1], "connect") == 0 && parse_port(argv[2], &port)) {
        int family;
        if (!parse_test_family(argv[5], &family)) return EXIT_FAILURE;
        return run_connection_test(port, argv[3], argv[4], family);
    }
    if (argc == 4 && strcmp(argv[1], "rotate") == 0 && parse_port(argv[2], &port)) {
        char *end = NULL;
        errno = 0;
        const unsigned long long parsed = strtoull(argv[3], &end, 10);
        if (errno != 0 || end == argv[3] || *end != '\0') return EXIT_FAILURE;
        return run_rotation_test(port, (uint64_t)parsed);
    }
    if (argc == 5 && strcmp(argv[1], "rotation-connect") == 0 && parse_port(argv[2], &port)) {
        unsigned int key_id;
        if (!parse_bounded_unsigned(argv[3], 1U, 2U, &key_id) ||
            (strcmp(argv[4], "accept") != 0 && strcmp(argv[4], "reject") != 0)) {
            return EXIT_FAILURE;
        }
        return run_rotation_connection_test(port, (uint8_t)key_id, strcmp(argv[4], "accept") == 0);
    }
    fprintf(stderr,
            "usage: %s probe-algorithms|clock-guard|pick-port|echo-auto|echo PORT|"
            "unix-echo PATH CAPABILITY_HEX 4|6 PUBLIC_PORT|"
            "unix-supervise HELPER PATH CAPABILITY_HEX 4|6 PUBLIC_PORT LISTEN_PORT|"
            "connect PORT correct|wrong|none ALGORITHM 4|6|rotate PORT EPOCH|"
            "rotation-connect PORT 1|2 accept|reject\n",
            argv[0]);
    return EXIT_FAILURE;
}
