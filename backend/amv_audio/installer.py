"""Builds every package install/uninstall command the app runs.

Two installers can do the work. uv is preferred because it keeps packages
unpacked and links to them instead of rewriting them: swapping the CUDA
PyTorch build for the CPU one takes ~6s through uv against ~82s through pip,
which is the whole cost of a mode switch. pip stays as the fallback because uv
is downloaded on demand, and a download can be blocked by antivirus or a
locked-down network. A user in that situation must get the slow install, not a
dead end.

Both tools write the same on-disk records, so a half-migrated environment is
still a working environment and either tool can see what the other installed.

Hermeticity: uv is only ever run from the app's own tools directory, never off
PATH, always with --no-config, and always with UV_*/PIP_* variables stripped
from its environment. Otherwise a stray setting on a user's machine could
redirect where the app's packages come from.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .runtime_versions import NUMBA_PACKAGE, NUMPY_PACKAGE, TORCH_PACKAGES

_UV_EXE = "uv.exe" if os.name == "nt" else "uv"

# Set to "pip" or "uv" to force one installer; anything else means "prefer uv,
# fall back to pip". This exists so a mode switch can be timed both ways
# without editing code. It is read from the environment only, so it has no
# surface in a shipped build.
_OVERRIDE_VAR = "ULTIMATE_AMV_INSTALLER"

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Probing uv costs a process spawn. The answer cannot change while the app is
# running, so resolve it once.
_UV_CACHE = {}


def _override():
    value = (os.environ.get(_OVERRIDE_VAR) or "auto").strip().lower()
    return value if value in {"auto", "uv", "pip"} else "auto"


def _tools_dir():
    """Where the Rust shell puts downloaded tools.

    It exports ULTIMATE_AMV_TOOLS_DIR on every Python sidecar spawn. The
    fallback covers dev runs started outside the shell, and matches the
    fallback tools_dir_path() uses in src-tauri/src/python_env.rs.
    """
    from_env = os.environ.get("ULTIMATE_AMV_TOOLS_DIR")
    if from_env:
        return Path(from_env)
    return Path(sys.executable).resolve().parent.parent / "tools"


def uv_path():
    """Full path to the app's own uv, or None. Never consults PATH."""
    if _override() == "pip":
        return None
    candidate = _tools_dir() / _UV_EXE
    return candidate if candidate.is_file() else None


def uv_available(refresh=False):
    """True when uv is present AND actually starts.

    A quarantined or truncated file passes the exists check and then fails at
    spawn time, which would surface as a setup failure instead of a fallback.
    """
    if refresh:
        _UV_CACHE.clear()
    if "available" in _UV_CACHE:
        return _UV_CACHE["available"]

    path = uv_path()
    if path is None:
        _UV_CACHE["available"] = False
        return False
    try:
        result = subprocess.run(
            [str(path), "--version", "--no-config"],
            capture_output=True,
            timeout=20,
            env=subprocess_env(),
            creationflags=_NO_WINDOW,
        )
        ok = result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    _UV_CACHE["available"] = ok
    return ok


def active_installer():
    """Which installer commands will be built for: "uv" or "pip"."""
    if _override() == "pip":
        return "pip"
    if _override() == "uv":
        # Forced. Still degrade rather than build a command that cannot run.
        return "uv" if uv_available() else "pip"
    return "uv" if uv_available() else "pip"


