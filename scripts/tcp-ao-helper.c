// SPDX-License-Identifier: MIT
/*
 * NetNexus TCP-AO sidecar for Linux 6.7+.
 *
 * The helper owns the public TCP-AO listening sockets and forwards accepted
 * streams to a private Unix-domain socket. Each stream starts with a fixed
 * authenticated peer-metadata header. Key material and the channel capability
 * are read exactly once from stdin; neither is accepted in argv or written to
 * stdout/stderr. --forward-port remains available only to the native test suite.
 *
 * Invocation:
 *   tcp-ao-helper --parent-pid 1234 --listen-port 8282 --forward-socket /run/user/1000/r.sock
 *
 * stdin JSON:
 *   {"schemaVersion":2,"forwardCapability":"<64 hexadecimal characters>","profiles":[
 *     {"peer":"192.0.2.1/32","keys":[
 *       {"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"secret",
 *        "acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}
 *     ]}
 *   ]}
 *
 * Supported algorithm spellings:
 *   hmac(sha1), hmac-sha-1, hmac(sha256), hmac-sha-256,
 *   cmac(aes), cmac(aes128), aes-128-cmac-96
 *
 * stdout contains exactly one machine-readable startup status line:
 *   {"status":"ready",...}
 * or
 *   {"status":"error",...}
 */

#define _GNU_SOURCE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <limits.h>
#include <linux/tcp.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#ifndef TCP_AO_ADD_KEY
#error "linux-libc-dev with TCP-AO UAPI definitions is required (Linux 6.7+)"
#endif

#ifndef TCP_AO_INFO
#error "linux-libc-dev with TCP_AO_INFO is required (Linux 6.7+)"
#endif

#define NETNEXUS_TCP_AO_HELPER_VERSION "1.2.0"
#define MAX_CONFIG_BYTES (1024U * 1024U)
#define MAX_KEYS_PER_PROFILE 16U
#define MAX_PROFILES 32U
#define MAX_KEYS (MAX_KEYS_PER_PROFILE * MAX_PROFILES)
#define MAX_CLIENTS_LIMIT 4096U
#define DEFAULT_MAX_CLIENTS 256U
#define DEFAULT_BACKLOG 128
#define COPY_BUFFER_SIZE (64U * 1024U)
#define MAX_TCP_AO_MAC_LENGTH 36U
#define ROTATION_INTERVAL_MS 1000
#define EXIT_TCP_AO_KEYS_EXPIRED 20
#define EXIT_TCP_AO_CLOCK_ROLLBACK 21
#define EXIT_TCP_AO_CLOCK_UNAVAILABLE 22
#define EXIT_TCP_AO_ROTATION_FAILED 23
#define FORWARD_CAPABILITY_BYTES 32U
#define FORWARD_PEER_HEADER_BYTES 80U
#define FORWARD_PEER_HEADER_VERSION 1U

typedef struct {
    char algorithm[64];
    uint8_t snd_id;
    uint8_t rcv_id;
    uint8_t mac_length;
    uint8_t key[TCP_AO_MAXKEYLEN];
    uint8_t key_length;
    bool current;
    bool current_explicit;
    uint64_t accept_start;
    uint64_t send_start;
    uint64_t send_end;
    uint64_t accept_end;
    bool installed_on_listener;
} ao_key_config;

typedef struct {
    int family;
    union {
        struct in_addr v4;
        struct in6_addr v6;
    } address;
    uint8_t prefix;
    size_t first_key;
    size_t key_count;
    ssize_t current_key_index;
} ao_profile_config;

typedef struct {
    ao_profile_config *profiles;
    size_t profile_count;
    ao_key_config *keys;
    size_t key_count;
    uint64_t validated_at;
    unsigned char forward_capability[FORWARD_CAPABILITY_BYTES];
    unsigned int schema_version;
    bool have_forward_capability;
} helper_config;

typedef struct {
    const char *cursor;
    const char *end;
    const char *error;
} json_parser;

typedef struct connection_ctx connection_ctx;

struct connection_ctx {
    int client_fd;
    int upstream_fd;
    uint16_t forward_port;
    char forward_socket[sizeof(((struct sockaddr_un *)0)->sun_path)];
    unsigned char forward_header[FORWARD_PEER_HEADER_BYTES];
    bool use_forward_socket;
    size_t profile_index;
    bool closing;
    connection_ctx *next;
};

typedef struct {
    pid_t expected_parent_pid;
    uint16_t listen_port;
    uint16_t forward_port;
    char forward_socket[sizeof(((struct sockaddr_un *)0)->sun_path)];
    bool use_forward_socket;
    unsigned int max_clients;
    int backlog;
} runtime_options;

static volatile sig_atomic_t keep_running = 1;
static pid_t bound_parent_pid = -1;
static uid_t bound_parent_uid = (uid_t)-1;
static int signal_pipe[2] = {-1, -1};
static pthread_mutex_t connection_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t connection_cond = PTHREAD_COND_INITIALIZER;
static connection_ctx *connections = NULL;
static unsigned int active_connections = 0;

static void secure_zero(void *memory, size_t length) {
    volatile unsigned char *bytes = (volatile unsigned char *)memory;
    while (length-- > 0) {
        *bytes++ = 0;
    }
}

static void emit_error_status(const char *code, const char *message) {
    /* code and message are fixed internal strings, never configuration data. */
    fprintf(stdout, "{\"status\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}\n", code, message);
    fflush(stdout);
}

static void skip_whitespace(json_parser *parser) {
    while (parser->cursor < parser->end) {
        const unsigned char value = (unsigned char)*parser->cursor;
        if (value != ' ' && value != '\t' && value != '\r' && value != '\n') {
            break;
        }
        parser->cursor++;
    }
}

static bool consume_character(json_parser *parser, char expected) {
    skip_whitespace(parser);
    if (parser->cursor >= parser->end || *parser->cursor != expected) {
        parser->error = "unexpected JSON token";
        return false;
    }
    parser->cursor++;
    return true;
}

