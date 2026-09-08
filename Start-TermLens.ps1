param([string]$DataDirectory = (Join-Path $PSScriptRoot 'data'))
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'DataDirectory must be an absolute path.' }
$env:TERMLENS_DATA_DIR = [IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Force -Path $env:TERMLENS_DATA_DIR | Out-Null
$env:TEMP = Join-Path $env:TERMLENS_DATA_DIR 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$packaged = Join-Path $PSScriptRoot 'release\win-unpacked\TermLens.exe'
if (Test-Path -LiteralPath $packaged) {
    Start-Process -FilePath $packaged -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} else {
    $electron = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path -LiteralPath $electron)) { throw 'Run npm ci first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'out\main\index.js'))) { throw 'Run npm run build first.' }
    Start-Process -FilePath $electron -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