def subprocess_env():
    """Environment for an installer subprocess.

    UV_* and PIP_* are dropped so a setting on the user's machine cannot point
    the app's installs at a different index or cache. Everything else is
    inherited: ULTIMATE_AMV_TOOLS_DIR in particular has to survive.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("UV_") and not key.startswith("PIP_")
    }
    # uv renders progress bars and colour when it thinks it has a terminal.
    # Both corrupt the setup log, which is streamed line by line into the UI.
    env["NO_COLOR"] = "1"
    return env


def runtime_constraints_file():
    """A constraints file pinning every version no install is allowed to move.

    Hand this to every install command. Installs run with --upgrade, and uv
    applies that to every package it resolves, not only the ones named on the
    command line. Unpinned, installing something as unrelated as the CPU ONNX
    runtime pulls NumPy forward to the newest release on the index; Numba
    refuses to load against it, and audio separation stops working the moment
    a mode switch reports success.

    PyTorch is pinned for the same reason: several audio packages depend on
    it, and an unconstrained upgrade replaces the tested build with a generic
    one that has no CUDA in it and a version the GPU clip engine cannot load
    against. It does not force a CUDA build to be replaced by a CPU one,
    because "==2.11.0" is satisfied by "2.11.0+cu128".

    Deterministic name so repeated runs overwrite one file instead of leaving
    a trail of them.
    """
    path = Path(tempfile.gettempdir()) / "ultimate-amv-runtime-pin.txt"
    pins = [*TORCH_PACKAGES, NUMPY_PACKAGE, NUMBA_PACKAGE]
    path.write_text("\n".join(pins) + "\n", encoding="utf-8")
    return path


def install_cmd(
    packages,
    *,
    index_url=None,
    upgrade=False,
    reinstall=False,
    upgrade_packages=None,
    reinstall_packages=None,
    no_deps=False,
    constraints=None,
    force_pip=False,
):
    """Build an install command for whichever installer is active.

    `upgrade`/`reinstall` are the blunt forms: with uv they apply to every
    package in the resolution, so they can move libraries nobody asked about.
    `upgrade_packages`/`reinstall_packages` name exactly which packages may be
    moved and leave everything else where it is. Prefer the scoped forms
    whenever the command exists to change specific packages.
    """
    packages = list(packages)
    upgrade_packages = list(upgrade_packages or [])
    reinstall_packages = list(reinstall_packages or [])
    use_uv = not force_pip and active_installer() == "uv"

    if use_uv:
        cmd = [
            str(uv_path()),
            "pip",
            "install",
            "--python",
            sys.executable,
            "--no-config",
            "--no-progress",
        ]
        if upgrade:
            cmd.append("--upgrade")
        for name in upgrade_packages:
            cmd.extend(["--upgrade-package", name])
        if reinstall:
            # uv's --reinstall is the equivalent of pip's --force-reinstall:
            # it replaces the files even when the recorded version already
            # matches, which is the whole point when a bad update left the
            # records and the files disagreeing.
            cmd.append("--reinstall")
        for name in reinstall_packages:
            cmd.extend(["--reinstall-package", name])
    else:
        cmd = [sys.executable, "-I", "-m", "pip", "install"]
        if upgrade or upgrade_packages:
            # pip needs no scoping here: it only replaces a dependency that
            # the new requirement cannot live with, so an upgrade of one
            # package already leaves the rest of the environment alone.
            cmd.append("--upgrade")
        if reinstall or reinstall_packages:
            cmd.append("--force-reinstall")

    if no_deps:
        cmd.append("--no-deps")
    if constraints:
        cmd.extend(["-c", str(constraints)])
    cmd.extend(packages)
    if index_url:
        cmd.extend(["--index-url", index_url])
    return cmd


def uninstall_cmd(packages, *, force_pip=False):
    packages = list(packages)
    if not packages:
        return None
    if not force_pip and active_installer() == "uv":
        return [
            str(uv_path()),
            "pip",
            "uninstall",
            "--python",
            sys.executable,
            "--no-config",
            *packages,
        ]
    return [sys.executable, "-I", "-m", "pip", "uninstall", "-y", *packages]


def is_uv_cmd(cmd):
    """True when this command runs uv rather than pip."""
    if not cmd:
        return False
    return Path(str(cmd[0])).name.lower() == _UV_EXE


def to_pip_cmd(cmd):
    """Rewrite a uv command as the equivalent pip command.

    Used to retry through pip when uv turns out to be unusable at the moment
    it is needed. Returns None when the command is already a pip command.
    """
    if not is_uv_cmd(cmd):
        return None
    rest = list(cmd[1:])
    if rest[:2] == ["pip", "install"]:
        action = "install"
    elif rest[:2] == ["pip", "uninstall"]:
        action = "uninstall"
    else:
        return None
    rest = rest[2:]

    out = [sys.executable, "-I", "-m", "pip", action]
    if action == "uninstall":
        out.append("-y")

    skip_next = False
    for token in rest:
        if skip_next:
            skip_next = False
            continue
        if token == "--python":
            skip_next = True
            continue
        if token in {"--no-config", "--no-progress"}:
            continue
        if token in {"--upgrade", "--upgrade-package"}:
            # pip has no per-package upgrade switch and does not need one: its
            # upgrade only touches a dependency the new requirement cannot
            # live with. Drop the package name that follows the scoped form.
            skip_next = token == "--upgrade-package"
            if "--upgrade" not in out:
                out.append("--upgrade")
            continue
        if token in {"--reinstall", "--reinstall-package"}:
            # pip cannot scope a forced reinstall -- it rewrites the
            # dependencies too. That is what it always did before uv existed,
            # so the fallback is no worse than the old behaviour.
            skip_next = token == "--reinstall-package"
            if "--force-reinstall" not in out:
                out.append("--force-reinstall")
            continue
        out.append(token)
    return out


def recorded_version(package):
    """The version a package has on record, or None when that cannot be read.

    An install that dies partway leaves the record folder on disk with the
    file describing the package gone. Python 3.13 answers the version question
    with nothing at all in that case instead of saying the package is absent,
    so every caller that went on to search the answer for text crashed and
    took the whole command down with it. Anything that is not a usable version
    string comes back as None here, which leaves callers one case to handle:
    the version is unknown, so treat the package as not installed.
    """
    import importlib
    from importlib.metadata import PackageNotFoundError, version

    # The setup run installs packages and then re-checks them inside the same
    # process. Directory listings are cached, so without this a package that
    # was just installed can still read as missing and setup reports failure
    # on work it actually completed.
    importlib.invalidate_caches()
    try:
        found = version(package)
    except PackageNotFoundError:
        return None
    except Exception:
        return None
    if not isinstance(found, str):
        return None
    found = found.strip()
    return found or None


def is_installed(package):
    """Whether a distribution is recorded as installed.

    Replaces asking pip, which cost a fresh Python process per question and
    six of those ran every time the setup screen opened. This reads the same
    records both installers write, so it is correct either way.

    A package whose record exists but says nothing counts as not installed.
    Answering yes there tells setup a package it cannot verify is fine, so the
    install that would repair it never runs.
    """
    return recorded_version(package) is not None


def prune_cache():
    """Drop cache entries nothing references any more. Never fatal, never loud.

    uv keeps packages unpacked so a repeat install is a relink instead of a
    rewrite. Over releases that accumulates versions nothing uses. Pruning
    only removes entries no installed package points at.
    """
    if active_installer() != "uv":
        return False
    try:
        subprocess.run(
            [str(uv_path()), "cache", "prune", "--no-config"],
            capture_output=True,
            timeout=120,
            env=subprocess_env(),
            creationflags=_NO_WINDOW,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def summarize_failure(output_lines, code):
    """Pick the line that explains a failed install.

    Both installers put the useful sentence last, but they label it
    differently: pip writes "ERROR:", uv writes lines beginning with "error:"
    or "× ". Version-nag lines are dropped so they cannot win.
    """
    lines = [line.strip() for line in output_lines if line and line.strip()]
    lines = [
        line
        for line in lines
        if not line.startswith("[notice]")
        and "A new release of pip" not in line
        and "To update, run:" not in line
    ]
    for line in reversed(lines):
        lowered = line.lower()
        if "error:" in lowered or line.startswith("×") or lowered.startswith("failed"):
            return line
    return lines[-1] if lines else f"Command failed with exit code {code}"