static int hex_value(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static bool parse_hex_quad(json_parser *parser, uint32_t *codepoint) {
    uint32_t value = 0;
    if ((size_t)(parser->end - parser->cursor) < 4U) {
        parser->error = "truncated JSON unicode escape";
        return false;
    }
    for (unsigned int index = 0; index < 4U; index++) {
        const int digit = hex_value(parser->cursor[index]);
        if (digit < 0) {
            parser->error = "invalid JSON unicode escape";
            return false;
        }
        value = (value << 4U) | (uint32_t)digit;
    }
    parser->cursor += 4;
    *codepoint = value;
    return true;
}

static bool append_utf8(json_parser *parser, uint32_t codepoint, unsigned char *output, size_t capacity,
                        size_t *length) {
    unsigned char encoded[4];
    size_t encoded_length;

    if (codepoint <= 0x7fU) {
        encoded[0] = (unsigned char)codepoint;
        encoded_length = 1;
    } else if (codepoint <= 0x7ffU) {
        encoded[0] = (unsigned char)(0xc0U | (codepoint >> 6U));
        encoded[1] = (unsigned char)(0x80U | (codepoint & 0x3fU));
        encoded_length = 2;
    } else if (codepoint <= 0xffffU) {
        if (codepoint >= 0xd800U && codepoint <= 0xdfffU) {
            parser->error = "unpaired JSON unicode surrogate";
            return false;
        }
        encoded[0] = (unsigned char)(0xe0U | (codepoint >> 12U));
        encoded[1] = (unsigned char)(0x80U | ((codepoint >> 6U) & 0x3fU));
        encoded[2] = (unsigned char)(0x80U | (codepoint & 0x3fU));
        encoded_length = 3;
    } else if (codepoint <= 0x10ffffU) {
        encoded[0] = (unsigned char)(0xf0U | (codepoint >> 18U));
        encoded[1] = (unsigned char)(0x80U | ((codepoint >> 12U) & 0x3fU));
        encoded[2] = (unsigned char)(0x80U | ((codepoint >> 6U) & 0x3fU));
        encoded[3] = (unsigned char)(0x80U | (codepoint & 0x3fU));
        encoded_length = 4;
    } else {
        parser->error = "invalid JSON unicode codepoint";
        return false;
    }

    if (*length > capacity || encoded_length > capacity - *length) {
        parser->error = "JSON string exceeds field limit";
        return false;
    }
    memcpy(output + *length, encoded, encoded_length);
    *length += encoded_length;
    return true;
}

static bool parse_json_string(json_parser *parser, unsigned char *output, size_t capacity, size_t *output_length) {
    size_t length = 0;
    skip_whitespace(parser);
    if (parser->cursor >= parser->end || *parser->cursor != '"') {
        parser->error = "expected JSON string";
        return false;
    }
    parser->cursor++;

    while (parser->cursor < parser->end) {
        unsigned char value = (unsigned char)*parser->cursor++;
        if (value == '"') {
            *output_length = length;
            return true;
        }
        if (value < 0x20U) {
            parser->error = "unescaped control character in JSON string";
            return false;
        }
        if (value != '\\') {
            if (length >= capacity) {
                parser->error = "JSON string exceeds field limit";
                return false;
            }
            output[length++] = value;
            continue;
        }

        if (parser->cursor >= parser->end) {
            parser->error = "truncated JSON escape";
            return false;
        }
        value = (unsigned char)*parser->cursor++;
        switch (value) {
            case '"':
            case '\\':
            case '/':
                if (length >= capacity) {
                    parser->error = "JSON string exceeds field limit";
                    return false;
                }
                output[length++] = value;
                break;
            case 'b':
                if (length >= capacity) return parser->error = "JSON string exceeds field limit", false;
                output[length++] = '\b';
                break;
            case 'f':
                if (length >= capacity) return parser->error = "JSON string exceeds field limit", false;
                output[length++] = '\f';
                break;
            case 'n':
                if (length >= capacity) return parser->error = "JSON string exceeds field limit", false;
                output[length++] = '\n';
                break;
            case 'r':
                if (length >= capacity) return parser->error = "JSON string exceeds field limit", false;
                output[length++] = '\r';
                break;
            case 't':
                if (length >= capacity) return parser->error = "JSON string exceeds field limit", false;
                output[length++] = '\t';
                break;
            case 'u': {
                uint32_t codepoint;
                if (!parse_hex_quad(parser, &codepoint)) return false;
                if (codepoint >= 0xd800U && codepoint <= 0xdbffU) {
                    uint32_t low_surrogate;
                    if ((size_t)(parser->end - parser->cursor) < 6U || parser->cursor[0] != '\\' ||
                        parser->cursor[1] != 'u') {
                        parser->error = "unpaired JSON unicode surrogate";
                        return false;
                    }
                    parser->cursor += 2;
                    if (!parse_hex_quad(parser, &low_surrogate)) return false;
                    if (low_surrogate < 0xdc00U || low_surrogate > 0xdfffU) {
                        parser->error = "invalid JSON unicode surrogate pair";
                        return false;
                    }
                    codepoint = 0x10000U + ((codepoint - 0xd800U) << 10U) + (low_surrogate - 0xdc00U);
                }
                if (!append_utf8(parser, codepoint, output, capacity, &length)) return false;
                break;
            }
            default:
                parser->error = "invalid JSON escape";
                return false;
        }
    }

    parser->error = "unterminated JSON string";
    return false;
}

static bool parse_field_name(json_parser *parser, char *output, size_t capacity) {
    size_t length = 0;
    if (capacity == 0 || !parse_json_string(parser, (unsigned char *)output, capacity - 1U, &length)) {
        return false;
    }
    if (memchr(output, '\0', length) != NULL) {
        parser->error = "NUL is not allowed in JSON field names";
        return false;
    }
    output[length] = '\0';
    return true;
}

static bool parse_text_field(json_parser *parser, char *output, size_t capacity) {
    size_t length = 0;
    if (capacity == 0 || !parse_json_string(parser, (unsigned char *)output, capacity - 1U, &length)) {
        return false;
    }
    if (memchr(output, '\0', length) != NULL) {
        parser->error = "NUL is not allowed in this JSON string";
        return false;
    }
    output[length] = '\0';
    return true;
}

static bool parse_forward_capability(json_parser *parser,
                                     unsigned char capability[FORWARD_CAPABILITY_BYTES]) {
    char encoded[(FORWARD_CAPABILITY_BYTES * 2U) + 1U] = {0};
    if (!parse_text_field(parser, encoded, sizeof(encoded))) {
        secure_zero(encoded, sizeof(encoded));
        return false;
    }
    if (strlen(encoded) != FORWARD_CAPABILITY_BYTES * 2U) {
        secure_zero(encoded, sizeof(encoded));
        parser->error = "forwardCapability must be exactly 32 bytes encoded as hexadecimal";
        return false;
    }
    for (size_t index = 0; index < FORWARD_CAPABILITY_BYTES; index++) {
        const int high = hex_value(encoded[index * 2U]);
        const int low = hex_value(encoded[index * 2U + 1U]);
        if (high < 0 || low < 0) {
            secure_zero(encoded, sizeof(encoded));
            parser->error = "forwardCapability must contain only hexadecimal characters";
            return false;
        }
        capability[index] = (unsigned char)(((unsigned int)high << 4U) | (unsigned int)low);
    }
    secure_zero(encoded, sizeof(encoded));
    return true;
}

static bool parse_uint64(json_parser *parser, uint64_t maximum, uint64_t *result) {
    uint64_t value = 0;
    const char *start;

    skip_whitespace(parser);
    start = parser->cursor;
    if (start >= parser->end || *start < '0' || *start > '9') {
        parser->error = "expected unsigned JSON integer";
        return false;
    }
    if (*parser->cursor == '0') {
        parser->cursor++;
        if (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
            parser->error = "leading zero in JSON integer";
            return false;
        }
    } else {
        while (parser->cursor < parser->end && *parser->cursor >= '0' && *parser->cursor <= '9') {
            const uint64_t digit = (uint64_t)(*parser->cursor - '0');
            if (digit > maximum || value > (maximum - digit) / 10U) {
                parser->error = "JSON integer exceeds allowed range";
                return false;
            }
            value = value * 10U + digit;
            parser->cursor++;
        }
    }
    if (parser->cursor == start) {
        parser->error = "expected unsigned JSON integer";
        return false;
    }
    *result = value;
    return true;
}

static bool parse_unsigned(json_parser *parser, unsigned int maximum, unsigned int *result) {
    uint64_t value;
    if (!parse_uint64(parser, maximum, &value)) return false;
    *result = (unsigned int)value;
    return true;
}

static bool parse_boolean(json_parser *parser, bool *result) {
    skip_whitespace(parser);
    if ((size_t)(parser->end - parser->cursor) >= 4U && memcmp(parser->cursor, "true", 4U) == 0) {
        parser->cursor += 4;
        *result = true;
        return true;
    }
    if ((size_t)(parser->end - parser->cursor) >= 5U && memcmp(parser->cursor, "false", 5U) == 0) {
        parser->cursor += 5;
        *result = false;
        return true;
    }
    parser->error = "expected JSON boolean";
    return false;
}

static bool normalize_algorithm(const char *input, char output[64]) {
    const char *normalized = NULL;
    if (strcmp(input, "hmac(sha1)") == 0 || strcmp(input, "hmac-sha-1") == 0 ||
        strcmp(input, "hmac-sha1") == 0) {
        normalized = "hmac(sha1)";
    } else if (strcmp(input, "hmac(sha256)") == 0 || strcmp(input, "hmac-sha-256") == 0 ||
               strcmp(input, "hmac-sha256") == 0) {
        normalized = "hmac(sha256)";
    } else if (strcmp(input, "cmac(aes)") == 0 || strcmp(input, "cmac(aes128)") == 0 ||
               strcmp(input, "aes-128-cmac-96") == 0) {
        /* Linux TCP-AO names the RFC 5926 KDF variant cmac(aes128). */
        normalized = "cmac(aes128)";
    }
    if (normalized == NULL) return false;
    strcpy(output, normalized);
    return true;
}

static bool ipv4_host_bits_are_zero(const struct in_addr *address, uint8_t prefix) {
    const uint32_t host_value = ntohl(address->s_addr);
    const uint32_t mask = prefix == 0U ? 0U : UINT32_MAX << (32U - prefix);
    return (host_value & ~mask) == 0U;
}

static bool ipv6_host_bits_are_zero(const struct in6_addr *address, uint8_t prefix) {
    unsigned int full_bytes = prefix / 8U;
    const unsigned int remaining_bits = prefix % 8U;
    if (remaining_bits != 0U) {
        const uint8_t mask = (uint8_t)(0xffU << (8U - remaining_bits));
        if ((address->s6_addr[full_bytes] & (uint8_t)~mask) != 0U) return false;
        full_bytes++;
    }
    for (unsigned int index = full_bytes; index < 16U; index++) {
        if (address->s6_addr[index] != 0U) return false;
    }
    return true;
}

static bool parse_peer_cidr(const char *input, ao_profile_config *profile) {
    char address_text[INET6_ADDRSTRLEN + 1];
    const char *slash = strchr(input, '/');
    size_t address_length = slash == NULL ? strlen(input) : (size_t)(slash - input);
    unsigned long prefix_value;
    char *prefix_end = NULL;

    if (address_length == 0U || address_length >= sizeof(address_text)) return false;
    if (slash != NULL && strchr(slash + 1, '/') != NULL) return false;
    memcpy(address_text, input, address_length);
    address_text[address_length] = '\0';

    if (inet_pton(AF_INET, address_text, &profile->address.v4) == 1) {
        profile->family = AF_INET;
        prefix_value = 32U;
    } else if (inet_pton(AF_INET6, address_text, &profile->address.v6) == 1) {
        profile->family = AF_INET6;
        prefix_value = 128U;
    } else {
        return false;
    }

    if (slash != NULL) {
        if (slash[1] == '\0') return false;
        errno = 0;
        prefix_value = strtoul(slash + 1, &prefix_end, 10);
        if (errno != 0 || prefix_end == slash + 1 || *prefix_end != '\0') return false;
    }
    if ((profile->family == AF_INET && prefix_value > 32U) ||
        (profile->family == AF_INET6 && prefix_value > 128U)) {
        return false;
    }
    profile->prefix = (uint8_t)prefix_value;
    return profile->family == AF_INET ? ipv4_host_bits_are_zero(&profile->address.v4, profile->prefix)
                                      : ipv6_host_bits_are_zero(&profile->address.v6, profile->prefix);
}

static bool parse_key_object(json_parser *parser, ao_key_config *key) {
    char field_name[64];
    char algorithm_input[64];
    unsigned int numeric_value;
    uint64_t timestamp;
    bool have_algorithm = false;
    bool have_key = false;
    bool have_snd_id = false;
    bool have_rcv_id = false;
    bool have_key_id = false;
    bool have_mac_length = false;
    bool have_current = false;
    bool have_accept_start = false;
    bool have_send_start = false;
    bool have_send_end = false;
    bool have_accept_end = false;

    memset(key, 0, sizeof(*key));
    key->mac_length = 12U;
    if (!consume_character(parser, '{')) return false;
    skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == '}') {
        parser->error = "TCP-AO key object is empty";
        return false;
    }

    while (true) {
        if (!parse_field_name(parser, field_name, sizeof(field_name)) || !consume_character(parser, ':')) return false;

        if (strcmp(field_name, "algorithm") == 0) {
            if (have_algorithm) return parser->error = "duplicate algorithm field", false;
            if (!parse_text_field(parser, algorithm_input, sizeof(algorithm_input))) return false;
            have_algorithm = true;
        } else if (strcmp(field_name, "sndId") == 0) {
            if (have_snd_id || !parse_unsigned(parser, UINT8_MAX, &numeric_value)) {
                if (have_snd_id) parser->error = "duplicate sndId field";
                return false;
            }
            key->snd_id = (uint8_t)numeric_value;
            have_snd_id = true;
        } else if (strcmp(field_name, "rcvId") == 0) {
            if (have_rcv_id || !parse_unsigned(parser, UINT8_MAX, &numeric_value)) {
                if (have_rcv_id) parser->error = "duplicate rcvId field";
                return false;
            }
            key->rcv_id = (uint8_t)numeric_value;
            have_rcv_id = true;
        } else if (strcmp(field_name, "keyId") == 0) {
            if (have_key_id || !parse_unsigned(parser, UINT8_MAX, &numeric_value)) {
                if (have_key_id) parser->error = "duplicate keyId field";
                return false;
            }
            key->snd_id = (uint8_t)numeric_value;
            key->rcv_id = (uint8_t)numeric_value;
            have_key_id = true;
        } else if (strcmp(field_name, "key") == 0) {
            size_t key_length = 0;
            if (have_key) return parser->error = "duplicate key field", false;
            if (!parse_json_string(parser, key->key, sizeof(key->key), &key_length)) return false;
            if (key_length == 0U) return parser->error = "TCP-AO key must not be empty", false;
            key->key_length = (uint8_t)key_length;
            have_key = true;
        } else if (strcmp(field_name, "macLength") == 0) {
            if (have_mac_length || !parse_unsigned(parser, MAX_TCP_AO_MAC_LENGTH, &numeric_value)) {
                if (have_mac_length) parser->error = "duplicate macLength field";
                return false;
            }
            if (numeric_value < 4U) return parser->error = "macLength must be between 4 and 36", false;
            key->mac_length = (uint8_t)numeric_value;
            have_mac_length = true;
        } else if (strcmp(field_name, "current") == 0) {
            if (have_current || !parse_boolean(parser, &key->current)) {
                if (have_current) parser->error = "duplicate current field";
                return false;
            }
            key->current_explicit = key->current;
            have_current = true;
        } else if (strcmp(field_name, "acceptStart") == 0) {
            if (have_accept_start || !parse_uint64(parser, UINT64_MAX, &timestamp)) {
                if (have_accept_start) parser->error = "duplicate acceptStart field";
                return false;
            }
            key->accept_start = timestamp;
            have_accept_start = true;
        } else if (strcmp(field_name, "sendStart") == 0) {
            if (have_send_start || !parse_uint64(parser, UINT64_MAX, &timestamp)) {
                if (have_send_start) parser->error = "duplicate sendStart field";
                return false;
            }
            key->send_start = timestamp;
            have_send_start = true;
        } else if (strcmp(field_name, "sendEnd") == 0) {
            if (have_send_end || !parse_uint64(parser, UINT64_MAX, &timestamp)) {
                if (have_send_end) parser->error = "duplicate sendEnd field";
                return false;
            }
            key->send_end = timestamp;
            have_send_end = true;
        } else if (strcmp(field_name, "acceptEnd") == 0) {
            if (have_accept_end || !parse_uint64(parser, UINT64_MAX, &timestamp)) {
                if (have_accept_end) parser->error = "duplicate acceptEnd field";
                return false;
            }
            key->accept_end = timestamp;
            have_accept_end = true;
        } else {
            parser->error = "unknown field in TCP-AO key object";
            return false;
        }

        skip_whitespace(parser);
        if (parser->cursor < parser->end && *parser->cursor == '}') {
            parser->cursor++;
            break;
        }
        if (!consume_character(parser, ',')) return false;
    }

    if (!have_algorithm || !have_key) {
        parser->error = "TCP-AO key requires algorithm and key";
        return false;
    }
    if (have_key_id && (have_snd_id || have_rcv_id)) {
        parser->error = "keyId cannot be combined with sndId or rcvId";
        return false;
    }
    if (!have_key_id && (!have_snd_id || !have_rcv_id)) {
        parser->error = "TCP-AO key requires sndId and rcvId";
        return false;
    }
    if (!normalize_algorithm(algorithm_input, key->algorithm)) {
        parser->error = "unsupported TCP-AO algorithm";
        return false;
    }
    if (memchr(key->key, '\0', key->key_length) != NULL) {
        parser->error = "TCP-AO key must not contain NUL";
        return false;
    }
    if (strcmp(key->algorithm, "cmac(aes128)") == 0 && key->key_length != 16U) {
        parser->error = "AES-128-CMAC keys must be exactly 16 bytes";
        return false;
    }
    if ((strcmp(key->algorithm, "cmac(aes128)") == 0 && key->mac_length > 16U) ||
        (strcmp(key->algorithm, "hmac(sha1)") == 0 && key->mac_length > 20U) ||
        (strcmp(key->algorithm, "hmac(sha256)") == 0 && key->mac_length > 32U)) {
        parser->error = "macLength exceeds the selected algorithm output size";
        return false;
    }
    return true;
}

