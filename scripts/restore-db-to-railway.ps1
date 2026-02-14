# Sube agent-studio.db al volumen de Railway.
# Requisitos: railway CLI en PATH y haber ejecutado "railway link" en esta carpeta.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$dbPath = Join-Path $root "agent-studio.db"

if (-not (Test-Path $dbPath)) {
  Write-Error "No se encuentra agent-studio.db en la raíz del proyecto."
  exit 1
}

Write-Host "Subiendo $dbPath a Railway..."
Get-Content -Path $dbPath -AsByteStream -ReadCount 0 | railway run npm run db:restore
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Listo. Base de datos subida al volumen de Railway."
