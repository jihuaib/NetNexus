$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Release = Get-Content (Join-Path $ProjectRoot 'resources/libyang/manifest.json') -Raw | ConvertFrom-Json
$RuntimeKey = 'win32-x64'
$RuntimeTarget = Join-Path $ProjectRoot "resources/libyang/$RuntimeKey"
$SchemaHelperSource = Join-Path $ProjectRoot 'scripts/netnexus-libyang-schema.c'
$WindowsRuntimeManifestSource = Join-Path $ProjectRoot 'scripts/netnexus-libyang-windows.manifest.in'
$VcpkgRoot = if ($env:VCPKG_ROOT) {
    $env:VCPKG_ROOT
} elseif ($env:VCPKG_INSTALLATION_ROOT) {
    $env:VCPKG_INSTALLATION_ROOT
} else {
    'C:\vcpkg'
}
$Vcpkg = Join-Path $VcpkgRoot 'vcpkg.exe'
$VcpkgManifestRoot = Join-Path $ProjectRoot 'scripts/libyang-vcpkg'
$VcpkgManifest = Get-Content (Join-Path $VcpkgManifestRoot 'vcpkg.json') -Raw | ConvertFrom-Json
$VcpkgBaseline = $VcpkgManifest.'builtin-baseline'
if (-not (Test-Path $Vcpkg -PathType Leaf)) {
    throw "vcpkg was not found at $Vcpkg. Set VCPKG_ROOT to a bootstrapped vcpkg checkout."
}
if (-not (Test-Path $SchemaHelperSource -PathType Leaf)) {
    throw "The required libyang Schema helper source was not found at $SchemaHelperSource."
}
if (-not (Test-Path $WindowsRuntimeManifestSource -PathType Leaf)) {
    throw "The required Windows UTF-8 runtime manifest was not found at $WindowsRuntimeManifestSource."
}
if ($VcpkgBaseline -ne $Release.windowsDependencies.vcpkgBaseline) {
    throw 'The Windows vcpkg baseline does not match the bundled runtime release manifest.'
}
$VcpkgDependencyNames = @($VcpkgManifest.dependencies | Sort-Object)
if (($VcpkgDependencyNames -join ',') -ne 'dirent,pthreads') {
    throw 'The Windows vcpkg manifest must contain only the pinned dirent and pthreads runtime dependencies.'
}
$DirentOverride = @($VcpkgManifest.overrides | Where-Object { $_.name -eq 'dirent' })
$PthreadsOverride = @($VcpkgManifest.overrides | Where-Object { $_.name -eq 'pthreads' })
if ($DirentOverride.Count -ne 1 -or $DirentOverride[0].version -ne $Release.windowsDependencies.dirent.version) {
    throw 'The Windows dirent override does not match the bundled runtime release manifest.'
}
$PthreadsVersion = if ($PthreadsOverride.Count -eq 1) {
    "$($PthreadsOverride[0].version)#$($PthreadsOverride[0].'port-version')"
} else {
    ''
}
if ($PthreadsVersion -ne $Release.windowsDependencies.pthreads.version) {
    throw 'The Windows pthreads override does not match the bundled runtime release manifest.'
}

$BuildRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("netnexus-libyang-" + [guid]::NewGuid())
$SourceDir = Join-Path $BuildRoot 'source'
$BuildDir = Join-Path $BuildRoot 'build'
$Pcre2SourceDir = Join-Path $BuildRoot 'pcre2-source'
$Pcre2BuildDir = Join-Path $BuildRoot 'pcre2-build'
$Pcre2Prefix = Join-Path $BuildRoot 'pcre2-install'
$GetoptSourceDir = Join-Path $BuildRoot 'getopt-source'
$VcpkgInstalled = Join-Path $BuildRoot 'vcpkg-installed'
New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null

