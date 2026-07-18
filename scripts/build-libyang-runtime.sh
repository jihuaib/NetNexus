#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_platform="$(node -p 'process.platform')"
runtime_arch="$(node -p 'process.arch')"
runtime_key="${runtime_platform}-${runtime_arch}"
runtime_target="${project_root}/resources/libyang/${runtime_key}"
libyang_version="$(node -p "require('${project_root}/resources/libyang/manifest.json').libyangVersion")"
libyang_tag="v${libyang_version}"
libyang_commit="$(node -p "require('${project_root}/resources/libyang/manifest.json').libyangCommit")"
pcre2_tag="$(node -p "require('${project_root}/resources/libyang/manifest.json').pcre2Tag")"
pcre2_commit="$(node -p "require('${project_root}/resources/libyang/manifest.json').pcre2Commit")"

assert_git_commit() {
    local source_directory="$1"
    local expected_commit="$2"
    local actual_commit
    actual_commit="$(git -C "${source_directory}" rev-parse HEAD)"
    if [[ "${actual_commit}" != "${expected_commit}" ]]; then
        echo "Pinned dependency commit mismatch in ${source_directory}: expected ${expected_commit}, got ${actual_commit}." >&2
        exit 1
    fi
}

if [[ "${runtime_platform}" != "darwin" && "${runtime_platform}" != "linux" ]]; then
    echo "This script supports macOS and Linux; use build-libyang-runtime.ps1 on Windows." >&2
    exit 1
fi
for command_name in cmake git; do
    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "Missing build dependency: ${command_name}" >&2
        exit 1
    fi
done

runtime_build_dir="$(mktemp -d)"
trap 'rm -rf "${runtime_build_dir}"' EXIT
git clone --depth 1 --branch "${pcre2_tag}" https://github.com/PCRE2Project/pcre2.git "${runtime_build_dir}/pcre2-source"
assert_git_commit "${runtime_build_dir}/pcre2-source" "${pcre2_commit}"
cmake -S "${runtime_build_dir}/pcre2-source" -B "${runtime_build_dir}/pcre2-build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="${runtime_build_dir}/pcre2-install" \
    -DBUILD_SHARED_LIBS=OFF \
    -DPCRE2_BUILD_PCRE2_8=ON \
    -DPCRE2_BUILD_PCRE2_16=OFF \
    -DPCRE2_BUILD_PCRE2_32=OFF \
    -DPCRE2_BUILD_PCRE2GREP=OFF \
    -DPCRE2_BUILD_TESTS=OFF
cmake --build "${runtime_build_dir}/pcre2-build" --config Release --parallel
cmake --install "${runtime_build_dir}/pcre2-build" --config Release

git clone --depth 1 --branch "${libyang_tag}" https://github.com/CESNET/libyang.git "${runtime_build_dir}/source"
assert_git_commit "${runtime_build_dir}/source" "${libyang_commit}"

cmake -S "${runtime_build_dir}/source" -B "${runtime_build_dir}/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="${runtime_build_dir}/pcre2-install" \
    -DCMAKE_INCLUDE_PATH="${runtime_build_dir}/pcre2-install/include" \
    -DCMAKE_LIBRARY_PATH="${runtime_build_dir}/pcre2-install/lib" \
    -DYANG_MODULE_DIR=. \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_TESTS=OFF \
    -DENABLE_TOOLS=ON \
    -DENABLE_YANGLINT_INTERACTIVE=OFF \
    -DENABLE_COMMON_TARGETS=OFF
cmake --build "${runtime_build_dir}/build" --config Release --target yanglint --parallel

mkdir -p "${runtime_target}/bin" "${runtime_target}/share/yang/modules/libyang"
cp "${runtime_build_dir}/build/yanglint" "${runtime_target}/bin/yanglint"
chmod 0755 "${runtime_target}/bin/yanglint"
cp "${runtime_build_dir}/source/LICENSE" "${runtime_target}/LICENSE.libyang"
find "${runtime_build_dir}/source/modules" -maxdepth 1 -type f -name '*.yang' -exec cp {} "${runtime_target}/share/yang/modules/libyang/" \;

node "${project_root}/scripts/write-libyang-runtime-manifest.js" \
    "${runtime_target}" "${runtime_target}/bin/yanglint"
node "${project_root}/scripts/verify-libyang-runtime.js" \
    --platform "${runtime_platform}" --arch "${runtime_arch}"