static bool parse_keys_array(json_parser *parser, helper_config *config, ao_profile_config *profile) {
    profile->first_key = config->key_count;
    if (!consume_character(parser, '[')) return false;
    skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == ']') {
        parser->cursor++;
        parser->error = "at least one TCP-AO key is required";
        return false;
    }

    while (true) {
        if (profile->key_count >= MAX_KEYS_PER_PROFILE) {
            parser->error = "too many TCP-AO keys in one profile";
            return false;
        }
        if (config->key_count >= MAX_KEYS) {
            parser->error = "too many TCP-AO keys";
            return false;
        }
        if (!parse_key_object(parser, &config->keys[config->key_count])) return false;
        config->key_count++;
        profile->key_count++;
        skip_whitespace(parser);
        if (parser->cursor < parser->end && *parser->cursor == ']') {
            parser->cursor++;
            return true;
        }
        if (!consume_character(parser, ',')) return false;
    }
}

static bool parse_profile_object(json_parser *parser, helper_config *config, ao_profile_config *profile) {
    char field_name[64];
    char peer[INET6_ADDRSTRLEN + 6];
    bool have_peer = false;
    bool have_keys = false;

    memset(profile, 0, sizeof(*profile));
    profile->current_key_index = -1;
    if (!consume_character(parser, '{')) return false;
    skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == '}') {
        parser->error = "TCP-AO profile object is empty";
        return false;
    }
    while (true) {
        if (!parse_field_name(parser, field_name, sizeof(field_name)) || !consume_character(parser, ':')) return false;
        if (strcmp(field_name, "peer") == 0) {
            if (have_peer) return parser->error = "duplicate peer field", false;
            if (!parse_text_field(parser, peer, sizeof(peer))) return false;
            have_peer = true;
        } else if (strcmp(field_name, "keys") == 0) {
            if (have_keys) return parser->error = "duplicate keys field", false;
            if (!parse_keys_array(parser, config, profile)) return false;
            have_keys = true;
        } else {
            parser->error = "unknown field in TCP-AO profile object";
            return false;
        }
        skip_whitespace(parser);
        if (parser->cursor < parser->end && *parser->cursor == '}') {
            parser->cursor++;
            break;
        }
        if (!consume_character(parser, ',')) return false;
    }
    if (!have_peer || !have_keys || profile->key_count == 0U) {
        parser->error = "TCP-AO profile requires peer and keys";
        return false;
    }
    if (!parse_peer_cidr(peer, profile)) {
        parser->error = "peer must be a canonical IPv4 or IPv6 CIDR";
        return false;
    }
    return true;
}

static bool parse_profiles_array(json_parser *parser, helper_config *config) {
    if (!consume_character(parser, '[')) return false;
    skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == ']') {
        parser->cursor++;
        parser->error = "at least one TCP-AO profile is required";
        return false;
    }
    while (true) {
        if (config->profile_count >= MAX_PROFILES) {
            parser->error = "too many TCP-AO profiles";
            return false;
        }
        if (!parse_profile_object(parser, config, &config->profiles[config->profile_count])) return false;
        config->profile_count++;
        skip_whitespace(parser);
        if (parser->cursor < parser->end && *parser->cursor == ']') {
            parser->cursor++;
            return true;
        }
        if (!consume_character(parser, ',')) return false;
    }
}

static bool time_window_valid(uint64_t start, uint64_t end, uint64_t now) {
    return (start == 0U || now >= start) && (end == 0U || now < end);
}

static bool advance_wall_clock(uint64_t *last_wall_time, uint64_t now) {
    if (now < *last_wall_time) return false;
    *last_wall_time = now;
    return true;
}

static bool accept_window_valid(const ao_key_config *key, uint64_t now) {
    return time_window_valid(key->accept_start, key->accept_end, now);
}

static bool send_window_valid(const ao_key_config *key, uint64_t now) {
    return time_window_valid(key->send_start, key->send_end, now);
}

static bool starts_not_after(uint64_t left, uint64_t right) {
    if (left == 0U) return true;
    if (right == 0U) return false;
    return left <= right;
}

static bool end_not_after(uint64_t left, uint64_t right) {
    if (right == 0U) return true;
    if (left == 0U) return false;
    return left <= right;
}

static bool starts_strictly_before_end(uint64_t start, uint64_t end) {
    if (end == 0U) return true;
    if (start == 0U) return true;
    return start < end;
}

static bool windows_overlap(uint64_t first_start, uint64_t first_end, uint64_t second_start,
                            uint64_t second_end) {
    const bool first_before_second_end = second_end == 0U || first_start == 0U || first_start < second_end;
    const bool second_before_first_end = first_end == 0U || second_start == 0U || second_start < first_end;
    return first_before_second_end && second_before_first_end;
}

static ssize_t select_profile_current_key(const helper_config *config, const ao_profile_config *profile,
                                          uint64_t now) {
    ssize_t selected = -1;
    for (size_t offset = 0; offset < profile->key_count; offset++) {
        const size_t index = profile->first_key + offset;
        const ao_key_config *candidate = &config->keys[index];
        if (!send_window_valid(candidate, now)) continue;
        if (selected < 0) {
            selected = (ssize_t)index;
            continue;
        }
        const ao_key_config *current = &config->keys[(size_t)selected];
        if ((candidate->send_start != 0U &&
             (current->send_start == 0U || candidate->send_start > current->send_start)) ||
            (candidate->send_start == current->send_start && candidate->current_explicit &&
             !current->current_explicit)) {
            selected = (ssize_t)index;
        }
    }
    return selected;
}

static bool validate_profile_schedule(helper_config *config, ao_profile_config *profile, uint64_t now,
                                      const char **error) {
    size_t explicit_count = 0;
    for (size_t left_offset = 0; left_offset < profile->key_count; left_offset++) {
        ao_key_config *left = &config->keys[profile->first_key + left_offset];
        if (!starts_not_after(left->accept_start, left->send_start) ||
            !starts_strictly_before_end(left->send_start, left->send_end) ||
            !end_not_after(left->send_end, left->accept_end)) {
            *error = "key lifetime must satisfy acceptStart <= sendStart < sendEnd <= acceptEnd";
            return false;
        }
        if (left->current_explicit) explicit_count++;
        for (size_t right_offset = left_offset + 1U; right_offset < profile->key_count; right_offset++) {
            const ao_key_config *right = &config->keys[profile->first_key + right_offset];
            if (left->snd_id == right->snd_id || left->rcv_id == right->rcv_id) {
                *error = "sndId and rcvId must be unique within each profile";
                return false;
            }
            if (windows_overlap(left->send_start, left->send_end, right->send_start, right->send_end)) {
                *error = "send-key lifetimes must not overlap";
                return false;
            }
        }
    }
    if (explicit_count > 1U) {
        *error = "only one explicit current key is allowed per profile";
        return false;
    }

    profile->current_key_index = select_profile_current_key(config, profile, now);
    if (profile->current_key_index < 0) {
        *error = "every profile requires exactly one send-valid key at startup";
        return false;
    }
    if (explicit_count == 1U && !config->keys[(size_t)profile->current_key_index].current_explicit) {
        *error = "the explicit current key is not send-valid at startup";
        return false;
    }
    config->keys[(size_t)profile->current_key_index].current = true;

    /* Require exact, gap-free hand-offs; a finite last key is an explicit fail-closed deadline. */
    size_t current_index = (size_t)profile->current_key_index;
    size_t traversed = 0U;
    while (config->keys[current_index].send_end != 0U) {
        const uint64_t next_start = config->keys[current_index].send_end;
        ssize_t next_index = -1;
        for (size_t offset = 0; offset < profile->key_count; offset++) {
            const size_t candidate_index = profile->first_key + offset;
            const ao_key_config *key = &config->keys[profile->first_key + offset];
            if (key->send_start != next_start) continue;
            if (next_index >= 0) {
                *error = "send-key schedule contains an ambiguous hand-off";
                return false;
            }
            next_index = (ssize_t)candidate_index;
        }
        if (next_index < 0) {
            for (size_t offset = 0; offset < profile->key_count; offset++) {
                const ao_key_config *key = &config->keys[profile->first_key + offset];
                if (key->send_start != 0U && key->send_start > next_start) {
                    *error = "send-key schedule has a gap before a future key";
                    return false;
                }
            }
            return true;
        }
        current_index = (size_t)next_index;
        traversed++;
        if (traversed >= profile->key_count) {
            *error = "send-key schedule contains a cycle";
            return false;
        }
    }
    return true;
}