function Assert-GitCommit {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $Actual = (& git -C $Path rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $Actual -ne $Expected) {
        throw "Pinned dependency commit mismatch in ${Path}: expected $Expected, got $Actual."
    }
}

function Test-VcpkgBaselineAvailable {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Baseline
    )
    # Windows PowerShell 5.1 promotes redirected native stderr to a
    # terminating NativeCommandError when ErrorActionPreference is Stop.
    # A missing object is the expected cache-miss signal for the fetch below.
    try {
        & git -C $Path cat-file -e "${Baseline}^{commit}" 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }
        foreach ($RequiredVersionFile in @(
            'versions/baseline.json',
            'versions/d-/dirent.json',
            'versions/p-/pthreads.json'
        )) {
            & git -C $Path cat-file -e "${Baseline}:${RequiredVersionFile}" 2>$null
            if ($LASTEXITCODE -ne 0) { return $false }
        }
        return $true
    }
    catch {
        return $false
    }
}

function Ensure-VcpkgBaseline {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Baseline
    )
    if (Test-VcpkgBaselineAvailable -Path $Path -Baseline $Baseline) { return }

    Write-Host "Fetching pinned vcpkg baseline $Baseline..."
    # Keep the existing checkout's full history: vcpkg version records can refer
    # to port tree objects older than the selected baseline.
    # GitHub's preinstalled C:\vcpkg checkout may know the commit but omit tree
    # objects from its partial/shallow object store. --refetch disables object
    # negotiation so the pinned commit and version database are downloaded again.
    & git -C $Path fetch --refetch --no-tags https://github.com/microsoft/vcpkg.git `
        "+${Baseline}:refs/netnexus/baselines/${Baseline}"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to fetch pinned vcpkg baseline $Baseline."
    }
    if (-not (Test-VcpkgBaselineAvailable -Path $Path -Baseline $Baseline)) {
        throw "Pinned vcpkg baseline $Baseline is missing its required version database objects."
    }
}

function Replace-PinnedSourceText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Replacement
    )
    $Content = [System.IO.File]::ReadAllText($Path)
    $ExpectedForFile = if ($Content.Contains("`r`n")) { $Expected.Replace("`n", "`r`n") } else { $Expected }
    $ReplacementForFile = if ($Content.Contains("`r`n")) { $Replacement.Replace("`n", "`r`n") } else { $Replacement }
    if (-not $Content.Contains($ExpectedForFile)) {
        throw "Pinned dependency source changed; expected text was not found in $Path."
    }
    $OccurrenceCount = ([regex]::Matches($Content, [regex]::Escape($ExpectedForFile))).Count
    if ($OccurrenceCount -ne 1) {
        throw "Pinned dependency source changed; expected exactly one source patch location in $Path, found $OccurrenceCount."
    }
    [System.IO.File]::WriteAllText($Path, $Content.Replace($ExpectedForFile, $ReplacementForFile))
}

