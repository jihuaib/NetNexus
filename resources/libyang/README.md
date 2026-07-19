# Bundled libyang runtime

NetNexus packages platform-specific, non-interactive `yanglint` and
`netnexus-libyang-schema` executables. The Schema helper is the application
compiler/exporter and emits contract-v1 effective-schema JSON directly from
libyang's compiled tree. Runtime artifacts are generated from the official
CESNET/libyang source during packaging and are intentionally not committed to
Git.

Expected layout:

```text
resources/libyang/
  darwin-arm64/
    bin/yanglint
    bin/netnexus-libyang-schema
    share/yang/modules/libyang/*.yang
    LICENSE.libyang
    LICENSE.pcre2
    runtime.json
  win32-x64/
    bin/yanglint.exe
    bin/netnexus-libyang-schema.exe
    share/yang/modules/libyang/*.yang
    LICENSE.libyang
    LICENSE.pcre2
    LICENSE.getopt
    LICENSE.pthreads
    NOTICE.pthreads
    LICENSE.dirent
    runtime.json
```

## Install-time build

A normal `npm install` or `npm ci` automatically ensures the bundled libyang
runtime for the current platform and architecture. If the runtime is present,
valid, and its build-input fingerprint is current, installation reuses it and
skips compilation. If it is missing or stale, installation builds it and then
verifies the resulting executables.

The automatic build requires network access to fetch the pinned upstream
sources, plus these host tools:

- macOS and Linux: Git, CMake, and a working C compiler toolchain.
- Windows: an x64 host with Git, CMake, Visual Studio C++ build tools, the
  Windows SDK, and a bootstrapped vcpkg checkout. Set `VCPKG_ROOT` when vcpkg
  is not in the default location.

Force a clean build for the current platform with:

```bash
npm run libyang:build
npm run libyang:verify
```

The platform-specific commands remain available for build-script debugging:

```bash
npm run libyang:build:unix
npm run libyang:build:windows
```

Jobs that explicitly do not use YANG may set
`NETNEXUS_SKIP_LIBYANG_BUILD=1` to skip the install-time build. This only skips
the build hook; it does not weaken runtime validation. Packaging and YANG
compilation will still fail when the required runtime is absent or invalid.
Using `npm install --ignore-scripts` or `npm ci --ignore-scripts` likewise
bypasses the automatic build and is not suitable for packaging or YANG tests.

Electron packaging fails if either executable is absent, cannot execute, uses
the wrong libyang version, or if the Schema helper contract is incompatible.

The Windows build uses a pinned vcpkg manifest for PThreads4W and dirent, and
a pinned permissively licensed getopt compatibility source. It statically
links these dependencies and PCRE2 into both executables. The build fails if
either executable imports anything outside the approved Windows system DLL set.
Both executables embed a UTF-8 active-code-page and long-path-aware application
manifest; the build extracts and verifies these settings before packaging.