static bool prefix_equal(const ao_profile_config *left, const ao_profile_config *right) {
    const uint8_t prefix = left->prefix < right->prefix ? left->prefix : right->prefix;
    if (left->family == AF_INET) {
        const uint32_t left_value = ntohl(left->address.v4.s_addr);
        const uint32_t right_value = ntohl(right->address.v4.s_addr);
        const uint32_t mask = prefix == 0U ? 0U : UINT32_MAX << (32U - prefix);
        return (left_value & mask) == (right_value & mask);
    }
    const unsigned int full_bytes = prefix / 8U;
    const unsigned int remaining_bits = prefix % 8U;
    if (full_bytes > 0U && memcmp(left->address.v6.s6_addr, right->address.v6.s6_addr, full_bytes) != 0) {
        return false;
    }
    if (remaining_bits == 0U) return true;
    const uint8_t mask = (uint8_t)(0xffU << (8U - remaining_bits));
    return (left->address.v6.s6_addr[full_bytes] & mask) == (right->address.v6.s6_addr[full_bytes] & mask);
}

static bool validate_config(helper_config *config, const char **error) {
    const time_t now_time = time(NULL);
    if (now_time < 0) {
        *error = "system clock is unavailable";
        return false;
    }
    const uint64_t now = (uint64_t)now_time;
    for (size_t index = 0; index < config->profile_count; index++) {
        if (!validate_profile_schedule(config, &config->profiles[index], now, error)) return false;
        for (size_t other = index + 1U; other < config->profile_count; other++) {
            if (config->profiles[index].family == config->profiles[other].family &&
                prefix_equal(&config->profiles[index], &config->profiles[other])) {
                *error = "TCP-AO peer CIDRs must not overlap";
                return false;
            }
        }
    }
    config->validated_at = now;
    return true;
}

static bool parse_config_json(const char *json, size_t length, helper_config *config, const char **error) {
    json_parser parser = {.cursor = json, .end = json + length, .error = NULL};
    char field_name[64];
    bool have_profiles = false;
    bool have_schema_version = false;
    bool have_forward_capability = false;

    config->profiles = calloc(MAX_PROFILES, sizeof(*config->profiles));
    config->keys = calloc(MAX_KEYS, sizeof(*config->keys));
    if (config->profiles == NULL || config->keys == NULL) {
        *error = "unable to allocate TCP-AO key configuration";
        return false;
    }
    /* Best effort: retaining future keys is required for rotation, so keep them out of swap when permitted. */
    (void)mlock(config->profiles, MAX_PROFILES * sizeof(*config->profiles));
    (void)mlock(config->keys, MAX_KEYS * sizeof(*config->keys));

    if (!consume_character(&parser, '{')) goto invalid;
    skip_whitespace(&parser);
    if (parser.cursor < parser.end && *parser.cursor == '}') {
        parser.error = "configuration object is empty";
        goto invalid;
    }
    while (true) {
        if (!parse_field_name(&parser, field_name, sizeof(field_name)) || !consume_character(&parser, ':')) goto invalid;
        if (strcmp(field_name, "profiles") == 0) {
            if (have_profiles) {
                parser.error = "duplicate profiles field";
                goto invalid;
            }
            if (!parse_profiles_array(&parser, config)) goto invalid;
            have_profiles = true;
        } else if (strcmp(field_name, "schemaVersion") == 0) {
            unsigned int schema_version;
            if (have_schema_version || !parse_unsigned(&parser, 2U, &schema_version) || schema_version == 0U) {
                if (have_schema_version) parser.error = "duplicate schemaVersion field";
                else if (parser.error == NULL) parser.error = "unsupported schemaVersion";
                goto invalid;
            }
            config->schema_version = schema_version;
            have_schema_version = true;
        } else if (strcmp(field_name, "forwardCapability") == 0) {
            if (have_forward_capability ||
                !parse_forward_capability(&parser, config->forward_capability)) {
                if (have_forward_capability) parser.error = "duplicate forwardCapability field";
                goto invalid;
            }
            config->have_forward_capability = true;
            have_forward_capability = true;
        } else {
            parser.error = "unknown TCP-AO configuration field";
            goto invalid;
        }
        skip_whitespace(&parser);
        if (parser.cursor < parser.end && *parser.cursor == '}') {
            parser.cursor++;
            break;
        }
        if (!consume_character(&parser, ',')) goto invalid;
    }
    skip_whitespace(&parser);
    if (parser.cursor != parser.end) {
        parser.error = "trailing data after TCP-AO configuration";
        goto invalid;
    }
    if (!have_schema_version) {
        parser.error = "schemaVersion 1 or 2 is required";
        goto invalid;
    }
    if (!have_profiles || config->profile_count == 0U || config->key_count == 0U) {
        parser.error = "at least one TCP-AO profile is required";
        goto invalid;
    }
    if (!validate_config(config, &parser.error)) goto invalid;
    return true;

invalid:
    *error = parser.error == NULL ? "invalid TCP-AO JSON configuration" : parser.error;
    return false;
}

static void destroy_config(helper_config *config) {
    if (config->profiles != NULL) {
        secure_zero(config->profiles, MAX_PROFILES * sizeof(*config->profiles));
        (void)munlock(config->profiles, MAX_PROFILES * sizeof(*config->profiles));
        free(config->profiles);
    }
    if (config->keys != NULL) {
        secure_zero(config->keys, MAX_KEYS * sizeof(*config->keys));
        (void)munlock(config->keys, MAX_KEYS * sizeof(*config->keys));
        free(config->keys);
    }
    config->profiles = NULL;
    config->profile_count = 0;
    config->keys = NULL;
    config->key_count = 0;
    config->validated_at = 0U;
    secure_zero(config->forward_capability, sizeof(config->forward_capability));
    config->schema_version = 0U;
    config->have_forward_capability = false;
}

static bool read_stdin_config(char **buffer_out, size_t *length_out, const char **error) {
    char *buffer = malloc(MAX_CONFIG_BYTES + 1U);
    size_t length = 0;
    bool locked = false;
    if (buffer == NULL) {
        *error = "unable to allocate stdin configuration buffer";
        return false;
    }
    if (mlock(buffer, MAX_CONFIG_BYTES + 1U) == 0) locked = true;

    while (length < MAX_CONFIG_BYTES) {
        const ssize_t count = read(STDIN_FILENO, buffer + length, MAX_CONFIG_BYTES - length);
        if (count > 0) {
            length += (size_t)count;
            continue;
        }
        if (count == 0) break;
        if (errno == EINTR) continue;
        *error = "unable to read TCP-AO configuration from stdin";
        secure_zero(buffer, MAX_CONFIG_BYTES + 1U);
        if (locked) munlock(buffer, MAX_CONFIG_BYTES + 1U);
        free(buffer);
        return false;
    }

    if (length == MAX_CONFIG_BYTES) {
        char extra;
        ssize_t count;
        do {
            count = read(STDIN_FILENO, &extra, 1U);
        } while (count < 0 && errno == EINTR);
        if (count > 0) {
            *error = "TCP-AO configuration exceeds one MiB";
            secure_zero(buffer, MAX_CONFIG_BYTES + 1U);
            if (locked) munlock(buffer, MAX_CONFIG_BYTES + 1U);
            free(buffer);
            return false;
        }
    }
    if (length == 0U) {
        *error = "TCP-AO configuration is required on stdin";
        secure_zero(buffer, MAX_CONFIG_BYTES + 1U);
        if (locked) munlock(buffer, MAX_CONFIG_BYTES + 1U);
        free(buffer);
        return false;
    }
    buffer[length] = '\0';
    *buffer_out = buffer;
    *length_out = length;
    /* The caller wipes and unlocks the fixed allocation after parsing. */
    return true;
}

static void release_stdin_buffer(char *buffer) {
    if (buffer == NULL) return;
    secure_zero(buffer, MAX_CONFIG_BYTES + 1U);
    (void)munlock(buffer, MAX_CONFIG_BYTES + 1U);
    free(buffer);
}

static size_t count_family_profiles(const helper_config *config, int family) {
    size_t count = 0;
    for (size_t index = 0; index < config->profile_count; index++) {
        if (config->profiles[index].family == family) count++;
    }
    return count;
}

static size_t count_installed_keys(const helper_config *config) {
    size_t count = 0U;
    for (size_t index = 0; index < config->key_count; index++) {
        if (config->keys[index].installed_on_listener) count++;
    }
    return count;
}

static int create_listener_socket(int family) {
    int socket_fd = socket(family, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    int enabled = 1;
    if (socket_fd < 0) return -1;
    if (setsockopt(socket_fd, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled)) < 0) {
        close(socket_fd);
        return -1;
    }
    if (family == AF_INET6 &&
        setsockopt(socket_fd, IPPROTO_IPV6, IPV6_V6ONLY, &enabled, sizeof(enabled)) < 0) {
        close(socket_fd);
        return -1;
    }
    return socket_fd;
}

static void set_command_peer_address(struct __kernel_sockaddr_storage *storage,
                                     const ao_profile_config *profile) {
    if (profile->family == AF_INET) {
        struct sockaddr_in *address = (struct sockaddr_in *)storage;
        address->sin_family = AF_INET;
        address->sin_addr = profile->address.v4;
    } else {
        struct sockaddr_in6 *address = (struct sockaddr_in6 *)storage;
        address->sin6_family = AF_INET6;
        address->sin6_addr = profile->address.v6;
    }
}

