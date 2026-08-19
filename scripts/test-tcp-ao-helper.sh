#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"

"${script_dir}/build-tcp-ao-helper.sh" >/dev/null

case "$(uname -m)" in
    x86_64 | amd64) helper_arch="x64" ;;
    aarch64 | arm64) helper_arch="arm64" ;;
    *) echo "unsupported test architecture" >&2; exit 1 ;;
esac

helper="${project_root}/resources/tcp-ao/linux-${helper_arch}/tcp-ao-helper"
temporary_dir="$(mktemp -d)"
native_driver="${temporary_dir}/tcp-ao-native-test"
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

cleanup() {
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
        kill -TERM "${helper_pid}" 2>/dev/null || true
        wait "${helper_pid}" 2>/dev/null || true
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
    "${script_dir}/test-tcp-ao-helper-native.c" -o "${native_driver}"

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

stop_helper() {
    if [[ -z "${helper_pid}" ]]; then return; fi
    kill -TERM "${helper_pid}"
    wait "${helper_pid}"
    helper_pid=""
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

echo "tcp-ao-helper native integration tests passed (uid=$(id -u), arch=${helper_arch})"
