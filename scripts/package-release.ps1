param(
    [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),
    [string]$Version = '0.1.0',
    [ValidateSet('off', 'thin', 'full')]
    [string]$LtoMode = 'full',
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64',
    [string]$VcpkgTriplet = '',
    [int64]$MaxPackageBytes = 0
)

$ErrorActionPreference = 'Stop'
if (-not $VcpkgTriplet) { $VcpkgTriplet = "$Architecture-windows-webkit" }
$Root = [IO.Path]::GetFullPath($Root)
$BuildRoot = [IO.Path]::GetFullPath((Join-Path $Root 'WebKitBuild'))
$Releases = [IO.Path]::GetFullPath((Join-Path $BuildRoot 'releases'))
# No version in the name: the archive unpacks to a stable
# shotkit-windows-<arch>/ directory. $Version still labels the payload (README,
# manifest.json), and the release workflow stamps the tag onto the file name of
# the public download.
$ArtifactName = "shotkit-windows-$Architecture"
$Stage = [IO.Path]::GetFullPath((Join-Path $Releases $ArtifactName))
$Tar = [IO.Path]::GetFullPath((Join-Path $BuildRoot "$ArtifactName.tar"))
$Archive = [IO.Path]::GetFullPath((Join-Path $Releases "$ArtifactName.tar.xz"))
$Checksum = "$Archive.sha256"
$LegacyZip = [IO.Path]::GetFullPath((Join-Path $Releases "$ArtifactName.zip"))

foreach ($pathToValidate in $Stage, $Tar, $Archive) {
    if (-not $pathToValidate.StartsWith($BuildRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "invalid build output path: $pathToValidate"
    }
}

$CollectDist = Join-Path $PSScriptRoot 'collect-dist.ps1'
$tarTool = Join-Path $env:SystemRoot 'System32\tar.exe'
$xzCommand = Get-Command xz.exe -ErrorAction SilentlyContinue
if ($xzCommand) {
    $xz = $xzCommand.Source
} else {
    $gitXz = Join-Path $env:ProgramFiles 'Git\usr\bin\xz.exe'
    if (-not (Test-Path -LiteralPath $gitXz)) { throw 'missing xz.exe; install XZ Utils or Git for Windows' }
    $xz = $gitXz
}
if (-not (Test-Path -LiteralPath $tarTool)) { throw "missing Windows tar.exe: $tarTool" }

try {
    & $CollectDist -Root $Root -Out $Stage -VcpkgTriplet $VcpkgTriplet

    $Include = Join-Path $Stage 'include'
    New-Item -ItemType Directory -Force -Path $Include | Out-Null
    Copy-Item -LiteralPath (Join-Path $Root 'shot\capi\shot.h') -Destination $Include

    $Readme = @"
ShotKit $Version - Windows $Architecture

Static HTML/CSS screenshot kernel. Page JavaScript and WebAssembly are disabled.
This is a conventional compressed distribution: extract the complete archive
before use. The extracted shot.dll is the rendering core and never performs
runtime extraction or writes a cache under LOCALAPPDATA.

Extract (the downloaded file name carries the release version; the directory
it unpacks into does not):
  tar.exe -xf shotkit-<version>-windows-$Architecture.tar.xz
  cd $ArtifactName

CLI:
  shotcli.exe --url https://example.com --out example.png
  shotcli.exe --html page.html --out page.webp --format webp
  type page.html | shotcli.exe --stdin --out page.png

C ABI:
  Header: include\shot.h
  Library: shot.dll
"@
    Set-Content -LiteralPath (Join-Path $Stage 'README.txt') -Value $Readme -Encoding utf8NoBOM

    $Files = Get-ChildItem -LiteralPath $Stage -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            path = [IO.Path]::GetRelativePath($Stage, $_.FullName).Replace('\', '/')
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    # The x86 BCJ filter only helps x86/x64 machine code; skip it for arm64 so
    # xz never fails on toolchains without an arm64 filter.
    $BcjFilterArgument = if ($Architecture -eq 'x64') { '--x86' } else { $null }
    $CompressionLabel = if ($BcjFilterArgument) { 'solid-x86-bcj+lzma2-16MiB' } else { 'solid-lzma2-16MiB' }
    $Manifest = [ordered]@{
        product = 'ShotKit'
        version = $Version
        platform = 'windows'
        architecture = $Architecture
        configuration = 'MinSizeRel'
        lto = $LtoMode
        distribution = 'extract-before-use'
        archiveCompression = $CompressionLabel
        runtimeExtraction = $false
        pageJavaScript = $false
        webAssembly = $false
        files = @($Files)
    }
    $Manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Stage 'manifest.json') -Encoding utf8NoBOM

    Remove-Item -LiteralPath $Tar, $Archive, $Checksum, $LegacyZip, "$LegacyZip.sha256" -Force -ErrorAction SilentlyContinue
    & $tarTool -cf $Tar -C $Releases $ArtifactName
    if ($LASTEXITCODE) { throw "tar failed with exit code $LASTEXITCODE" }

    $xzArguments = @('--threads=1', '--check=crc32')
    if ($BcjFilterArgument) { $xzArguments += $BcjFilterArgument }
    $xzArguments += @(
        '--lzma2=dict=16MiB,mode=normal,nice=273,mf=bt4',
        '-c',
        $Tar
    )
    $xzProcess = Start-Process -FilePath $xz -ArgumentList $xzArguments -RedirectStandardOutput $Archive -NoNewWindow -Wait -PassThru
    if ($xzProcess.ExitCode) { throw "xz failed with exit code $($xzProcess.ExitCode)" }

    $archiveHash = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $Checksum -Value "$archiveHash  $([IO.Path]::GetFileName($Archive))" -Encoding ascii

    $stageFiles = @(Get-ChildItem -LiteralPath $Stage -File -Recurse)
    $stageBytes = ($stageFiles | Measure-Object Length -Sum).Sum
    $archiveBytes = (Get-Item -LiteralPath $Archive).Length
    Write-Host ("extracted directory: {0} files, {1:N2} MiB" -f $stageFiles.Count, ($stageBytes / 1MB))
    Write-Host ("release tar.xz: {0:N2} MiB ({1} bytes)" -f ($archiveBytes / 1MB), $archiveBytes)
    Write-Host "sha256: $archiveHash"
    Write-Host "artifact -> $Archive"
    if ($MaxPackageBytes -and $archiveBytes -gt $MaxPackageBytes) {
        throw "release package exceeds budget: $archiveBytes > $MaxPackageBytes bytes"
    }
} finally {
    Remove-Item $Tar -Force -ErrorAction SilentlyContinue
}