static int install_ao_key(int socket_fd, const ao_profile_config *profile, const ao_key_config *key) {
    struct tcp_ao_add command;
    int result;
    memset(&command, 0, sizeof(command));

    set_command_peer_address(&command.addr, profile);
    memcpy(command.alg_name, key->algorithm, strlen(key->algorithm) + 1U);
    command.set_current = 0U;
    command.set_rnext = 0U;
    command.prefix = profile->prefix;
    command.sndid = key->snd_id;
    command.rcvid = key->rcv_id;
    command.maclen = key->mac_length;
    command.keylen = key->key_length;
    memcpy(command.key, key->key, key->key_length);

    result = setsockopt(socket_fd, IPPROTO_TCP, TCP_AO_ADD_KEY, &command, sizeof(command));
    secure_zero(&command, sizeof(command));
    return result;
}

static int delete_ao_key(int socket_fd, const ao_profile_config *profile, const ao_key_config *key,
                         bool listener) {
    struct tcp_ao_del command;
    int result;
    memset(&command, 0, sizeof(command));
    set_command_peer_address(&command.addr, profile);
    command.del_async = listener ? 1U : 0U;
    command.prefix = profile->prefix;
    command.sndid = key->snd_id;
    command.rcvid = key->rcv_id;
    result = setsockopt(socket_fd, IPPROTO_TCP, TCP_AO_DEL_KEY, &command, sizeof(command));
    secure_zero(&command, sizeof(command));
    return result;
}

static int set_socket_current_key(int socket_fd, const ao_key_config *key) {
    struct tcp_ao_info_opt info;
    socklen_t info_length = sizeof(info);
    memset(&info, 0, sizeof(info));
    info.set_current = 1U;
    info.set_rnext = 1U;
    info.ao_required = 1U;
    info.current_key = key->snd_id;
    info.rnext = key->rcv_id;
    if (setsockopt(socket_fd, IPPROTO_TCP, TCP_AO_INFO, &info, sizeof(info)) < 0) return -1;

    memset(&info, 0, sizeof(info));
    if (getsockopt(socket_fd, IPPROTO_TCP, TCP_AO_INFO, &info, &info_length) < 0) return -1;
    if (info_length < sizeof(info) || info.ao_required != 1U || info.set_current != 1U ||
        info.set_rnext != 1U || info.current_key != key->snd_id || info.rnext != key->rcv_id) {
        errno = EPROTO;
        return -1;
    }
    return 0;
}

static int require_tcp_ao(int socket_fd) {
    struct tcp_ao_info_opt info;
    socklen_t info_length = sizeof(info);
    memset(&info, 0, sizeof(info));
    info.ao_required = 1U;
    if (setsockopt(socket_fd, IPPROTO_TCP, TCP_AO_INFO, &info, sizeof(info)) < 0) return -1;
    memset(&info, 0, sizeof(info));
    if (getsockopt(socket_fd, IPPROTO_TCP, TCP_AO_INFO, &info, &info_length) < 0) return -1;
    if (info_length < sizeof(info) || info.ao_required != 1U) {
        errno = EPROTO;
        return -1;
    }
    return 0;
}

static int configure_listener(int socket_fd, int family, helper_config *config, uint64_t now,
                              size_t *installed_count) {
    for (size_t profile_index = 0; profile_index < config->profile_count; profile_index++) {
        const ao_profile_config *profile = &config->profiles[profile_index];
        if (profile->family != family) continue;
        for (size_t offset = 0; offset < profile->key_count; offset++) {
            ao_key_config *key = &config->keys[profile->first_key + offset];
            if (!accept_window_valid(key, now)) continue;
            if (install_ao_key(socket_fd, profile, key) < 0) return -1;
            key->installed_on_listener = true;
            (*installed_count)++;
        }
    }
    return require_tcp_ao(socket_fd);
}

static int bind_and_listen(int socket_fd, int family, uint16_t port, int backlog) {
    if (family == AF_INET) {
        struct sockaddr_in address;
        memset(&address, 0, sizeof(address));
        address.sin_family = AF_INET;
        address.sin_port = htons(port);
        address.sin_addr.s_addr = htonl(INADDR_ANY);
        if (bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) return -1;
    } else {
        struct sockaddr_in6 address;
        memset(&address, 0, sizeof(address));
        address.sin6_family = AF_INET6;
        address.sin6_port = htons(port);
        address.sin6_addr = in6addr_any;
        if (bind(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) return -1;
    }
    if (listen(socket_fd, backlog) < 0) return -1;
    const int flags = fcntl(socket_fd, F_GETFL, 0);
    if (flags < 0 || fcntl(socket_fd, F_SETFL, flags | O_NONBLOCK) < 0) return -1;
    return 0;
}

static bool sockaddr_matches_profile(const struct sockaddr_storage *address,
                                     const ao_profile_config *profile) {
    if ((int)address->ss_family != profile->family) return false;
    if (profile->family == AF_INET) {
        const struct sockaddr_in *peer = (const struct sockaddr_in *)address;
        const uint32_t peer_value = ntohl(peer->sin_addr.s_addr);
        const uint32_t profile_value = ntohl(profile->address.v4.s_addr);
        const uint32_t mask = profile->prefix == 0U ? 0U : UINT32_MAX << (32U - profile->prefix);
        return (peer_value & mask) == profile_value;
    }

    const struct sockaddr_in6 *peer = (const struct sockaddr_in6 *)address;
    const unsigned int full_bytes = profile->prefix / 8U;
    const unsigned int remaining_bits = profile->prefix % 8U;
    if (full_bytes > 0U && memcmp(peer->sin6_addr.s6_addr, profile->address.v6.s6_addr, full_bytes) != 0) {
        return false;
    }
    if (remaining_bits == 0U) return true;
    const uint8_t mask = (uint8_t)(0xffU << (8U - remaining_bits));
    return (peer->sin6_addr.s6_addr[full_bytes] & mask) == profile->address.v6.s6_addr[full_bytes];
}

static ssize_t find_profile_for_peer(const helper_config *config, const struct sockaddr_storage *address) {
    for (size_t index = 0; index < config->profile_count; index++) {
        if (sockaddr_matches_profile(address, &config->profiles[index])) return (ssize_t)index;
    }
    return -1;
}

static int listener_for_family(int family, int ipv4_listener, int ipv6_listener) {
    return family == AF_INET ? ipv4_listener : ipv6_listener;
}

static void disconnect_connection_locked(connection_ctx *context) {
    if (context->closing) return;
    context->closing = true;
    (void)shutdown(context->client_fd, SHUT_RDWR);
    if (context->upstream_fd >= 0) (void)shutdown(context->upstream_fd, SHUT_RDWR);
}

static void add_key_to_active_connections(const helper_config *config, size_t profile_index,
                                          const ao_key_config *key) {
    int first_error = 0;
    pthread_mutex_lock(&connection_mutex);
    for (connection_ctx *context = connections; context != NULL; context = context->next) {
        if (context->profile_index != profile_index || context->closing) continue;
        if (install_ao_key(context->client_fd, &config->profiles[profile_index], key) < 0 && errno != EEXIST) {
            if (first_error == 0) first_error = errno;
            disconnect_connection_locked(context);
        }
    }
    pthread_mutex_unlock(&connection_mutex);
    if (first_error != 0) {
        fprintf(stderr,
                "tcp-ao-helper: live key add is unsupported for an active socket; "
                "closed the affected connection for safe reconnect: %s\n",
                strerror(first_error));
    }
}

static void set_current_on_active_connections(size_t profile_index, const ao_key_config *key) {
    int first_error = 0;
    pthread_mutex_lock(&connection_mutex);
    for (connection_ctx *context = connections; context != NULL; context = context->next) {
        if (context->profile_index != profile_index || context->closing) continue;
        if (set_socket_current_key(context->client_fd, key) < 0) {
            if (first_error == 0) first_error = errno;
            disconnect_connection_locked(context);
        }
    }
    pthread_mutex_unlock(&connection_mutex);
    if (first_error != 0) {
        fprintf(stderr,
                "tcp-ao-helper: live current-key switch is unsupported for an active socket; "
                "closed the affected connection for safe reconnect: %s\n",
                strerror(first_error));
    }
}

static void delete_key_from_active_connections(const helper_config *config, size_t profile_index,
                                               const ao_key_config *key) {
    int first_error = 0;
    pthread_mutex_lock(&connection_mutex);
    for (connection_ctx *context = connections; context != NULL; context = context->next) {
        if (context->profile_index != profile_index || context->closing) continue;
        if (delete_ao_key(context->client_fd, &config->profiles[profile_index], key, false) < 0 &&
            errno != ENOENT) {
            if (first_error == 0) first_error = errno;
            disconnect_connection_locked(context);
        }
    }
    pthread_mutex_unlock(&connection_mutex);
    if (first_error != 0) {
        fprintf(stderr,
                "tcp-ao-helper: live key deletion is unsupported for an active socket; "
                "closed the affected connection for safe reconnect: %s\n",
                strerror(first_error));
    }
}

static bool rotate_tcp_ao_keys(helper_config *config, int ipv4_listener, int ipv6_listener, uint64_t now,
                               int *failure_exit_code) {
    if (failure_exit_code != NULL) *failure_exit_code = EXIT_TCP_AO_ROTATION_FAILED;
    /* Add receive-valid keys first so a send-key hand-off can never create a key gap. */
    for (size_t profile_index = 0; profile_index < config->profile_count; profile_index++) {
        ao_profile_config *profile = &config->profiles[profile_index];
        const int listener_fd = listener_for_family(profile->family, ipv4_listener, ipv6_listener);
        if (listener_fd < 0) return false;
        for (size_t offset = 0; offset < profile->key_count; offset++) {
            ao_key_config *key = &config->keys[profile->first_key + offset];
            if (!accept_window_valid(key, now) || key->installed_on_listener) continue;
            if (install_ao_key(listener_fd, profile, key) < 0 && errno != EEXIST) {
                fprintf(stderr, "tcp-ao-helper: unable to add scheduled TCP-AO listener key: %s\n",
                        strerror(errno));
                return false;
            }
            key->installed_on_listener = true;
            add_key_to_active_connections(config, profile_index, key);
        }
    }

    /* Switch every established socket atomically once the new send window begins. */
    for (size_t profile_index = 0; profile_index < config->profile_count; profile_index++) {
        ao_profile_config *profile = &config->profiles[profile_index];
        const ssize_t selected = select_profile_current_key(config, profile, now);
        if (selected < 0 || !config->keys[(size_t)selected].installed_on_listener) {
            fprintf(stderr, "tcp-ao-helper: no installed send-valid key remains; stopping fail-closed\n");
            if (failure_exit_code != NULL) *failure_exit_code = EXIT_TCP_AO_KEYS_EXPIRED;
            return false;
        }
        if (selected == profile->current_key_index) continue;
        set_current_on_active_connections(profile_index, &config->keys[(size_t)selected]);
        if (profile->current_key_index >= 0) {
            config->keys[(size_t)profile->current_key_index].current = false;
        }
        config->keys[(size_t)selected].current = true;
        profile->current_key_index = selected;
    }

    /* Remove keys outside their receive window only after any current-key switch. */
    for (size_t profile_index = 0; profile_index < config->profile_count; profile_index++) {
        ao_profile_config *profile = &config->profiles[profile_index];
        const int listener_fd = listener_for_family(profile->family, ipv4_listener, ipv6_listener);
        for (size_t offset = 0; offset < profile->key_count; offset++) {
            ao_key_config *key = &config->keys[profile->first_key + offset];
            if (accept_window_valid(key, now) || !key->installed_on_listener) continue;
            if (delete_ao_key(listener_fd, profile, key, true) < 0 && errno != ENOENT) {
                fprintf(stderr, "tcp-ao-helper: unable to delete expired TCP-AO listener key: %s\n",
                        strerror(errno));
                return false;
            }
            key->installed_on_listener = false;
            delete_key_from_active_connections(config, profile_index, key);
        }
    }
    return true;
}

static bool reconcile_accepted_socket(int socket_fd, const helper_config *config, size_t profile_index,
                                      uint64_t now) {
    const ao_profile_config *profile = &config->profiles[profile_index];

    /*
     * Linux deliberately leaves TCP_AO_ADD_KEY/TCP_AO_DEL_KEY versus accept()
     * queue races to userspace. Re-applying the expected receive-valid set is
     * idempotent (EEXIST/ENOENT) and closes that race before selecting current.
     * current_key/rnext_key are intentionally never set on a listen socket.
     */
    for (size_t offset = 0; offset < profile->key_count; offset++) {
        const ao_key_config *key = &config->keys[profile->first_key + offset];
        if (!accept_window_valid(key, now)) continue;
        if (install_ao_key(socket_fd, profile, key) < 0 && errno != EEXIST) return false;
    }

    const ssize_t selected = select_profile_current_key(config, profile, now);
    if (selected < 0) {
        errno = EKEYREJECTED;
        return false;
    }
    if (set_socket_current_key(socket_fd, &config->keys[(size_t)selected]) < 0) return false;

    for (size_t offset = 0; offset < profile->key_count; offset++) {
        const ao_key_config *key = &config->keys[profile->first_key + offset];
        if (accept_window_valid(key, now)) continue;
        if (delete_ao_key(socket_fd, profile, key, false) < 0 && errno != ENOENT) return false;
    }
    return true;
}

static int connect_loopback(uint16_t port) {
    struct sockaddr_in address;
    int socket_fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
    if (socket_fd < 0) return -1;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    while (connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
        if (errno == EINTR && keep_running) continue;
        close(socket_fd);
        return -1;
    }
    return socket_fd;
}

static int connect_unix_socket(const char *socket_path) {
    struct sockaddr_un address;
    struct ucred credentials;
    socklen_t credentials_length = sizeof(credentials);
    const size_t path_length = strlen(socket_path);
    const socklen_t address_length =
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) + path_length + 1U);
    int socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (socket_fd < 0) return -1;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_path, path_length + 1U);
    while (connect(socket_fd, (struct sockaddr *)&address, address_length) < 0) {
        if (errno == EINTR && keep_running) continue;
        close(socket_fd);
        return -1;
    }
    memset(&credentials, 0, sizeof(credentials));
    const int credentials_result =
        getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_length);
    if (credentials_result < 0 || credentials_length != sizeof(credentials) ||
        credentials.pid != bound_parent_pid || credentials.uid != bound_parent_uid) {
        const int saved_errno = credentials_result < 0 ? errno : EACCES;
        close(socket_fd);
        errno = saved_errno;
        return -1;
    }
    return socket_fd;
}

