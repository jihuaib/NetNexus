#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "tcp-auth-helper can only be built on Linux" >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64 | amd64)
        target_arch="x64"
        ;;
    aarch64 | arm64)
        target_arch="arm64"
        ;;
    *)
        echo "tcp-auth-helper supports only native Linux x64 and arm64 builds" >&2
        exit 1
        ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"
source_file="${script_dir}/tcp-auth-helper.c"
output_dir="${project_root}/resources/tcp-auth/linux-${target_arch}"
output_file="${output_dir}/tcp-auth-helper"
compiler="${CC:-cc}"

if ! command -v "${compiler}" >/dev/null 2>&1; then
    echo "C compiler not found: ${compiler}" >&2
    echo "Install Ubuntu build dependencies with: sudo apt-get install build-essential linux-libc-dev" >&2
    exit 1
fi

mkdir -p -- "${output_dir}"
temporary_file="$(mktemp "${output_dir}/.tcp-auth-helper.XXXXXX")"
cleanup() {
    rm -f -- "${temporary_file}"
}
trap cleanup EXIT HUP INT TERM

"${compiler}" \
    -std=c11 \
    -O2 \
    -D_FORTIFY_SOURCE=3 \
    -fPIE \
    -fstack-protector-strong \
    -pthread \
    -Wall \
    -Wextra \
    -Wpedantic \
    -Werror \
    -Wformat=2 \
    -Wshadow \
    -Wconversion \
    -Wsign-conversion \
    -Wl,-z,defs \
    -Wl,-z,relro,-z,now \
    -Wl,-z,noexecstack \
    -pie \
    "${source_file}" \
    -o "${temporary_file}"

if command -v strip >/dev/null 2>&1; then
    strip --strip-unneeded "${temporary_file}"
fi
chmod 0755 "${temporary_file}"
mv -f -- "${temporary_file}" "${output_file}"
trap - EXIT HUP INT TERM

"${output_file}" --version
echo "Built ${output_file}"
