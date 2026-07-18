# Bundled libyang runtime

NetNexus packages a platform-specific, non-interactive `yanglint` executable as
its authoritative YANG compiler. Runtime artifacts are generated from the
official CESNET/libyang source during packaging and are intentionally not
committed to Git.

Expected layout:

```text
resources/libyang/
  darwin-arm64/
    bin/yanglint
    share/yang/modules/libyang/*.yang
    LICENSE.libyang
    runtime.json
  win32-x64/
    bin/yanglint.exe
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

Electron packaging fails if the matching runtime is absent, has the wrong
version, or cannot execute.

The Windows build uses a pinned vcpkg manifest for PThreads4W and dirent, and
a pinned permissively licensed getopt compatibility source. It statically
links these dependencies and PCRE2 into `yanglint.exe`. The build fails if
the executable imports anything outside the approved Windows system DLL set.