function Get-DumpbinPath {
    $Command = Get-Command 'dumpbin.exe' -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Path }

    $Vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path $Vswhere -PathType Leaf)) {
        throw 'dumpbin.exe and vswhere.exe were not found; PE dependency verification is required.'
    }
    $VisualStudioRoot = (& $Vswhere -latest -products '*' `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $VisualStudioRoot) {
        throw 'Unable to locate Visual Studio C++ tools for PE dependency verification.'
    }
    $ToolsRoot = Join-Path $VisualStudioRoot 'VC/Tools/MSVC'
    $Candidate = Get-ChildItem $ToolsRoot -Filter 'dumpbin.exe' -File -Recurse |
        Where-Object { $_.FullName -match '[\\/]bin[\\/]Hostx64[\\/]x64[\\/]dumpbin\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $Candidate) { throw "Unable to locate x64 dumpbin.exe under $ToolsRoot." }
    return $Candidate.FullName
}

function Get-MtPath {
    $Command = Get-Command 'mt.exe' -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Path }

    $WindowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    if (-not (Test-Path $WindowsKitsRoot -PathType Container)) {
        throw 'mt.exe and the Windows 10 SDK tools directory were not found.'
    }
    $Candidate = Get-ChildItem $WindowsKitsRoot -Filter 'mt.exe' -File -Recurse |
        Where-Object { $_.FullName -match '[\\/]x64[\\/]mt\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $Candidate) { throw "Unable to locate x64 mt.exe under $WindowsKitsRoot." }
    return $Candidate.FullName
}

function Assert-WindowsRuntimeManifest {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $Mt = Get-MtPath
    $ManifestProbe = Join-Path $BuildRoot (([IO.Path]::GetFileName($Executable)) + '.embedded.manifest')
    try {
        & $Mt -nologo "-inputresource:${Executable};#1" "-out:${ManifestProbe}"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ManifestProbe -PathType Leaf)) {
            throw "Unable to extract the embedded manifest from $Executable."
        }
        [xml]$Manifest = Get-Content $ManifestProbe -Raw
        $Utf8Nodes = $Manifest.SelectNodes(
            '//*[local-name()="activeCodePage" and namespace-uri()="http://schemas.microsoft.com/SMI/2019/WindowsSettings"]'
        )
        $LongPathNodes = $Manifest.SelectNodes(
            '//*[local-name()="longPathAware" and namespace-uri()="http://schemas.microsoft.com/SMI/2016/WindowsSettings"]'
        )
        if ($Utf8Nodes.Count -ne 1 -or $Utf8Nodes[0].InnerText.Trim() -ne 'UTF-8') {
            throw "$Executable does not embed exactly one UTF-8 activeCodePage declaration."
        }
        if ($LongPathNodes.Count -ne 1 -or $LongPathNodes[0].InnerText.Trim() -ne 'true') {
            throw "$Executable does not embed exactly one longPathAware declaration."
        }
    }
    finally {
        if (Test-Path $ManifestProbe) { Remove-Item $ManifestProbe -Force }
    }
}

function Assert-WindowsSystemDependencies {
    param([Parameter(Mandatory = $true)][string]$Executable)

    $Dumpbin = Get-DumpbinPath
    $Output = (& $Dumpbin /nologo /dependents $Executable 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "dumpbin failed while inspecting ${Executable}: $Output" }
    $Dependencies = @([regex]::Matches($Output, '(?im)^\s+([A-Za-z0-9_.-]+\.dll)\s*$') |
        ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() } |
        Sort-Object -Unique)
    if ($Dependencies.Count -eq 0) {
        throw "No PE imports were found in $Executable; dumpbin output could not be validated."
    }
    $Allowed = @{
        'KERNEL32.DLL' = $true
        'SHLWAPI.DLL' = $true
        'WS2_32.DLL' = $true
    }
    $Unexpected = @($Dependencies | Where-Object {
        -not $Allowed.ContainsKey($_) -and $_ -notmatch '^(API|EXT)-MS-WIN-[A-Z0-9_.-]+\.DLL$'
    })
    if ($Unexpected.Count -gt 0) {
        throw "Bundled libyang executable imports non-approved DLLs: $($Unexpected -join ', '). Static linkage is required."
    }
}

try {
    Ensure-VcpkgBaseline -Path $VcpkgRoot -Baseline $VcpkgBaseline
    & $Vcpkg install `
        "--x-manifest-root=$VcpkgManifestRoot" `
        "--x-install-root=$VcpkgInstalled" `
        --triplet x64-windows-static `
        --disable-metrics
    if ($LASTEXITCODE -ne 0) { throw 'Unable to install pinned libyang Windows build dependencies with vcpkg.' }

    & git clone --depth 1 --branch $Release.pcre2Tag https://github.com/PCRE2Project/pcre2.git $Pcre2SourceDir
    if ($LASTEXITCODE -ne 0) { throw "Unable to clone PCRE2 $($Release.pcre2Tag)." }
    Assert-GitCommit $Pcre2SourceDir ($Release.pcre2Commit)
    & cmake -S $Pcre2SourceDir -B $Pcre2BuildDir -A x64 `
        '-DCMAKE_BUILD_TYPE=Release' `
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded' `
        "-DCMAKE_INSTALL_PREFIX=$Pcre2Prefix" `
        '-DBUILD_SHARED_LIBS=OFF' `
        '-DBUILD_STATIC_LIBS=ON' `
        '-DPCRE2_BUILD_PCRE2_8=ON' `
        '-DPCRE2_BUILD_PCRE2_16=OFF' `
        '-DPCRE2_BUILD_PCRE2_32=OFF' `
        '-DPCRE2_BUILD_PCRE2GREP=OFF' `
        '-DPCRE2_BUILD_TESTS=OFF'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the Windows PCRE2 runtime dependency.' }
    & cmake --build $Pcre2BuildDir --config Release --parallel
    if ($LASTEXITCODE -ne 0) { throw 'Unable to build the Windows PCRE2 runtime dependency.' }
    & cmake --install $Pcre2BuildDir --config Release
    if ($LASTEXITCODE -ne 0) { throw 'Unable to install the Windows PCRE2 runtime dependency.' }

    & git clone --depth 1 --branch $Release.tag https://github.com/CESNET/libyang.git $SourceDir
    if ($LASTEXITCODE -ne 0) { throw "Unable to clone libyang $($Release.tag)." }
    Assert-GitCommit $SourceDir ($Release.libyangCommit)

    & git init $GetoptSourceDir
    if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize the pinned getopt source checkout.' }
    & git -C $GetoptSourceDir remote add origin ($Release.windowsDependencies.getopt.source)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the pinned getopt source checkout.' }
    & git -C $GetoptSourceDir fetch --depth 1 origin ($Release.windowsDependencies.getopt.commit)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch the pinned getopt source commit.' }
    & git -C $GetoptSourceDir checkout --detach FETCH_HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Unable to check out the pinned getopt source commit.' }
    Assert-GitCommit $GetoptSourceDir ($Release.windowsDependencies.getopt.commit)
    $GetoptCompatDir = Join-Path $SourceDir 'compat/netnexus-getopt'
    New-Item -ItemType Directory -Force -Path $GetoptCompatDir | Out-Null
    Copy-Item (Join-Path $GetoptSourceDir 'getopt.c') $GetoptCompatDir -Force
    Copy-Item (Join-Path $GetoptSourceDir 'getopt.h') $GetoptCompatDir -Force

    # libyang 5.8.6 prefers Unix archive suffixes for all static builds. On MSVC,
    # retain static linking but discover .lib files and PCRE2's explicit static name.
    Replace-PinnedSourceText `
        (Join-Path $SourceDir 'CMakeLists.txt') `
        'set(CMAKE_FIND_LIBRARY_SUFFIXES .a;.so)' `
        "if(WIN32)`n        set(CMAKE_FIND_LIBRARY_SUFFIXES .lib)`n    else()`n        set(CMAKE_FIND_LIBRARY_SUFFIXES .a;.so)`n    endif()"
    Replace-PinnedSourceText `
        (Join-Path $SourceDir 'CMakeModules/FindPCRE2.cmake') `
        "NAMES`n            pcre2-8" `
        "NAMES`n            pcre2-8-static`n            pcre2-8"
    $GetoptFindBlock = @'
if(WIN32)
    find_library(GETOPT_LIBRARY NAMES getopt REQUIRED)
    find_path(GETOPT_INCLUDE_DIR NAMES getopt.h REQUIRED)
    message(STATUS "Found <getopt.h> at ${GETOPT_INCLUDE_DIR}, library at ${GETOPT_LIBRARY}")
endif()
'@
    $GetoptTargetBlock = @'
if(WIN32)
    add_library(netnexus_getopt STATIC
        ${PROJECT_SOURCE_DIR}/compat/netnexus-getopt/getopt.c)
    target_include_directories(netnexus_getopt PUBLIC
        ${PROJECT_SOURCE_DIR}/compat/netnexus-getopt)
    set(GETOPT_LIBRARY netnexus_getopt)
    set(GETOPT_INCLUDE_DIR ${PROJECT_SOURCE_DIR}/compat/netnexus-getopt)
    message(STATUS "Using pinned static NetNexus getopt compatibility source")
endif()
'@
    Replace-PinnedSourceText `
        (Join-Path $SourceDir 'tools/CMakeLists.txt') `
        $GetoptFindBlock `
        $GetoptTargetBlock
    Copy-Item $SchemaHelperSource (Join-Path $SourceDir 'tools/netnexus-libyang-schema.c') -Force
    Copy-Item $WindowsRuntimeManifestSource `
        (Join-Path $SourceDir 'tools/netnexus-libyang-windows.manifest.in') -Force
    $ToolSubdirectories = @'
add_subdirectory(lint)
add_subdirectory(re)
'@
    $ToolSubdirectoriesWithSchemaHelper = @'
add_subdirectory(lint)
add_subdirectory(re)

add_executable(netnexus-libyang-schema
    ${PROJECT_SOURCE_DIR}/tools/netnexus-libyang-schema.c)
target_link_libraries(netnexus-libyang-schema yang)
target_include_directories(netnexus-libyang-schema BEFORE PRIVATE ${PROJECT_BINARY_DIR})
target_compile_definitions(netnexus-libyang-schema PRIVATE STATIC)
set_target_properties(netnexus-libyang-schema PROPERTIES
    C_STANDARD 11
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS NO)
if(MSVC)
    target_compile_options(netnexus-libyang-schema PRIVATE /W4 /utf-8)
    function(netnexus_embed_windows_manifest target identity)
        set(NETNEXUS_MANIFEST_IDENTITY "${identity}")
        set(manifest_output "${CMAKE_CURRENT_BINARY_DIR}/${target}.netnexus.manifest")
        configure_file(
            "${PROJECT_SOURCE_DIR}/tools/netnexus-libyang-windows.manifest.in"
            "${manifest_output}"
            @ONLY)
        target_link_options(${target} PRIVATE
            "/MANIFEST:EMBED,ID=1"
            "/MANIFESTINPUT:${manifest_output}")
        set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS "${manifest_output}")
    endfunction()
    netnexus_embed_windows_manifest(yanglint "NetNexus.libyang.yanglint")
    netnexus_embed_windows_manifest(netnexus-libyang-schema "NetNexus.libyang.schema")
endif()
'@
    Replace-PinnedSourceText `
        (Join-Path $SourceDir 'tools/CMakeLists.txt') `
        $ToolSubdirectories `
        $ToolSubdirectoriesWithSchemaHelper

    & cmake -S $SourceDir -B $BuildDir -A x64 `
        "-DCMAKE_TOOLCHAIN_FILE=$VcpkgRoot/scripts/buildsystems/vcpkg.cmake" `
        "-DVCPKG_INSTALLED_DIR=$VcpkgInstalled" `
        '-DVCPKG_TARGET_TRIPLET=x64-windows-static' `
        "-DCMAKE_PREFIX_PATH=$Pcre2Prefix" `
        "-DCMAKE_INCLUDE_PATH=$Pcre2Prefix/include" `
        "-DCMAKE_LIBRARY_PATH=$Pcre2Prefix/lib" `
        '-DCMAKE_BUILD_TYPE=Release' `
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded' `
        '-DCMAKE_C_FLAGS=/DPCRE2_STATIC' `
        '-DYANG_MODULE_DIR=.' `
        '-DBUILD_SHARED_LIBS=OFF' `
        '-DENABLE_TESTS=OFF' `
        '-DENABLE_TOOLS=ON' `
        '-DENABLE_YANGLINT_INTERACTIVE=OFF' `
        '-DENABLE_COMMON_TARGETS=OFF'
    if ($LASTEXITCODE -ne 0) { throw 'Unable to configure the Windows libyang runtime.' }
    & cmake --build $BuildDir --config Release --target yanglint netnexus-libyang-schema --parallel
    if ($LASTEXITCODE -ne 0) { throw 'Unable to build the Windows libyang runtime executables.' }

    $BuiltYanglint = @(Get-ChildItem $BuildDir -Filter 'yanglint.exe' -File -Recurse)
    if ($BuiltYanglint.Count -ne 1) {
        throw "Expected exactly one built yanglint.exe, found $($BuiltYanglint.Count)."
    }
    $BuiltSchemaHelper = @(Get-ChildItem $BuildDir -Filter 'netnexus-libyang-schema.exe' -File -Recurse)
    if ($BuiltSchemaHelper.Count -ne 1) {
        throw "Expected exactly one built netnexus-libyang-schema.exe, found $($BuiltSchemaHelper.Count)."
    }
    Assert-WindowsSystemDependencies ($BuiltYanglint[0].FullName)
    Assert-WindowsSystemDependencies ($BuiltSchemaHelper[0].FullName)
    Assert-WindowsRuntimeManifest ($BuiltYanglint[0].FullName)
    Assert-WindowsRuntimeManifest ($BuiltSchemaHelper[0].FullName)

    $BinDir = Join-Path $RuntimeTarget 'bin'
    $ModuleDir = Join-Path $RuntimeTarget 'share/yang/modules/libyang'
    if (Test-Path $RuntimeTarget) { Remove-Item $RuntimeTarget -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $BinDir, $ModuleDir | Out-Null
    Copy-Item ($BuiltYanglint[0].FullName) (Join-Path $BinDir 'yanglint.exe') -Force
    Copy-Item ($BuiltSchemaHelper[0].FullName) (Join-Path $BinDir 'netnexus-libyang-schema.exe') -Force
    Copy-Item (Join-Path $SourceDir 'LICENSE') (Join-Path $RuntimeTarget 'LICENSE.libyang') -Force
    Copy-Item (Join-Path $Pcre2SourceDir 'LICENCE.md') (Join-Path $RuntimeTarget 'LICENSE.pcre2') -Force
    Copy-Item (Join-Path $GetoptSourceDir 'LICENSE') (Join-Path $RuntimeTarget 'LICENSE.getopt') -Force
    Copy-Item (Join-Path $VcpkgInstalled 'x64-windows-static/share/pthreads/copyright') `
        (Join-Path $RuntimeTarget 'LICENSE.pthreads') -Force
    Copy-Item (Join-Path $ProjectRoot 'resources/libyang/NOTICE.pthreads') `
        (Join-Path $RuntimeTarget 'NOTICE.pthreads') -Force
    Copy-Item (Join-Path $VcpkgInstalled 'x64-windows-static/share/dirent/copyright') `
        (Join-Path $RuntimeTarget 'LICENSE.dirent') -Force
    Copy-Item (Join-Path $SourceDir 'modules/*.yang') $ModuleDir -Force
    & node (Join-Path $ProjectRoot 'scripts/write-libyang-runtime-manifest.js') `
        $RuntimeTarget `
        (Join-Path $BinDir 'yanglint.exe') `
        (Join-Path $BinDir 'netnexus-libyang-schema.exe')
    & node (Join-Path $ProjectRoot 'scripts/verify-libyang-runtime.js') --platform win32 --arch x64
    if ($LASTEXITCODE -ne 0) { throw 'The generated Windows libyang runtime did not pass verification.' }
}
finally {
    if (Test-Path $BuildRoot) { Remove-Item $BuildRoot -Recurse -Force }
}
