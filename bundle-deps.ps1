# Pre-populates python/Lib/site-packages/ with hardware-independent, overlapping dependencies.
# Run once after a fresh checkout; the wizard then fetches the hardware-dependent
# parts (torch, audio-separator, clip extraction engines, etc.).
#
# What this installs (overlapping essentials for both CPU/GPU modes):
#   pip             - bootstraps the environment
#   numpy           - core math for everything
#   pydub           - core audio for everything
#   pillow          - core image handling for thumbnails
#   tqdm            - progress bars for CLI tools
#   typing_extensions - compatibility package used by ML/audio libraries
#
# Results land in python/Lib/site-packages/ which is gitignored but bundled
# by Tauri via tauri.conf.json resources.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root "python\python.exe"

if (-not (Test-Path $python)) {
    Write-Error "Bundled Python not found at $python. Place the embeddable Python distribution in python/ first."
}

# Embeddable Python ships with "import site" commented out in its ._pth file,
# which prevents pip from being found even after installation. Uncomment it.
$pythonDir = Split-Path $python
Get-ChildItem -Path $pythonDir -Filter "*._pth" | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    if ($content -match '#import site') {
        ($content -replace '#import site', 'import site') | Set-Content $_.FullName -NoNewline
        Write-Host "Patched $($_.Name) to enable site-packages."
    }
}

$pipDir = Join-Path $root "python\Lib\site-packages\pip"
if (-not (Test-Path $pipDir)) {
    Write-Host "Bootstrapping pip into bundled Python..."
    $getPip = Join-Path $env:TEMP "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
    & $python -I $getPip
    if ($LASTEXITCODE -ne 0) { Write-Error "pip bootstrap failed (exit $LASTEXITCODE)" }
    Remove-Item $getPip -Force
} else {
    Write-Host "pip already present, skipping bootstrap."
}

Write-Host "Upgrading pip..."
& $python -I -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { Write-Error "pip self-upgrade failed (exit $LASTEXITCODE)" }

Write-Host "Installing overlapping core dependencies..."
& $python -I -m pip install numpy pydub pillow tqdm typing_extensions
if ($LASTEXITCODE -ne 0) { Write-Error "dependency install failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done. python/Lib/site-packages/ is populated with THIN bundle and ready."
Write-Host "Run the wizard (Settings > Setup GPU/CPU) to install hardware-dependent packages."