static int connect_forward_target(const connection_ctx *context) {
    return context->use_forward_socket ? connect_unix_socket(context->forward_socket)
                                       : connect_loopback(context->forward_port);
}

static bool encode_forward_endpoint(unsigned char output[16], uint16_t *port,
                                    const struct sockaddr_storage *address, int expected_family) {
    memset(output, 0, 16U);
    if ((int)address->ss_family != expected_family) return false;
    if (expected_family == AF_INET) {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
        *port = ntohs(ipv4->sin_port);
        memcpy(output + 12U, &ipv4->sin_addr, sizeof(ipv4->sin_addr));
    } else if (expected_family == AF_INET6) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)address;
        *port = ntohs(ipv6->sin6_port);
        memcpy(output, &ipv6->sin6_addr, sizeof(ipv6->sin6_addr));
    } else {
        return false;
    }
    return *port != 0U;
}

static void encode_uint16_be(unsigned char *output, uint16_t value) {
    const uint16_t encoded = htons(value);
    memcpy(output, &encoded, sizeof(encoded));
}

static bool build_forward_peer_header(unsigned char header[FORWARD_PEER_HEADER_BYTES],
                                      const struct sockaddr_storage *peer_address,
                                      const struct sockaddr_storage *local_address,
                                      const unsigned char capability[FORWARD_CAPABILITY_BYTES]) {
    uint16_t peer_port;
    uint16_t local_port;
    const int family = (int)peer_address->ss_family;
    memset(header, 0, FORWARD_PEER_HEADER_BYTES);
    if ((family != AF_INET && family != AF_INET6) ||
        !encode_forward_endpoint(header + 16U, &peer_port, peer_address, family) ||
        !encode_forward_endpoint(header + 32U, &local_port, local_address, family)) {
        return false;
    }
    memcpy(header, "NNAO", 4U);
    header[4] = FORWARD_PEER_HEADER_VERSION;
    header[5] = family == AF_INET ? 4U : 6U;
    encode_uint16_be(header + 6U, FORWARD_PEER_HEADER_BYTES);
    encode_uint16_be(header + 8U, peer_port);
    encode_uint16_be(header + 10U, local_port);
    memcpy(header + 48U, capability, FORWARD_CAPABILITY_BYTES);
    return true;
}

static bool send_all(int socket_fd, const unsigned char *buffer, size_t length) {
    size_t offset = 0;
    while (offset < length && keep_running) {
        const ssize_t count = send(socket_fd, buffer + offset, length - offset, MSG_NOSIGNAL);
        if (count > 0) {
            offset += (size_t)count;
            continue;
        }
        if (count < 0 && errno == EINTR) continue;
        return false;
    }
    return offset == length;
}

static bool relay_once(int source_fd, int destination_fd, bool *source_open) {
    unsigned char buffer[COPY_BUFFER_SIZE];
    ssize_t count;
    do {
        count = recv(source_fd, buffer, sizeof(buffer), 0);
    } while (count < 0 && errno == EINTR && keep_running);

    if (count > 0) return send_all(destination_fd, buffer, (size_t)count);
    if (count == 0) {
        *source_open = false;
        (void)shutdown(destination_fd, SHUT_WR);
        return true;
    }
    return false;
}

static void relay_bidirectional(int client_fd, int upstream_fd) {
    bool client_open = true;
    bool upstream_open = true;
    while (keep_running && (client_open || upstream_open)) {
        struct pollfd descriptors[2] = {
            {.fd = client_fd, .events = client_open ? POLLIN : 0},
            {.fd = upstream_fd, .events = upstream_open ? POLLIN : 0},
        };
        int result;
        do {
            result = poll(descriptors, 2, -1);
        } while (result < 0 && errno == EINTR && keep_running);
        if (result <= 0) break;

        if (client_open && (descriptors[0].revents & POLLIN) != 0 &&
            !relay_once(client_fd, upstream_fd, &client_open)) {
            break;
        }
        if (upstream_open && (descriptors[1].revents & POLLIN) != 0 &&
            !relay_once(upstream_fd, client_fd, &upstream_open)) {
            break;
        }
        if ((descriptors[0].revents & (POLLERR | POLLNVAL)) != 0 ||
            (descriptors[1].revents & (POLLERR | POLLNVAL)) != 0) {
            break;
        }
        if (client_open && (descriptors[0].revents & POLLHUP) != 0 &&
            (descriptors[0].revents & POLLIN) == 0) {
            client_open = false;
            (void)shutdown(upstream_fd, SHUT_WR);
        }
        if (upstream_open && (descriptors[1].revents & POLLHUP) != 0 &&
            (descriptors[1].revents & POLLIN) == 0) {
            upstream_open = false;
            (void)shutdown(client_fd, SHUT_WR);
        }
    }
}

static void unregister_connection(connection_ctx *context) {
    pthread_mutex_lock(&connection_mutex);
    connection_ctx **entry = &connections;
    while (*entry != NULL && *entry != context) entry = &(*entry)->next;
    if (*entry == context) {
        *entry = context->next;
        if (active_connections > 0U) active_connections--;
    }
    context->client_fd = -1;
    context->upstream_fd = -1;
    pthread_cond_broadcast(&connection_cond);
    pthread_mutex_unlock(&connection_mutex);
}

static void *connection_thread(void *argument) {
    connection_ctx *context = (connection_ctx *)argument;
    const int client_fd = context->client_fd;
    int upstream_fd = -1;
    if (keep_running) {
        upstream_fd = connect_forward_target(context);
        pthread_mutex_lock(&connection_mutex);
        context->upstream_fd = upstream_fd;
        if (context->closing && upstream_fd >= 0) (void)shutdown(upstream_fd, SHUT_RDWR);
        pthread_mutex_unlock(&connection_mutex);
        if (upstream_fd >= 0 && keep_running &&
            (!context->use_forward_socket ||
             send_all(upstream_fd, context->forward_header, sizeof(context->forward_header)))) {
            relay_bidirectional(client_fd, upstream_fd);
        }
    }
    /* Remove the descriptors from the shared list before closing to prevent fd reuse races. */
    unregister_connection(context);
    if (upstream_fd >= 0) close(upstream_fd);
    close(client_fd);
    secure_zero(context, sizeof(*context));
    free(context);
    return NULL;
}

