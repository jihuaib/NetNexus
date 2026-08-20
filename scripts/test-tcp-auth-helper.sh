#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"

"${script_dir}/build-tcp-auth-helper.sh" >/dev/null

case "$(uname -m)" in
    x86_64 | amd64) helper_arch="x64" ;;
    aarch64 | arm64) helper_arch="arm64" ;;
    *) echo "unsupported test architecture" >&2; exit 1 ;;
esac

helper="${project_root}/resources/tcp-auth/linux-${helper_arch}/tcp-auth-helper"
temporary_dir="$(mktemp -d)"
native_driver="${temporary_dir}/tcp-auth-native-test"
helper_stdout="${temporary_dir}/helper.stdout"
helper_stderr="${temporary_dir}/helper.stderr"
echo_stdout="${temporary_dir}/echo.stdout"
echo_stderr="${temporary_dir}/echo.stderr"
helper_pid=""
echo_pid=""
unix_echo_pid=""
watchdog_pid=""
parent_test_pid=""
parent_test_helper_pid=""
helper_control_fd=""
reload_client_pid=""

cleanup() {
    if [[ -n "${reload_client_pid}" ]] && kill -0 "${reload_client_pid}" 2>/dev/null; then
        kill -TERM "${reload_client_pid}" 2>/dev/null || true
        wait "${reload_client_pid}" 2>/dev/null || true
    fi
    if [[ -n "${watchdog_pid}" ]] && kill -0 "${watchdog_pid}" 2>/dev/null; then
        kill -TERM "${watchdog_pid}" 2>/dev/null || true
        wait "${watchdog_pid}" 2>/dev/null || true
    fi
    if [[ -n "${parent_test_pid}" ]] && kill -0 "${parent_test_pid}" 2>/dev/null; then
        kill -TERM "${parent_test_pid}" 2>/dev/null || true
        wait "${parent_test_pid}" 2>/dev/null || true
    fi
    if [[ -n "${parent_test_helper_pid}" ]] && kill -0 "${parent_test_helper_pid}" 2>/dev/null; then
        kill -TERM "${parent_test_helper_pid}" 2>/dev/null || true
    fi
    if [[ -n "${helper_pid}" ]] && kill -0 "${helper_pid}" 2>/dev/null; then
        kill -CONT "${helper_pid}" 2>/dev/null || true
        kill -TERM "${helper_pid}" 2>/dev/null || true
        wait "${helper_pid}" 2>/dev/null || true
    fi
    if [[ -n "${helper_control_fd}" ]]; then
        exec {helper_control_fd}>&-
        helper_control_fd=""
    fi
    if [[ -n "${echo_pid}" ]] && kill -0 "${echo_pid}" 2>/dev/null; then
        kill -TERM "${echo_pid}" 2>/dev/null || true
        wait "${echo_pid}" 2>/dev/null || true
    fi
    if [[ -n "${unix_echo_pid}" ]] && kill -0 "${unix_echo_pid}" 2>/dev/null; then
        kill -TERM "${unix_echo_pid}" 2>/dev/null || true
        wait "${unix_echo_pid}" 2>/dev/null || true
    fi
    rm -rf -- "${temporary_dir}"
}
trap cleanup EXIT HUP INT TERM

cc \
    -std=c11 -O2 -D_FORTIFY_SOURCE=3 -fPIE -pie -pthread \
    -Wall -Wextra -Wpedantic -Werror -Wformat=2 -Wshadow -Wconversion -Wsign-conversion \
    -fstack-protector-strong -Wl,-z,relro,-z,now -Wl,-z,noexecstack \
    "${script_dir}/test-tcp-auth-helper-native.c" -o "${native_driver}"

schema_stdout="${temporary_dir}/schema.stdout"
schema_stderr="${temporary_dir}/schema.stderr"
parent_validation_stdout="${temporary_dir}/parent-validation.stdout"
parent_validation_stderr="${temporary_dir}/parent-validation.stderr"
wrong_parent_pid=1
if [[ "$$" -eq 1 ]]; then wrong_parent_pid=2; fi
set +e
"${helper}" --parent-pid "${wrong_parent_pid}" --listen-port 55001 --forward-port 55002 \
    </dev/null >"${parent_validation_stdout}" 2>"${parent_validation_stderr}"
parent_validation_status=$?
set -e
if [[ "${parent_validation_status}" -eq 0 ]] ||
    ! grep -q '"code":"PARENT_PROCESS_INVALID"' "${parent_validation_stdout}"; then
    echo "helper accepted a mismatched expected parent PID" >&2
    exit 1
fi

set +e
printf '%s\n' '{"profiles":[{"peer":"127.0.0.1/32","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"schema-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}' | \
    "${helper}" --parent-pid "$$" --listen-port 55001 --forward-port 55002 \
        >"${schema_stdout}" 2>"${schema_stderr}"
schema_status=$?
set -e
if [[ "${schema_status}" -eq 0 ]] || ! grep -q '"code":"CONFIG_INVALID"' "${schema_stdout}"; then
    echo "helper accepted configuration without schemaVersion 1" >&2
    exit 1
fi

