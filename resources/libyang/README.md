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

Build and verify the current platform runtime with:

```bash
npm run libyang:build:unix
npm run libyang:verify
```

On Windows PowerShell:

```powershell
npm run libyang:build:windows
npm run libyang:verify
```

Electron packaging fails if either executable is absent, cannot execute, uses
the wrong libyang version, or if the Schema helper contract is incompatible.

The Windows build uses a pinned vcpkg manifest for PThreads4W and dirent, and
a pinned permissively licensed getopt compatibility source. It statically
links these dependencies and PCRE2 into both executables. The build fails if
either executable imports anything outside the approved Windows system DLL set.
Both executables embed a UTF-8 active-code-page and long-path-aware application
manifest; the build extracts and verifies these settings before packaging.