static bool register_and_start_connection(int client_fd, const runtime_options *options,
                                          unsigned int max_clients, size_t profile_index,
                                          const unsigned char *forward_header) {
    connection_ctx *context = calloc(1, sizeof(*context));
    pthread_t thread;
    pthread_attr_t attributes;
    int thread_result;
    if (context == NULL) return false;
    context->client_fd = client_fd;
    context->upstream_fd = -1;
    context->forward_port = options->forward_port;
    context->use_forward_socket = options->use_forward_socket;
    if (options->use_forward_socket) {
        memcpy(context->forward_socket, options->forward_socket, sizeof(context->forward_socket));
        memcpy(context->forward_header, forward_header, sizeof(context->forward_header));
    }
    context->profile_index = profile_index;

    pthread_mutex_lock(&connection_mutex);
    if (!keep_running || active_connections >= max_clients) {
        pthread_mutex_unlock(&connection_mutex);
        secure_zero(context, sizeof(*context));
        free(context);
        return false;
    }
    context->next = connections;
    connections = context;
    active_connections++;
    pthread_mutex_unlock(&connection_mutex);

    if (pthread_attr_init(&attributes) != 0) {
        unregister_connection(context);
        secure_zero(context, sizeof(*context));
        free(context);
        return false;
    }
    (void)pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
    thread_result = pthread_create(&thread, &attributes, connection_thread, context);
    pthread_attr_destroy(&attributes);
    if (thread_result != 0) {
        unregister_connection(context);
        secure_zero(context, sizeof(*context));
        free(context);
        return false;
    }
    return true;
}

static void shutdown_connections(void) {
    pthread_mutex_lock(&connection_mutex);
    for (connection_ctx *context = connections; context != NULL; context = context->next) {
        (void)shutdown(context->client_fd, SHUT_RDWR);
        if (context->upstream_fd >= 0) (void)shutdown(context->upstream_fd, SHUT_RDWR);
    }
    while (active_connections > 0U) {
        pthread_cond_wait(&connection_cond, &connection_mutex);
    }
    pthread_mutex_unlock(&connection_mutex);
}

static void signal_handler(int signal_number) {
    const unsigned char value = (unsigned char)signal_number;
    keep_running = 0;
    if (signal_pipe[1] >= 0) {
        const ssize_t ignored = write(signal_pipe[1], &value, sizeof(value));
        (void)ignored;
    }
}

static bool install_signal_handlers(void) {
    struct sigaction action;
    if (pipe2(signal_pipe, O_CLOEXEC | O_NONBLOCK) < 0) return false;
    memset(&action, 0, sizeof(action));
    action.sa_handler = signal_handler;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, NULL) < 0 || sigaction(SIGTERM, &action, NULL) < 0) return false;
    signal(SIGPIPE, SIG_IGN);
    return true;
}

static void close_signal_pipe(void) {
    if (signal_pipe[0] >= 0) close(signal_pipe[0]);
    if (signal_pipe[1] >= 0) close(signal_pipe[1]);
    signal_pipe[0] = -1;
    signal_pipe[1] = -1;
}

static void accept_available_connections(int listener_fd, const runtime_options *options,
                                         const helper_config *config, uint64_t now) {
    unsigned int accepted_in_batch = 0U;
    while (keep_running && accepted_in_batch < 64U) {
        struct sockaddr_storage peer_address;
        socklen_t peer_length = sizeof(peer_address);
        int client_fd = accept4(listener_fd, (struct sockaddr *)&peer_address, &peer_length, SOCK_CLOEXEC);
        if (client_fd >= 0) {
            struct sockaddr_storage local_address;
            unsigned char forward_header[FORWARD_PEER_HEADER_BYTES] = {0};
            const ssize_t profile_index = find_profile_for_peer(config, &peer_address);
            accepted_in_batch++;
            if (profile_index < 0) {
                fprintf(stderr, "tcp-ao-helper: rejected an authenticated connection without a matching profile\n");
                close(client_fd);
                continue;
            }
            if (!reconcile_accepted_socket(client_fd, config, (size_t)profile_index, now)) {
                fprintf(stderr, "tcp-ao-helper: unable to reconcile keys on an accepted socket: %s\n",
                        strerror(errno));
                close(client_fd);
                continue;
            }
            if (options->use_forward_socket) {
                socklen_t local_length = sizeof(local_address);
                memset(&local_address, 0, sizeof(local_address));
                if (getsockname(client_fd, (struct sockaddr *)&local_address, &local_length) < 0 ||
                    !build_forward_peer_header(forward_header, &peer_address, &local_address,
                                               config->forward_capability)) {
                    fprintf(stderr, "tcp-ao-helper: unable to encode authenticated peer metadata\n");
                    secure_zero(forward_header, sizeof(forward_header));
                    close(client_fd);
                    continue;
                }
            }
            if (!register_and_start_connection(client_fd, options, options->max_clients,
                                               (size_t)profile_index, forward_header)) {
                close(client_fd);
            }
            secure_zero(forward_header, sizeof(forward_header));
            continue;
        }
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) return;
        if (keep_running) fprintf(stderr, "tcp-ao-helper: accept failed: %s\n", strerror(errno));
        return;
    }
}

static int run_accept_loop(int ipv4_listener, int ipv6_listener, const runtime_options *options,
                           helper_config *config, uint64_t initial_wall_time) {
    uint64_t last_wall_time = initial_wall_time;
    while (keep_running) {
        struct pollfd descriptors[3];
        nfds_t count = 0;
        int ipv4_index = -1;
        int ipv6_index = -1;
        int signal_index;

        if (ipv4_listener >= 0) {
            ipv4_index = (int)count;
            descriptors[count++] = (struct pollfd){.fd = ipv4_listener, .events = POLLIN};
        }
        if (ipv6_listener >= 0) {
            ipv6_index = (int)count;
            descriptors[count++] = (struct pollfd){.fd = ipv6_listener, .events = POLLIN};
        }
        signal_index = (int)count;
        descriptors[count++] = (struct pollfd){.fd = signal_pipe[0], .events = POLLIN};

        struct timespec realtime;
        int rotation_timeout_ms = ROTATION_INTERVAL_MS;
        if (clock_gettime(CLOCK_REALTIME, &realtime) == 0) {
            const long remaining_nanoseconds = 1000000000L - realtime.tv_nsec;
            const long rounded_milliseconds = (remaining_nanoseconds + 999999L) / 1000000L;
            if (rounded_milliseconds >= 1L && rounded_milliseconds <= ROTATION_INTERVAL_MS) {
                rotation_timeout_ms = (int)rounded_milliseconds;
            }
        }
        const int result = poll(descriptors, count, rotation_timeout_ms);
        if (result < 0) {
            if (errno == EINTR) continue;
            fprintf(stderr, "tcp-ao-helper: runtime poll failed: %s\n", strerror(errno));
            return EXIT_FAILURE;
        }
        if ((descriptors[signal_index].revents & POLLIN) != 0) break;
        const time_t now_time = time(NULL);
        if (now_time < 0) {
            fprintf(stderr, "tcp-ao-helper: system clock is unavailable\n");
            return EXIT_TCP_AO_CLOCK_UNAVAILABLE;
        }
        const uint64_t now = (uint64_t)now_time;
        /* Never resurrect an expired MKT or switch current backwards after a wall-clock rollback. */
        if (!advance_wall_clock(&last_wall_time, now)) {
            fprintf(stderr, "tcp-ao-helper: system clock moved backwards; stopping fail-closed\n");
            return EXIT_TCP_AO_CLOCK_ROLLBACK;
        }
        int rotation_exit_code = EXIT_TCP_AO_ROTATION_FAILED;
        if (!rotate_tcp_ao_keys(config, ipv4_listener, ipv6_listener, now, &rotation_exit_code)) {
            return rotation_exit_code;
        }
        if (ipv4_index >= 0 && (descriptors[ipv4_index].revents & POLLIN) != 0) {
            accept_available_connections(ipv4_listener, options, config, now);
        }
        if (ipv6_index >= 0 && (descriptors[ipv6_index].revents & POLLIN) != 0) {
            accept_available_connections(ipv6_listener, options, config, now);
        }
    }
    return EXIT_SUCCESS;
}

static bool parse_port(const char *value, uint16_t *port) {
    char *end = NULL;
    unsigned long parsed;
    if (value == NULL || *value == '\0') return false;
    errno = 0;
    parsed = strtoul(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed == 0U || parsed > UINT16_MAX) return false;
    *port = (uint16_t)parsed;
    return true;
}

static bool parse_forward_socket_path(const char *value, char *output, size_t capacity) {
    const size_t length = value == NULL ? 0U : strlen(value);
    if (length == 0U || value[0] != '/' || length >= capacity) return false;
    memcpy(output, value, length + 1U);
    return true;
}