"${native_driver}" echo-auto >"${echo_stdout}" 2>"${echo_stderr}" &
echo_pid=$!
for _ in $(seq 1 100); do
    if grep -Eq '^echo-ready [0-9]+$' "${echo_stdout}"; then break; fi
    if ! kill -0 "${echo_pid}" 2>/dev/null; then
        echo "echo test server exited during startup" >&2
        exit 1
    fi
    sleep 0.05
done
grep -Eq '^echo-ready [0-9]+$' "${echo_stdout}"
forward_port="$(awk '/^echo-ready [0-9]+$/ { print $2; exit }' "${echo_stdout}")"
listen_port="$("${native_driver}" pick-port)"

start_helper() {
    local config="$1"
    : >"${helper_stdout}"
    : >"${helper_stderr}"
    printf '%s\n' "${config}" | "${helper}" \
        --parent-pid "$$" \
        --listen-port "${listen_port}" \
        --forward-port "${forward_port}" \
        --max-clients 32 \
        --backlog 32 \
        >"${helper_stdout}" 2>"${helper_stderr}" &
    helper_pid=$!

    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${helper_stdout}"; then return; fi
        if ! kill -0 "${helper_pid}" 2>/dev/null; then
            wait "${helper_pid}" 2>/dev/null || true
            echo "helper exited during startup" >&2
            sed -n '1,5p' "${helper_stdout}" >&2
            sed -n '1,5p' "${helper_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    echo "helper startup timed out" >&2
    exit 1
}

start_helper_unix() {
    local config="$1"
    local forward_socket="$2"
    : >"${helper_stdout}"
    : >"${helper_stderr}"
    printf '%s\n' "${config}" | "${helper}" \
        --parent-pid "$$" \
        --listen-port "${listen_port}" \
        --forward-socket "${forward_socket}" \
        --max-clients 32 \
        --backlog 32 \
        >"${helper_stdout}" 2>"${helper_stderr}" &
    helper_pid=$!

    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${helper_stdout}"; then return; fi
        if ! kill -0 "${helper_pid}" 2>/dev/null; then
            wait "${helper_pid}" 2>/dev/null || true
            echo "helper exited during Unix-forward startup" >&2
            sed -n '1,5p' "${helper_stdout}" >&2
            sed -n '1,5p' "${helper_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    echo "helper Unix-forward startup timed out" >&2
    exit 1
}

start_reloadable_helper() {
    local config="$1"
    local control_fifo="${temporary_dir}/helper-control.fifo"
    : >"${helper_stdout}"
    : >"${helper_stderr}"
    rm -f -- "${control_fifo}"
    mkfifo "${control_fifo}"
    exec {helper_control_fd}<>"${control_fifo}"
    "${helper}" \
        --parent-pid "$$" \
        --listen-port "${listen_port}" \
        --forward-port "${forward_port}" \
        --max-clients 32 \
        --backlog 32 \
        <&"${helper_control_fd}" >"${helper_stdout}" 2>"${helper_stderr}" &
    helper_pid=$!
    printf '%s\n' "${config}" >&"${helper_control_fd}"

    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${helper_stdout}"; then return; fi
        if ! kill -0 "${helper_pid}" 2>/dev/null; then
            wait "${helper_pid}" 2>/dev/null || true
            echo "reloadable helper exited during startup" >&2
            sed -n '1,8p' "${helper_stdout}" >&2
            sed -n '1,8p' "${helper_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    echo "reloadable helper startup timed out" >&2
    exit 1
}

send_reload_request() {
    local request="$1"
    local request_id="$2"
    local expected_pattern="$3"
    printf '%s\n' "${request}" >&"${helper_control_fd}"
    for _ in $(seq 1 200); do
        if grep -Eq "\"requestId\":${request_id}.*${expected_pattern}" "${helper_stdout}"; then return; fi
        if ! kill -0 "${helper_pid}" 2>/dev/null; then
            echo "helper exited while processing reload request ${request_id}" >&2
            sed -n '1,12p' "${helper_stdout}" >&2
            sed -n '1,12p' "${helper_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    echo "reload request ${request_id} timed out" >&2
    sed -n '1,12p' "${helper_stdout}" >&2
    exit 1
}

stop_helper() {
    if [[ -z "${helper_pid}" ]]; then return; fi
    kill -CONT "${helper_pid}" 2>/dev/null || true
    kill -TERM "${helper_pid}"
    wait "${helper_pid}"
    helper_pid=""
    if [[ -n "${helper_control_fd}" ]]; then
        exec {helper_control_fd}>&-
        helper_control_fd=""
    fi
}

