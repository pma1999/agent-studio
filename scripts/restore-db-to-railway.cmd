@echo off
REM Sube agent-studio.db al volumen de Railway.
REM Ejecutar desde la raiz del proyecto. Requiere: railway link hecho antes.

set "ROOT=%~dp0.."
set "DB=%ROOT%\agent-studio.db"

if not exist "%DB%" (
  echo No se encuentra agent-studio.db en la raiz del proyecto.
  exit /b 1
)

set "RAILWAY_EXE=%APPDATA%\npm\railway.cmd"
if not exist "%RAILWAY_EXE%" set "RAILWAY_EXE=%APPDATA%\npm\node_modules\@railway\cli\bin\railway"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = '%DB%'; $bytes = $null; try { $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); $bytes = New-Object byte[] $fs.Length; [void]$fs.Read($bytes, 0, $fs.Length); $fs.Close() } catch { Write-Host ('Error: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }; if (-not $bytes -or $bytes.Length -eq 0) { Write-Host 'Error: El archivo esta vacio.' -ForegroundColor Red; exit 1 }; Write-Host ('Subiendo ' + $bytes.Length + ' bytes a Railway...'); $bytes | & '%RAILWAY_EXE%' run npm run db:restore; if ($LASTEXITCODE -ne 0) { exit 1 }"
if errorlevel 1 exit /b 1
echo Listo. Base de datos subida al volumen de Railway.