static bool parse_bounded_unsigned(const char *value, unsigned int minimum, unsigned int maximum,
                                   unsigned int *result) {
    char *end = NULL;
    unsigned long parsed;
    if (value == NULL || *value == '\0') return false;
    errno = 0;
    parsed = strtoul(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0' || parsed < minimum || parsed > maximum) return false;
    *result = (unsigned int)parsed;
    return true;
}

static void print_usage(FILE *stream) {
    fprintf(stream,
            "Usage: tcp-ao-helper --parent-pid PID --listen-port PORT "
            "(--forward-socket PATH | --forward-port PORT) [options]\n"
            "\n"
            "Required options:\n"
            "  --parent-pid PID       Expected direct parent process ID\n"
            "  --listen-port PORT    Public TCP-AO port (1-65535)\n"
            "  --forward-socket PATH Private internal protocol Unix socket\n"
            "  --forward-port PORT   Test-only internal protocol port on 127.0.0.1\n"
            "\n"
            "Optional:\n"
            "  --max-clients COUNT   Concurrent client limit (default 256)\n"
            "  --backlog COUNT       TCP listen backlog (default 128)\n"
            "  --version             Print helper version and exit\n"
            "  --help                Show this help\n"
            "\n"
            "Key configuration must be supplied as one JSON object on stdin.\n");
}

static int parse_options(int argc, char **argv, runtime_options *options) {
    enum {
        OPTION_PARENT_PID = 1000,
        OPTION_LISTEN_PORT,
        OPTION_FORWARD_SOCKET,
        OPTION_FORWARD_PORT,
        OPTION_MAX_CLIENTS,
        OPTION_BACKLOG
    };
    static const struct option long_options[] = {
        {"parent-pid", required_argument, NULL, OPTION_PARENT_PID},
        {"listen-port", required_argument, NULL, OPTION_LISTEN_PORT},
        {"forward-socket", required_argument, NULL, OPTION_FORWARD_SOCKET},
        {"forward-port", required_argument, NULL, OPTION_FORWARD_PORT},
        {"max-clients", required_argument, NULL, OPTION_MAX_CLIENTS},
        {"backlog", required_argument, NULL, OPTION_BACKLOG},
        {"version", no_argument, NULL, 'v'},
        {"help", no_argument, NULL, 'h'},
        {NULL, 0, NULL, 0},
    };
    bool have_parent_pid = false;
    bool have_listen_port = false;
    bool have_forward_socket = false;
    bool have_forward_port = false;
    int option;
    memset(options, 0, sizeof(*options));
    options->max_clients = DEFAULT_MAX_CLIENTS;
    options->backlog = DEFAULT_BACKLOG;

    while ((option = getopt_long(argc, argv, "vh", long_options, NULL)) != -1) {
        unsigned int value;
        switch (option) {
            case OPTION_PARENT_PID:
                if (have_parent_pid ||
                    !parse_bounded_unsigned(optarg, 1U, (unsigned int)INT_MAX, &value)) {
                    return -1;
                }
                options->expected_parent_pid = (pid_t)value;
                have_parent_pid = true;
                break;
            case OPTION_LISTEN_PORT:
                if (have_listen_port || !parse_port(optarg, &options->listen_port)) return -1;
                have_listen_port = true;
                break;
            case OPTION_FORWARD_SOCKET:
                if (have_forward_socket ||
                    !parse_forward_socket_path(optarg, options->forward_socket,
                                               sizeof(options->forward_socket))) {
                    return -1;
                }
                options->use_forward_socket = true;
                have_forward_socket = true;
                break;
            case OPTION_FORWARD_PORT:
                if (have_forward_port || !parse_port(optarg, &options->forward_port)) return -1;
                have_forward_port = true;
                break;
            case OPTION_MAX_CLIENTS:
                if (!parse_bounded_unsigned(optarg, 1U, MAX_CLIENTS_LIMIT, &options->max_clients)) return -1;
                break;
            case OPTION_BACKLOG:
                if (!parse_bounded_unsigned(optarg, 1U, 65535U, &value)) return -1;
                options->backlog = (int)value;
                break;
            case 'v':
                printf("netnexus-tcp-ao-helper %s\n", NETNEXUS_TCP_AO_HELPER_VERSION);
                return 1;
            case 'h':
                print_usage(stdout);
                return 1;
            default:
                return -1;
        }
    }
    if (optind != argc || !have_parent_pid || !have_listen_port ||
        have_forward_socket == have_forward_port ||
        (have_forward_port && options->listen_port == options->forward_port)) {
        return -1;
    }
    return 0;
}

static bool bind_to_parent(pid_t expected_parent_pid) {
    /*
     * PR_SET_PDEATHSIG does not fire retroactively. Setting it before checking
     * getppid() closes the race where the parent exits between spawn and this
     * initialization: either SIGTERM is delivered, or the PID comparison fails.
     */
    if (prctl(PR_SET_PDEATHSIG, SIGTERM, 0, 0, 0) < 0) return false;
    if (getppid() != expected_parent_pid) {
        errno = ESRCH;
        return false;
    }
    bound_parent_pid = expected_parent_pid;
    bound_parent_uid = getuid();
    return true;
}

static void harden_process(void) {
    struct rlimit core_limit = {.rlim_cur = 0, .rlim_max = 0};
    (void)setrlimit(RLIMIT_CORE, &core_limit);
    (void)prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
}

int main(int argc, char **argv) {
    runtime_options options;
    helper_config config = {0};
    char *stdin_buffer = NULL;
    size_t stdin_length = 0;
    const char *config_error = NULL;
    int ipv4_listener = -1;
    int ipv6_listener = -1;
    size_t ipv4_profile_count;
    size_t ipv6_profile_count;
    size_t installed_key_count = 0U;
    time_t now_time;
    uint64_t last_wall_time;
    int option_result;
    int exit_code = EXIT_FAILURE;

    setvbuf(stdout, NULL, _IOLBF, 0);
    option_result = parse_options(argc, argv, &options);
    if (option_result > 0) return EXIT_SUCCESS;
    if (option_result < 0) {
        emit_error_status("INVALID_ARGUMENTS", "invalid tcp-ao-helper arguments");
        return EXIT_FAILURE;
    }

    if (!bind_to_parent(options.expected_parent_pid)) {
        emit_error_status("PARENT_PROCESS_INVALID", "unable to bind TCP-AO helper to its parent process");
        return EXIT_FAILURE;
    }
    harden_process();
    if (!read_stdin_config(&stdin_buffer, &stdin_length, &config_error)) {
        emit_error_status("CONFIG_READ_FAILED", "unable to read TCP-AO configuration from stdin");
        goto cleanup;
    }
    if (!parse_config_json(stdin_buffer, stdin_length, &config, &config_error)) {
        /* Detailed parser errors intentionally stay off stdout and never include values. */
        fprintf(stderr, "tcp-ao-helper: invalid configuration: %s\n",
                config_error == NULL ? "invalid JSON" : config_error);
        emit_error_status("CONFIG_INVALID", "invalid TCP-AO configuration");
        goto cleanup;
    }
    if ((options.use_forward_socket &&
         (config.schema_version != 2U || !config.have_forward_capability)) ||
        (!options.use_forward_socket &&
         (config.schema_version != 1U || config.have_forward_capability))) {
        emit_error_status("CONFIG_INVALID", "TCP-AO forwarding configuration does not match its schema");
        goto cleanup;
    }
    release_stdin_buffer(stdin_buffer);
    stdin_buffer = NULL;
    close(STDIN_FILENO);

    last_wall_time = config.validated_at;
    now_time = time(NULL);
    if (now_time < 0 || !advance_wall_clock(&last_wall_time, (uint64_t)now_time)) {
        emit_error_status("CLOCK_UNAVAILABLE", "system clock is unavailable");
        goto cleanup;
    }
    ipv4_profile_count = count_family_profiles(&config, AF_INET);
    ipv6_profile_count = count_family_profiles(&config, AF_INET6);
    if (ipv4_profile_count > 0U) {
        ipv4_listener = create_listener_socket(AF_INET);
        if (ipv4_listener < 0 ||
            configure_listener(ipv4_listener, AF_INET, &config, (uint64_t)now_time, &installed_key_count) < 0) {
            fprintf(stderr, "tcp-ao-helper: unable to configure IPv4 TCP-AO listener: %s\n", strerror(errno));
            emit_error_status(errno == ENOPROTOOPT ? "TCP_AO_UNSUPPORTED" : "TCP_AO_CONFIG_FAILED",
                              "unable to configure IPv4 TCP-AO listener");
            goto cleanup;
        }
    }
    if (ipv6_profile_count > 0U) {
        ipv6_listener = create_listener_socket(AF_INET6);
        if (ipv6_listener < 0 ||
            configure_listener(ipv6_listener, AF_INET6, &config, (uint64_t)now_time, &installed_key_count) < 0) {
            fprintf(stderr, "tcp-ao-helper: unable to configure IPv6 TCP-AO listener: %s\n", strerror(errno));
            emit_error_status(errno == ENOPROTOOPT ? "TCP_AO_UNSUPPORTED" : "TCP_AO_CONFIG_FAILED",
                              "unable to configure IPv6 TCP-AO listener");
            goto cleanup;
        }
    }

    if (ipv4_listener >= 0 &&
        bind_and_listen(ipv4_listener, AF_INET, options.listen_port, options.backlog) < 0) {
        fprintf(stderr, "tcp-ao-helper: unable to bind IPv4 listener: %s\n", strerror(errno));
        emit_error_status("LISTEN_FAILED", "unable to bind IPv4 TCP-AO listener");
        goto cleanup;
    }
    if (ipv6_listener >= 0 &&
        bind_and_listen(ipv6_listener, AF_INET6, options.listen_port, options.backlog) < 0) {
        fprintf(stderr, "tcp-ao-helper: unable to bind IPv6 listener: %s\n", strerror(errno));
        emit_error_status("LISTEN_FAILED", "unable to bind IPv6 TCP-AO listener");
        goto cleanup;
    }
    if (!install_signal_handlers()) {
        fprintf(stderr, "tcp-ao-helper: unable to install signal handlers: %s\n", strerror(errno));
        emit_error_status("SIGNAL_SETUP_FAILED", "unable to initialize TCP-AO helper runtime");
        goto cleanup;
    }

    now_time = time(NULL);
    if (now_time < 0 || !advance_wall_clock(&last_wall_time, (uint64_t)now_time) ||
        !rotate_tcp_ao_keys(&config, ipv4_listener, ipv6_listener, (uint64_t)now_time, NULL)) {
        if (now_time < 0 || (now_time >= 0 && (uint64_t)now_time < last_wall_time)) {
            fprintf(stderr, "tcp-ao-helper: system clock is unavailable or moved backwards\n");
        }
        emit_error_status("TCP_AO_ROTATION_FAILED", "unable to initialize TCP-AO key rotation");
        goto cleanup;
    }
    installed_key_count = count_installed_keys(&config);

    fprintf(stdout, "{\"status\":\"ready\",\"pid\":%ld,\"listenPort\":%u,", (long)getpid(),
            (unsigned int)options.listen_port);
    if (options.use_forward_socket) {
        fprintf(stdout,
                "\"forwardTransport\":\"unix\",\"peerHeaderVersion\":%u,\"peerHeaderBytes\":%u,",
                FORWARD_PEER_HEADER_VERSION, FORWARD_PEER_HEADER_BYTES);
    } else {
        fprintf(stdout, "\"forwardTransport\":\"tcp\",\"forwardHost\":\"127.0.0.1\",\"forwardPort\":%u,",
                (unsigned int)options.forward_port);
    }
    fprintf(stdout,
            "\"families\":[%s%s%s],\"profileCount\":%zu,\"keyCount\":%zu,"
            "\"installedKeyCount\":%zu,\"rotationIntervalMs\":%d,"
            "\"activeSocketKeyUpdates\":\"close-on-unsupported\","
            "\"finalExpiryPolicy\":\"fail-closed\",\"aoRequired\":true}\n",
            ipv4_listener >= 0 ? "\"ipv4\"" : "", ipv4_listener >= 0 && ipv6_listener >= 0 ? "," : "",
            ipv6_listener >= 0 ? "\"ipv6\"" : "", config.profile_count, config.key_count,
            installed_key_count, ROTATION_INTERVAL_MS);
    fflush(stdout);

    exit_code = run_accept_loop(ipv4_listener, ipv6_listener, &options, &config, last_wall_time);

cleanup:
    keep_running = 0;
    if (ipv4_listener >= 0) close(ipv4_listener);
    if (ipv6_listener >= 0) close(ipv6_listener);
    shutdown_connections();
    close_signal_pipe();
    destroy_config(&config);
    release_stdin_buffer(stdin_buffer);
    return exit_code;
}