test_parent_death_cleanup() {
    local config="$1"
    local child_pid_file="${temporary_dir}/parent-death-helper.pid"
    local child_stdout="${temporary_dir}/parent-death-helper.stdout"
    local child_stderr="${temporary_dir}/parent-death-helper.stderr"
    local child_state=""
    : >"${child_stdout}"
    : >"${child_stderr}"

    (
        parent_pid="${BASHPID}"
        "${helper}" \
            --parent-pid "${parent_pid}" \
            --listen-port "${listen_port}" \
            --forward-port "${forward_port}" \
            --max-clients 32 \
            --backlog 32 \
            >"${child_stdout}" 2>"${child_stderr}" <<<"${config}" &
        child_pid=$!
        printf '%s\n' "${child_pid}" >"${child_pid_file}"
        wait "${child_pid}"
    ) &
    parent_test_pid=$!

    for _ in $(seq 1 200); do
        if [[ -s "${child_pid_file}" ]]; then
            parent_test_helper_pid="$(head -n 1 "${child_pid_file}")"
            break
        fi
        if ! kill -0 "${parent_test_pid}" 2>/dev/null; then
            echo "parent-death fixture exited before publishing helper PID" >&2
            exit 1
        fi
        sleep 0.05
    done
    if [[ -z "${parent_test_helper_pid}" ]]; then
        echo "parent-death fixture did not publish helper PID" >&2
        exit 1
    fi

    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${child_stdout}"; then break; fi
        if ! kill -0 "${parent_test_helper_pid}" 2>/dev/null; then
            echo "parent-death helper exited during startup" >&2
            sed -n '1,5p' "${child_stdout}" >&2
            sed -n '1,5p' "${child_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    grep -q '"status":"ready"' "${child_stdout}"
    if [[ "$(awk '/^PPid:/ { print $2 }' "/proc/${parent_test_helper_pid}/status")" != "${parent_test_pid}" ]]; then
        echo "helper is not a direct child of the parent-death fixture" >&2
        exit 1
    fi

    kill -KILL "${parent_test_pid}"
    set +e
    wait "${parent_test_pid}" 2>/dev/null
    set -e
    parent_test_pid=""

    for _ in $(seq 1 200); do
        if [[ ! -e "/proc/${parent_test_helper_pid}/status" ]]; then break; fi
        child_state="$(awk '/^State:/ { print $2 }' "/proc/${parent_test_helper_pid}/status" 2>/dev/null || true)"
        if [[ "${child_state}" == "Z" ]]; then break; fi
        sleep 0.05
    done
    if [[ -e "/proc/${parent_test_helper_pid}/status" ]]; then
        child_state="$(awk '/^State:/ { print $2 }' "/proc/${parent_test_helper_pid}/status" 2>/dev/null || true)"
        if [[ "${child_state}" != "Z" ]]; then
            echo "helper survived after its expected parent was killed" >&2
            exit 1
        fi
    fi
    parent_test_helper_pid=""
    echo "parent-death-cleanup-ok"
}

sha1_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.1/32","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
test_parent_death_cleanup "${sha1_config}"
# Reusing the same port proves the dead helper released its listener.
start_helper "${sha1_config}"
grep -q '"aoRequired":true' "${helper_stdout}"
if tr '\0' '\n' <"/proc/${helper_pid}/cmdline" | grep -q 'netnexus-native-test-key'; then
    echo "key material leaked into helper argv" >&2
    exit 1
fi
if grep -q 'netnexus-native-test-key' "${helper_stdout}" "${helper_stderr}"; then
    echo "key material leaked into helper output" >&2
    exit 1
fi
"${native_driver}" connect "${listen_port}" correct 'hmac(sha1)' 4
"${native_driver}" connect "${listen_port}" wrong 'hmac(sha1)' 4
"${native_driver}" connect "${listen_port}" none 'hmac(sha1)' 4
stop_helper

