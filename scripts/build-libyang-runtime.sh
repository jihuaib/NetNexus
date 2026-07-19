#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_platform=""
runtime_arch=""

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --platform)
            if [[ "$#" -lt 2 ]]; then
                echo "--platform requires a value." >&2
                exit 1
            fi
            runtime_platform="$2"
            shift 2
            ;;
        --arch)
            if [[ "$#" -lt 2 ]]; then
                echo "--arch requires a value." >&2
                exit 1
            fi
            runtime_arch="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

host_platform="$(node -p 'process.platform')"
host_arch="$(node -p 'process.arch')"
runtime_platform="${runtime_platform:-${host_platform}}"
runtime_arch="${runtime_arch:-${host_arch}}"
runtime_key="${runtime_platform}-${runtime_arch}"
runtime_target="${project_root}/resources/libyang/${runtime_key}"
libyang_version="$(node -p "require('${project_root}/resources/libyang/manifest.json').libyangVersion")"
libyang_tag="v${libyang_version}"
libyang_commit="$(node -p "require('${project_root}/resources/libyang/manifest.json').libyangCommit")"
pcre2_tag="$(node -p "require('${project_root}/resources/libyang/manifest.json').pcre2Tag")"
pcre2_commit="$(node -p "require('${project_root}/resources/libyang/manifest.json').pcre2Commit")"
iana_module_source="${project_root}/resources/libyang/iana"

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

if [[ "${runtime_platform}" != "${host_platform}" ]]; then
    echo "Cannot build ${runtime_platform}-${runtime_arch} on ${host_platform}-${host_arch}." >&2
    exit 1
fi
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
node "${project_root}/scripts/verify-libyang-iana-modules.js"

cmake_target_arch=""
macos_deployment_target="11.0"
if [[ "${runtime_platform}" == "darwin" ]]; then
    case "${runtime_arch}" in
        arm64) cmake_target_arch="arm64" ;;
        x64) cmake_target_arch="x86_64" ;;
        *)
            echo "macOS libyang builds support arm64 and x64; received ${runtime_arch}." >&2
            exit 1
            ;;
    esac
elif [[ "${runtime_arch}" != "${host_arch}" ]]; then
    echo "Linux libyang cross-compilation is not configured: ${host_arch} -> ${runtime_arch}." >&2
    exit 1
fi

cmake_configure() {
    if [[ "${runtime_platform}" == "darwin" ]]; then
        command cmake "$@" \
            -DCMAKE_OSX_ARCHITECTURES="${cmake_target_arch}" \
            -DCMAKE_OSX_DEPLOYMENT_TARGET="${macos_deployment_target}"
    else
        command cmake "$@"
    fi
}

runtime_build_dir="$(mktemp -d)"
trap 'rm -rf "${runtime_build_dir}"' EXIT
git clone --depth 1 --branch "${pcre2_tag}" https://github.com/PCRE2Project/pcre2.git "${runtime_build_dir}/pcre2-source"
assert_git_commit "${runtime_build_dir}/pcre2-source" "${pcre2_commit}"
cmake_configure -S "${runtime_build_dir}/pcre2-source" -B "${runtime_build_dir}/pcre2-build" \
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

cmake_configure -S "${runtime_build_dir}/source" -B "${runtime_build_dir}/build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="${runtime_build_dir}/pcre2-install" \
    -DCMAKE_INCLUDE_PATH="${runtime_build_dir}/pcre2-install/include" \
    -DCMAKE_LIBRARY_PATH="${runtime_build_dir}/pcre2-install/lib" \
    -DYANG_MODULE_DIR=. \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_TESTS=OFF \
    -DENABLE_TOOLS=ON \
    -DENABLE_YANGLINT_INTERACTIVE=OFF \
    -DENABLE_COMMON_TARGETS=OFF \
    -DCMAKE_DISABLE_FIND_PACKAGE_XXHash=TRUE
cmake --build "${runtime_build_dir}/build" --config Release --target yanglint --parallel

cmake_configure -S "${project_root}/scripts/libyang-schema-exporter" \
    -B "${runtime_build_dir}/schema-exporter-build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DNETNEXUS_LIBYANG_SOURCE="${runtime_build_dir}/source" \
    -DNETNEXUS_LIBYANG_BUILD="${runtime_build_dir}/build" \
    -DNETNEXUS_PCRE2_ROOT="${runtime_build_dir}/pcre2-install"
cmake --build "${runtime_build_dir}/schema-exporter-build" \
    --config Release --target netnexus-libyang-schema --parallel

expected_runtime_target="${project_root}/resources/libyang/${runtime_platform}-${runtime_arch}"
if [[ "${runtime_target}" != "${expected_runtime_target}" ]]; then
    echo "Refusing to replace unexpected libyang runtime target: ${runtime_target}" >&2
    exit 1
fi
rm -rf -- "${runtime_target}"
mkdir -p "${runtime_target}/bin" "${runtime_target}/share/yang/modules/libyang"
cp "${runtime_build_dir}/build/yanglint" "${runtime_target}/bin/yanglint"
cp "${runtime_build_dir}/schema-exporter-build/netnexus-libyang-schema" \
    "${runtime_target}/bin/netnexus-libyang-schema"
chmod 0755 "${runtime_target}/bin/yanglint"
chmod 0755 "${runtime_target}/bin/netnexus-libyang-schema"
if [[ "${runtime_platform}" == "darwin" ]]; then
    for runtime_executable in \
        "${runtime_target}/bin/yanglint" \
        "${runtime_target}/bin/netnexus-libyang-schema"; do
        if ! /usr/bin/lipo "${runtime_executable}" -verify_arch "${cmake_target_arch}"; then
            echo "Bundled executable does not contain ${cmake_target_arch}: ${runtime_executable}" >&2
            exit 1
        fi
    done
fi
cp "${runtime_build_dir}/source/LICENSE" "${runtime_target}/LICENSE.libyang"
cp "${runtime_build_dir}/pcre2-source/LICENCE.md" "${runtime_target}/LICENSE.pcre2"
find "${runtime_build_dir}/source/modules" -maxdepth 1 -type f -name '*.yang' -exec cp {} "${runtime_target}/share/yang/modules/libyang/" \;
find "${iana_module_source}" -maxdepth 1 -type f -name '*.yang' -exec cp {} "${runtime_target}/share/yang/modules/libyang/" \;

node "${project_root}/scripts/write-libyang-runtime-manifest.js" \
    "${runtime_target}" "${runtime_target}/bin/yanglint" \
    "${runtime_target}/bin/netnexus-libyang-schema" \
    "${runtime_platform}" "${runtime_arch}"
node "${project_root}/scripts/verify-libyang-runtime.js" \
    --platform "${runtime_platform}" --arch "${runtime_arch}"
