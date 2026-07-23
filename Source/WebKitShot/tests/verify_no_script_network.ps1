param(
    [string]$BuildDir,
    [int]$Port = 8988,
    [string]$VcpkgTriplet = 'x64-windows-webkit'
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $BuildDir) {
    $BuildDir = Join-Path $Root 'WebKitBuild\shot'
}

$ShotCli = Join-Path $BuildDir 'bin\shotcli.exe'
$FixtureServer = Join-Path $PSScriptRoot 'fixture_server.py'
$Output = Join-Path $BuildDir 'no-script-network.png'
$env:PATH = "$(Join-Path $Root "WebKitBuild\vcpkg_installed\$VcpkgTriplet\bin");$env:PATH"

if (-not (Test-Path -LiteralPath $ShotCli)) {
    throw "shotcli not found: $ShotCli"
}

$Server = Start-Process python -ArgumentList @($FixtureServer, $Port) -PassThru -WindowStyle Hidden
try {
    $BaseUrl = "http://127.0.0.1:$Port"
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 30; ++$Attempt) {
        try {
            Invoke-RestMethod "$BaseUrl/reset-counts" | Out-Null
            $Ready = $true
            break
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $Ready) {
        throw 'fixture server did not become ready'
    }

    & $ShotCli --url "$BaseUrl/script-network" --out $Output --timeout 5000
    if ($LASTEXITCODE -ne 0) {
        throw "shotcli failed with exit code $LASTEXITCODE"
    }

    $Counts = Invoke-RestMethod "$BaseUrl/request-counts"
    $Properties = @($Counts.PSObject.Properties)
    if ($Properties.Count -ne 1 -or $Properties[0].Name -ne '/script-network' -or $Properties[0].Value -ne 1) {
        throw "unexpected network requests: $($Counts | ConvertTo-Json -Compress)"
    }

    Write-Host "NO-SCRIPT NETWORK PASS: $($Counts | ConvertTo-Json -Compress)"
} finally {
    if ($Server -and -not $Server.HasExited) {
        Stop-Process -Id $Server.Id -Force
        $Server.WaitForExit()
    }
}
