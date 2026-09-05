# Pre-populates python/Lib/site-packages/ with hardware-independent, overlapping dependencies.
# Run once after a fresh checkout; the wizard then fetches the hardware-dependent
# parts (torch, audio-separator, clip extraction engines, etc.).
#
# What this installs (overlapping essentials for both CPU/GPU modes):
#   pip             - bootstraps the environment
#   numpy 2.4.4     - core math; pinned below 2.5 for Numba 0.65.1
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

# uv installs the same packages several times faster and is what the app itself
# uses at runtime. Fetch it into the tools cache the app already reads from, so
# a dev checkout and a real install behave identically. Version, checksum and
# size are pinned to match tools.json - bump them together.
$uvVersion = "0.11.32"
$uvSha256  = "acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984"
$toolsDir  = Join-Path $env:LOCALAPPDATA "com.elishapervez.ultimateamv\tools"
$uvExe     = Join-Path $toolsDir "uv.exe"

if (-not (Test-Path $uvExe)) {
    Write-Host "Fetching uv $uvVersion..."
    $uvZip = Join-Path $env:TEMP "uv-$uvVersion.zip"
    try {
        Invoke-WebRequest -Uri "https://github.com/astral-sh/uv/releases/download/$uvVersion/uv-x86_64-pc-windows-msvc.zip" -OutFile $uvZip
        $actual = (Get-FileHash -Path $uvZip -Algorithm SHA256).Hash
        if ($actual -ne $uvSha256.ToUpper()) {
            throw "checksum mismatch (expected $uvSha256, got $actual)"
        }
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        $staging = Join-Path $env:TEMP "uv-$uvVersion-extract"
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -Path $uvZip -DestinationPath $staging -Force
        Copy-Item (Join-Path $staging "uv.exe") $uvExe -Force
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
    } catch {
        # Never fatal. A blocked download costs a slower bundle step, not a
        # broken checkout - the pip path below still works.
        Write-Host "Could not fetch uv ($_). Falling back to pip."
    } finally {
        Remove-Item $uvZip -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "uv already present at $uvExe"
}

Write-Host "Installing overlapping core dependencies..."
if (Test-Path $uvExe) {
    & $uvExe pip install --python $python --no-config "numpy==2.4.4" pydub pillow tqdm typing_extensions
} else {
    & $python -I -m pip install "numpy==2.4.4" pydub pillow tqdm typing_extensions
}
if ($LASTEXITCODE -ne 0) { Write-Error "dependency install failed (exit $LASTEXITCODE)" }

& $python -I -c "import numpy; assert numpy.__version__ == '2.4.4', f'Expected NumPy 2.4.4, loaded {numpy.__version__}'"
if ($LASTEXITCODE -ne 0) { Write-Error "NumPy runtime verification failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Done. python/Lib/site-packages/ is populated with THIN bundle and ready."
Write-Host "Run the wizard (Settings > Setup GPU/CPU) to install hardware-dependent packages."