multi_profile_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.1/32","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]},{"peer":"127.0.0.2/32","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_helper "${multi_profile_config}"
grep -q '"profileCount":2' "${helper_stdout}"
grep -q '"keyCount":2' "${helper_stdout}"
"${native_driver}" connect "${listen_port}" correct 'hmac(sha1)' 4
stop_helper

# Exercise TCP_AO_GET_KEYS array stride/count handling with two receive-valid
# MKTs inherited by one accepted socket.
dual_key_now="$(date +%s)"
dual_key_switch=$((dual_key_now + 30))
dual_key_accept_end=$((dual_key_switch + 5))
dual_key_config="{\"schemaVersion\":1,\"profiles\":[{\"peer\":\"127.0.0.0/8\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-rotation-key-one\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":${dual_key_switch},\"acceptEnd\":${dual_key_accept_end}},{\"algorithm\":\"hmac(sha1)\",\"sndId\":2,\"rcvId\":2,\"key\":\"netnexus-rotation-key-two\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":${dual_key_switch},\"sendEnd\":0,\"acceptEnd\":0}]}]}"
start_helper "${dual_key_config}"
grep -q '"installedKeyCount":2' "${helper_stdout}"
"${native_driver}" dual-key-connect "${listen_port}"
stop_helper

sha256_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.1/32","keys":[{"algorithm":"hmac(sha256)","sndId":1,"rcvId":1,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_helper "${sha256_config}"
"${native_driver}" connect "${listen_port}" correct 'hmac(sha256)' 4
stop_helper

cmac_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.1/32","keys":[{"algorithm":"cmac(aes)","sndId":1,"rcvId":1,"key":"0123456789abcdef","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_helper "${cmac_config}"
"${native_driver}" connect "${listen_port}" correct 'cmac(aes128)' 4
stop_helper

ipv6_config='{"schemaVersion":1,"profiles":[{"peer":"::1/128","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_helper "${ipv6_config}"
"${native_driver}" connect "${listen_port}" correct 'hmac(sha1)' 6
stop_helper

md5_config='{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"127.0.0.1/32","key":"netnexus-native-md5-key"}]}'
start_helper "${md5_config}"
grep -q '"authentication":"tcp-md5"' "${helper_stdout}"
grep -q '"md5Configured":true' "${helper_stdout}"
grep -q '"profileCount":1' "${helper_stdout}"
grep -q '"keyCount":1' "${helper_stdout}"
if tr '\0' '\n' <"/proc/${helper_pid}/cmdline" | grep -q 'netnexus-native-md5-key'; then
    echo "TCP-MD5 key material leaked into helper argv" >&2
    exit 1
fi
if grep -q 'netnexus-native-md5-key' "${helper_stdout}" "${helper_stderr}"; then
    echo "TCP-MD5 key material leaked into helper output" >&2
    exit 1
fi
"${native_driver}" md5-connect "${listen_port}" correct 4
"${native_driver}" md5-connect "${listen_port}" wrong 4
"${native_driver}" md5-connect "${listen_port}" none 4
stop_helper

md5_ipv6_config='{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"::1/128","key":"netnexus-native-md5-key"}]}'
start_helper "${md5_ipv6_config}"
"${native_driver}" md5-connect "${listen_port}" correct 6
"${native_driver}" md5-connect "${listen_port}" wrong 6
"${native_driver}" md5-connect "${listen_port}" none 6
stop_helper

md5_cidr_config='{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"127.0.0.0/8","key":"netnexus-native-md5-key"}]}'
start_helper "${md5_cidr_config}"
"${native_driver}" md5-connect "${listen_port}" correct 4
stop_helper

md5_unmatched_config='{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"127.0.0.2/32","key":"netnexus-native-md5-key"}]}'
start_helper "${md5_unmatched_config}"
"${native_driver}" unmatched-connect "${listen_port}" 4
stop_helper

md5_max_key='01234567890123456789012345678901234567890123456789012345678901234567890123456789'
md5_max_config="{\"schemaVersion\":3,\"authType\":\"tcp-md5\",\"profiles\":[{\"peer\":\"127.0.0.1/32\",\"key\":\"${md5_max_key}\"}]}"
start_helper "${md5_max_config}"
"${native_driver}" md5-connect "${listen_port}" max 4
stop_helper

assert_md5_config_invalid() {
    local config="$1"
    local reason="$2"
    set +e
    printf '%s\n' "${config}" | "${helper}" \
        --parent-pid "$$" --listen-port "${listen_port}" --forward-port "${forward_port}" \
        >"${schema_stdout}" 2>"${schema_stderr}"
    local status=$?
    set -e
    if [[ "${status}" -eq 0 ]] || ! grep -q '"code":"CONFIG_INVALID"' "${schema_stdout}"; then
        echo "helper accepted invalid TCP-MD5 configuration: ${reason}" >&2
        sed -n '1,5p' "${schema_stdout}" >&2
        sed -n '1,5p' "${schema_stderr}" >&2
        exit 1
    fi
}

assert_md5_config_invalid \
    '{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"127.0.0.1/32","key":""}]}' \
    'empty key'
assert_md5_config_invalid \
    "{\"schemaVersion\":3,\"authType\":\"tcp-md5\",\"profiles\":[{\"peer\":\"127.0.0.1/32\",\"key\":\"${md5_max_key}x\"}]}" \
    '81-byte key'
assert_md5_config_invalid \
    '{"schemaVersion":3,"authType":"tcp-ao","profiles":[{"peer":"127.0.0.1/32","key":"netnexus-native-md5-key"}]}' \
    'schema/auth mismatch'
assert_md5_config_invalid \
    '{"schemaVersion":3,"authType":"tcp-md5","profiles":[{"peer":"127.0.0.1/32","key":"netnexus-native-md5-key","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"ao-key"}]}]}' \
    'mixed AO and MD5 key fields'
assert_md5_config_invalid \
    '{"schemaVersion":3,"authType":"tcp-md5","forwardCapability":"00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f","profiles":[{"peer":"127.0.0.1/32","key":"netnexus-native-md5-key"}]}' \
    'test TCP transport with a Unix capability'

set +e
printf '%s\n' "${md5_config}" | "${helper}" \
    --parent-pid "$$" --listen-port "${listen_port}" \
    --forward-socket "${temporary_dir}/missing-md5-capability.sock" \
    >"${schema_stdout}" 2>"${schema_stderr}"
md5_missing_capability_status=$?
set -e
if [[ "${md5_missing_capability_status}" -eq 0 ]] ||
    ! grep -q '"code":"CONFIG_INVALID"' "${schema_stdout}"; then
    echo "helper accepted TCP-MD5 Unix configuration without a capability" >&2
    exit 1
fi

test_v2_unix_metadata() {
    local family="$1"
    local peer="$2"
    local forward_socket="${temporary_dir}/forward-${family}.sock"
    local unix_stdout="${temporary_dir}/unix-${family}.stdout"
    local unix_stderr="${temporary_dir}/unix-${family}.stderr"
    local capability='00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f'
    local config
    config="{\"schemaVersion\":2,\"forwardCapability\":\"${capability}\",\"profiles\":[{\"peer\":\"${peer}\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-native-test-key\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":0,\"acceptEnd\":0}]}]}"

    : >"${unix_stdout}"
    : >"${unix_stderr}"
    printf '%s\n' "${config}" | "${native_driver}" unix-supervise "${helper}" "${forward_socket}" \
        "${capability}" "${family}" "${listen_port}" "${listen_port}" \
        >"${unix_stdout}" 2>"${unix_stderr}" &
    unix_echo_pid=$!
    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then
            wait "${unix_echo_pid}" 2>/dev/null || true
            echo "Unix metadata supervisor exited during startup" >&2
            sed -n '1,5p' "${unix_stdout}" >&2
            sed -n '1,5p' "${unix_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    grep -q '^unix-supervisor-ready$' "${unix_stdout}"
    grep -q '"status":"ready"' "${unix_stdout}"

    grep -q '"forwardTransport":"unix"' "${unix_stdout}"
    grep -q '"peerHeaderVersion":1' "${unix_stdout}"
    grep -q '"peerHeaderBytes":80' "${unix_stdout}"
    "${native_driver}" connect "${listen_port}" correct 'hmac(sha1)' "${family}"

    for _ in $(seq 1 100); do
        if grep -q "^unix-forward-metadata-ok-${family}$" "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then break; fi
        sleep 0.05
    done
    if ! grep -q "^unix-forward-metadata-ok-${family}$" "${unix_stdout}"; then
        echo "Unix forward header did not contain the expected IPv${family} metadata" >&2
        sed -n '1,5p' "${unix_stderr}" >&2
        exit 1
    fi
    wait "${unix_echo_pid}"
    unix_echo_pid=""
}

test_v3_md5_unix_metadata() {
    local forward_socket="${temporary_dir}/forward-md5.sock"
    local unix_stdout="${temporary_dir}/unix-md5.stdout"
    local unix_stderr="${temporary_dir}/unix-md5.stderr"
    local capability='00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f'
    local config
    config="{\"schemaVersion\":3,\"authType\":\"tcp-md5\",\"forwardCapability\":\"${capability}\",\"profiles\":[{\"peer\":\"127.0.0.1/32\",\"key\":\"netnexus-native-md5-key\"}]}"

    : >"${unix_stdout}"
    : >"${unix_stderr}"
    printf '%s\n' "${config}" | "${native_driver}" unix-supervise "${helper}" "${forward_socket}" \
        "${capability}" 4 "${listen_port}" "${listen_port}" \
        >"${unix_stdout}" 2>"${unix_stderr}" &
    unix_echo_pid=$!
    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then
            wait "${unix_echo_pid}" 2>/dev/null || true
            echo "TCP-MD5 Unix metadata supervisor exited during startup" >&2
            sed -n '1,5p' "${unix_stdout}" >&2
            sed -n '1,5p' "${unix_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    grep -q '^unix-supervisor-ready$' "${unix_stdout}"
    grep -q '"authentication":"tcp-md5"' "${unix_stdout}"
    grep -q '"md5Configured":true' "${unix_stdout}"
    "${native_driver}" md5-connect "${listen_port}" correct 4

    for _ in $(seq 1 100); do
        if grep -q '^unix-forward-metadata-ok-4$' "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then break; fi
        sleep 0.05
    done
    if ! grep -q '^unix-forward-metadata-ok-4$' "${unix_stdout}"; then
        echo "TCP-MD5 Unix forward header did not contain the expected IPv4 metadata" >&2
        sed -n '1,5p' "${unix_stderr}" >&2
        exit 1
    fi
    wait "${unix_echo_pid}"
    unix_echo_pid=""
}

test_v3_md5_unmatched_unix_not_forwarded() {
    local forward_socket="${temporary_dir}/forward-md5-unmatched.sock"
    local unix_stdout="${temporary_dir}/unix-md5-unmatched.stdout"
    local unix_stderr="${temporary_dir}/unix-md5-unmatched.stderr"
    local capability='00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f'
    local config
    config="{\"schemaVersion\":3,\"authType\":\"tcp-md5\",\"forwardCapability\":\"${capability}\",\"profiles\":[{\"peer\":\"127.0.0.2/32\",\"key\":\"netnexus-native-md5-key\"}]}"

    : >"${unix_stdout}"
    : >"${unix_stderr}"
    printf '%s\n' "${config}" | "${native_driver}" unix-reject-supervise "${helper}" \
        "${forward_socket}" "${listen_port}" >"${unix_stdout}" 2>"${unix_stderr}" &
    unix_echo_pid=$!
    for _ in $(seq 1 200); do
        if grep -q '"status":"ready"' "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then
            wait "${unix_echo_pid}" 2>/dev/null || true
            echo "TCP-MD5 unmatched-peer Unix supervisor exited during startup" >&2
            sed -n '1,5p' "${unix_stdout}" >&2
            sed -n '1,5p' "${unix_stderr}" >&2
            exit 1
        fi
        sleep 0.05
    done
    grep -q '^unix-no-forward-supervisor-ready$' "${unix_stdout}"
    grep -q '"authentication":"tcp-md5"' "${unix_stdout}"
    "${native_driver}" unmatched-connect "${listen_port}" 4
    wait "${unix_echo_pid}"
    unix_echo_pid=""
    grep -q '^unmatched-peer-unix-not-forwarded-ok$' "${unix_stdout}"
}

test_v2_wrong_unix_peer_rejected() {
    local forward_socket="${temporary_dir}/forward-wrong-parent.sock"
    local unix_stdout="${temporary_dir}/unix-wrong-parent.stdout"
    local unix_stderr="${temporary_dir}/unix-wrong-parent.stderr"
    local client_stdout="${temporary_dir}/client-wrong-parent.stdout"
    local client_stderr="${temporary_dir}/client-wrong-parent.stderr"
    local capability='00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f'
    local config
    local client_status
    local unix_status
    config="{\"schemaVersion\":2,\"forwardCapability\":\"${capability}\",\"profiles\":[{\"peer\":\"127.0.0.1/32\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-native-test-key\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":0,\"acceptEnd\":0}]}]}"

    : >"${unix_stdout}"
    : >"${unix_stderr}"
    "${native_driver}" unix-echo "${forward_socket}" "${capability}" 4 "${listen_port}" \
        >"${unix_stdout}" 2>"${unix_stderr}" &
    unix_echo_pid=$!
    for _ in $(seq 1 100); do
        if grep -q '^unix-echo-ready$' "${unix_stdout}"; then break; fi
        if ! kill -0 "${unix_echo_pid}" 2>/dev/null; then
            echo "wrong-parent Unix fixture exited during startup" >&2
            exit 1
        fi
        sleep 0.05
    done
    grep -q '^unix-echo-ready$' "${unix_stdout}"

    start_helper_unix "${config}" "${forward_socket}"
    set +e
    "${native_driver}" connect "${listen_port}" correct 'hmac(sha1)' 4 \
        >"${client_stdout}" 2>"${client_stderr}"
    client_status=$?
    wait "${unix_echo_pid}"
    unix_status=$?
    set -e
    unix_echo_pid=""
    stop_helper

    if [[ "${client_status}" -eq 0 ]]; then
        echo "helper trusted a Unix forwarding server that was not its direct parent" >&2
        exit 1
    fi
    if [[ "${unix_status}" -eq 0 ]] || grep -q '^unix-forward-metadata-ok-4$' "${unix_stdout}"; then
        echo "helper disclosed authenticated forwarding metadata to the wrong Unix server PID" >&2
        exit 1
    fi
    echo "unix-peer-identity-rejected-ok"
}

test_v2_wrong_unix_peer_rejected
test_v2_unix_metadata 4 '127.0.0.1/32'
test_v2_unix_metadata 6 '::1/128'
test_v3_md5_unix_metadata
test_v3_md5_unmatched_unix_not_forwarded

reload_initial_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/8","keys":[{"algorithm":"hmac(sha1)","sndId":7,"rcvId":7,"key":"netnexus-reload-key-old","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_reloadable_helper "${reload_initial_config}"
"${native_driver}" reload-connect "${listen_port}" old accept

# A missing send-valid key must be rejected before any socket mutation.
reload_invalid_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/8","keys":[{"algorithm":"hmac(sha1)","sndId":7,"rcvId":7,"key":"netnexus-reload-invalid-secret","macLength":12,"acceptStart":0,"sendStart":4102444800,"sendEnd":0,"acceptEnd":0}]}]}'
reload_invalid_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":1,\"config\":${reload_invalid_config}}"
send_reload_request "${reload_invalid_request}" 1 '"code":"RELOAD_CONFIG_INVALID"'
"${native_driver}" reload-connect "${listen_port}" old accept

# A peer topology change requires a restart and must leave the old key plan active.
reload_topology_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/16","keys":[{"algorithm":"hmac(sha1)","sndId":7,"rcvId":7,"key":"netnexus-reload-key-new","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
reload_topology_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":2,\"config\":${reload_topology_config}}"
send_reload_request "${reload_topology_request}" 2 '"code":"RELOAD_RESTART_REQUIRED"'
"${native_driver}" reload-connect "${listen_port}" old accept

# Request ID zero is intentionally uncorrelatable and is rejected without changing keys.
reload_zero_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":0,\"config\":${reload_initial_config}}"
printf '%s\n' "${reload_zero_request}" >&"${helper_control_fd}"
for _ in $(seq 1 200); do
    if grep -q '"requestId":null,"code":"RELOAD_REQUEST_INVALID"' "${helper_stdout}"; then break; fi
    sleep 0.05
done
grep -q '"requestId":null,"code":"RELOAD_REQUEST_INVALID"' "${helper_stdout}"
"${native_driver}" reload-connect "${listen_port}" old accept
stop_helper

# Complete an old-key handshake while the helper is stopped so the child stays
# queued in the kernel. The control frame and listener event become readable
# together; reload is processed first, and reconcile must inspect the queued
# child's actual MKT material instead of accepting same-ID EEXIST.
reload_new_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/8","keys":[{"algorithm":"hmac(sha1)","sndId":7,"rcvId":7,"key":"netnexus-reload-key-new","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
reload_new_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":3,\"config\":${reload_new_config}}"
start_reloadable_helper "${reload_initial_config}"
queued_reload_stdout="${temporary_dir}/queued-reload.stdout"
queued_reload_stderr="${temporary_dir}/queued-reload.stderr"
: >"${queued_reload_stdout}"
: >"${queued_reload_stderr}"
kill -STOP "${helper_pid}"
for _ in $(seq 1 100); do
    helper_state="$(awk '/^State:/ { print $2 }' "/proc/${helper_pid}/status" 2>/dev/null || true)"
    if [[ "${helper_state}" == "T" || "${helper_state}" == "t" ]]; then break; fi
    sleep 0.01
done
if [[ "${helper_state:-}" != "T" && "${helper_state:-}" != "t" ]]; then
    echo "helper did not enter the stopped state for queued reload test" >&2
    exit 1
fi
"${native_driver}" reload-queued "${listen_port}" \
    >"${queued_reload_stdout}" 2>"${queued_reload_stderr}" &
reload_client_pid=$!
for _ in $(seq 1 200); do
    if grep -q '^queued-reload-client-connected$' "${queued_reload_stdout}"; then break; fi
    if ! kill -0 "${reload_client_pid}" 2>/dev/null; then
        echo "queued reload client exited before completing its old-key handshake" >&2
        exit 1
    fi
    sleep 0.05
done
grep -q '^queued-reload-client-connected$' "${queued_reload_stdout}"
printf '%s\n' "${reload_new_request}" >&"${helper_control_fd}"
kill -CONT "${helper_pid}"
for _ in $(seq 1 200); do
    if grep -Eq '"requestId":3.*"status":"reloaded"|"status":"reloaded".*"requestId":3' \
        "${helper_stdout}"; then
        break
    fi
    if ! kill -0 "${helper_pid}" 2>/dev/null; then
        echo "helper exited while reconciling an old queued socket" >&2
        exit 1
    fi
    sleep 0.05
done
grep -q '"status":"reloaded","requestId":3' "${helper_stdout}"
wait "${reload_client_pid}"
reload_client_pid=""
grep -q '^queued-old-key-rejected-ok$' "${queued_reload_stdout}"
"${native_driver}" reload-connect "${listen_port}" new accept
stop_helper

start_reloadable_helper "${reload_initial_config}"

# Reusing an ID with different material cannot be replaced safely in-place on an
# established socket. The helper commits the listener plan and closes that socket
# so it reconnects under the new material.
reload_hold_stdout="${temporary_dir}/reload-hold.stdout"
reload_hold_stderr="${temporary_dir}/reload-hold.stderr"
: >"${reload_hold_stdout}"
: >"${reload_hold_stderr}"
"${native_driver}" reload-hold "${listen_port}" >"${reload_hold_stdout}" 2>"${reload_hold_stderr}" &
reload_client_pid=$!
for _ in $(seq 1 200); do
    if grep -q '^reload-hold-ready$' "${reload_hold_stdout}"; then break; fi
    if ! kill -0 "${reload_client_pid}" 2>/dev/null; then
        echo "reload hold client exited before becoming ready" >&2
        exit 1
    fi
    sleep 0.05
done
grep -q '^reload-hold-ready$' "${reload_hold_stdout}"
send_reload_request "${reload_new_request}" 3 '"profileCount":1.*"disconnectedConnections":1.*"activeSocketUpdate":"update-or-safe-reconnect"'
wait "${reload_client_pid}"
reload_client_pid=""
grep -q '^reload-active-connection-closed-ok$' "${reload_hold_stdout}"
"${native_driver}" reload-connect "${listen_port}" old reject
"${native_driver}" reload-connect "${listen_port}" new accept
reload_algorithm_config='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/8","keys":[{"algorithm":"hmac(sha256)","sndId":7,"rcvId":7,"key":"netnexus-native-test-key","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
reload_algorithm_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":4,\"config\":${reload_algorithm_config}}"
send_reload_request "${reload_algorithm_request}" 4 '"profileCount":1.*"keyCount":1'
"${native_driver}" reload-connect "${listen_port}" new reject
"${native_driver}" reload-connect "${listen_port}" sha256 accept
if grep -q 'netnexus-reload-' "${helper_stdout}" "${helper_stderr}"; then
    echo "runtime reload key material leaked into helper output" >&2
    exit 1
fi
stop_helper

# A full scheduled plan reload adds the future Key ID to the established socket,
# then switches and expires keys at the newly supplied wall-clock boundaries.
reload_rotation_initial='{"schemaVersion":1,"profiles":[{"peer":"127.0.0.0/8","keys":[{"algorithm":"hmac(sha1)","sndId":1,"rcvId":1,"key":"netnexus-rotation-key-one","macLength":12,"acceptStart":0,"sendStart":0,"sendEnd":0,"acceptEnd":0}]}]}'
start_reloadable_helper "${reload_rotation_initial}"
reload_rotation_stdout="${temporary_dir}/reload-rotation.stdout"
reload_rotation_stderr="${temporary_dir}/reload-rotation.stderr"
now="$(date +%s)"
reload_switch_epoch=$((now + 4))
reload_accept_start=$((now + 2))
reload_accept_end=$((reload_switch_epoch + 2))
"${native_driver}" rotate "${listen_port}" "${reload_switch_epoch}" \
    >"${reload_rotation_stdout}" 2>"${reload_rotation_stderr}" &
reload_client_pid=$!
for _ in $(seq 1 200); do
    if grep -q '^live-rotation-ready$' "${reload_rotation_stdout}"; then break; fi
    if ! kill -0 "${reload_client_pid}" 2>/dev/null; then
        echo "reload rotation client exited before becoming ready" >&2
        exit 1
    fi
    sleep 0.05
done
grep -q '^live-rotation-ready$' "${reload_rotation_stdout}"
reload_rotation_config="{\"schemaVersion\":1,\"profiles\":[{\"peer\":\"127.0.0.0/8\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-rotation-key-one\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":${reload_switch_epoch},\"acceptEnd\":${reload_accept_end}},{\"algorithm\":\"hmac(sha1)\",\"sndId\":2,\"rcvId\":2,\"key\":\"netnexus-rotation-key-two\",\"macLength\":12,\"acceptStart\":${reload_accept_start},\"sendStart\":${reload_switch_epoch},\"sendEnd\":0,\"acceptEnd\":0}]}]}"
reload_rotation_request="{\"schemaVersion\":1,\"command\":\"reload\",\"requestId\":5,\"config\":${reload_rotation_config}}"
send_reload_request "${reload_rotation_request}" 5 '"profileCount":1.*"keyCount":2'
wait "${reload_client_pid}"
reload_client_pid=""
grep -q '^live-rotation-ok$' "${reload_rotation_stdout}"
"${native_driver}" rotation-connect "${listen_port}" 1 reject
"${native_driver}" rotation-connect "${listen_port}" 2 accept
if grep -q 'closed the affected connection' "${helper_stderr}"; then
    echo "runtime schedule reload unexpectedly required close-on-unsupported fallback" >&2
    exit 1
fi
stop_helper

now="$(date +%s)"
switch_epoch=$((now + 4))
accept_start=$((now + 2))
accept_end=$((switch_epoch + 2))
rotation_config="{\"schemaVersion\":1,\"profiles\":[{\"peer\":\"127.0.0.0/8\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-rotation-key-one\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":${switch_epoch},\"acceptEnd\":${accept_end}},{\"algorithm\":\"hmac(sha1)\",\"sndId\":2,\"rcvId\":2,\"key\":\"netnexus-rotation-key-two\",\"macLength\":12,\"acceptStart\":${accept_start},\"sendStart\":${switch_epoch},\"sendEnd\":0,\"acceptEnd\":0}]}]}"
start_helper "${rotation_config}"
"${native_driver}" rotate "${listen_port}" "${switch_epoch}"
"${native_driver}" rotation-connect "${listen_port}" 1 reject
"${native_driver}" rotation-connect "${listen_port}" 2 accept
if grep -q 'closed the affected connection' "${helper_stderr}"; then
    echo "kernel unexpectedly required close-on-unsupported fallback" >&2
    exit 1
fi
stop_helper

now="$(date +%s)"
expiry=$((now + 3))
accept_expiry=$((expiry + 1))
expiry_config="{\"schemaVersion\":1,\"profiles\":[{\"peer\":\"127.0.0.1/32\",\"keys\":[{\"algorithm\":\"hmac(sha1)\",\"sndId\":1,\"rcvId\":1,\"key\":\"netnexus-native-test-key\",\"macLength\":12,\"acceptStart\":0,\"sendStart\":0,\"sendEnd\":${expiry},\"acceptEnd\":${accept_expiry}}]}]}"
start_helper "${expiry_config}"
expiry_timeout_marker="${temporary_dir}/expiry-timeout"
(
    sleep 10
    if kill -0 "${helper_pid}" 2>/dev/null; then
        : >"${expiry_timeout_marker}"
        kill -KILL "${helper_pid}" 2>/dev/null || true
    fi
) &
watchdog_pid=$!
set +e
wait "${helper_pid}"
expiry_status=$?
set -e
helper_pid=""
kill -TERM "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true
watchdog_pid=""
if [[ -e "${expiry_timeout_marker}" ]]; then
    echo "helper did not exit within 10 seconds of final send-key expiry" >&2
    exit 1
fi
if [[ "${expiry_status}" -ne 20 ]]; then
    echo "helper final send-key expiry returned ${expiry_status}, expected structured status 20" >&2
    exit 1
fi
grep -q 'stopping fail-closed' "${helper_stderr}"

"${native_driver}" clock-guard
"${native_driver}" probe-algorithms

echo "tcp-auth-helper native integration tests passed (uid=$(id -u), arch=${helper_arch})"
