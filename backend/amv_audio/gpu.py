import subprocess

from .installer import install_cmd, runtime_constraints_file, uninstall_cmd
from .runtime_versions import (
    NELUX_PACKAGE,
    NUMBA_PACKAGE,
    NUMPY_PACKAGE,
    TORCH_PACKAGES,
)
AUDIO_RUNTIME_PACKAGES = [
    "audioop-lts",
    "beartype>=0.18.5,<0.19.0",
    "diffq-fixed",
    "einops",
    "julius",
    "librosa",
    "ml_collections",
    NUMBA_PACKAGE,
    NUMPY_PACKAGE,
    "onnx-weekly",
    "pyyaml",
    "requests",
    "resampy",
    "samplerate==0.1.0",
    "scipy<2.0.0,>=1.13.0",
    "six",
    "soundfile",
    "flatbuffers",
    "packaging",
    "protobuf",
]


def check_nvidia_gpu():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split("\n")[0].strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None


TORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu"
TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu128"


def _package_names(packages):
    return [package.split("==")[0] for package in packages]


def get_torch_install_cmd(gpu):
    # Reinstall + upgrade swaps a +cpu build for a +cu128 build (or the other
    # way) in one shot. The replacement is downloaded before the existing
    # install is touched, so a network failure mid-repair leaves the prior
    # working install in place instead of an empty hole the Settings panel
    # reports as "missing".
    #
    # Both are scoped to the three PyTorch packages. Left unscoped, uv reads
    # them as applying to everything it resolves, so one mode switch rewrote
    # all 14 packages in PyTorch's dependency chain and took their versions
    # from PyTorch's own download site -- which quietly downgraded
    # typing_extensions on the way past.
    return install_cmd(
        TORCH_PACKAGES,
        index_url=TORCH_CUDA_INDEX if gpu else TORCH_CPU_INDEX,
        upgrade_packages=_package_names(TORCH_PACKAGES),
        reinstall_packages=_package_names(TORCH_PACKAGES),
        constraints=runtime_constraints_file(),
    )


def _get_uninstall_cmd(packages):
    return uninstall_cmd(packages)


def get_numeric_runtime_repair_cmd():
    # A silent app update can overwrite NumPy's module files while leaving an
    # older version record behind. Forcing the reinstall is required because a
    # normal install trusts that stale record and reports the broken
    # environment as already satisfied.
    #
    # Deliberately the blunt form: this is the last-resort repair, and it has
    # to rewrite the compiler layer Numba loads as well as the two packages
    # named here. The pin file is what keeps the blunt form from overshooting.
    return install_cmd(
        [NUMPY_PACKAGE, NUMBA_PACKAGE],
        upgrade=True,
        reinstall=True,
        constraints=runtime_constraints_file(),
    )


def get_gpu_switch_cmds(
    *,
    reinstall_torch=True,
    cleanup_cpu_runtime=True,
    install_audio_separator=True,
    force_reinstall_nelux=False,
    repair_numeric_runtime=False,
):
    cmds = []
    # We only pre-uninstall the *opposite* runtime (onnxruntime CPU when
    # switching to GPU): keeping both installed would let pip resolve to
    # whichever was on path. Torch swaps via --force-reinstall in the
    # install step itself so a failed download cannot leave the user with
    # no torch at all.
    if cleanup_cpu_runtime:
        uninstall_cmd = _get_uninstall_cmd(["onnxruntime"])
        if uninstall_cmd:
            cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(True))
    if install_audio_separator:
        # GPU mode: install audio-separator[gpu], nelux, and transnetv2-pytorch.
        #
        # The constraints file is load-bearing. This step installs from the
        # public package index with --upgrade, and several of these packages
        # depend on PyTorch. Without the constraint the upgrade drags PyTorch
        # forward to whatever is newest there: a build with no CUDA in it, and
        # a version the GPU clip engine refuses to load against because its
        # native files are compiled for one specific PyTorch release. The
        # symptom is setup finishing "successfully" and the Settings panel
        # immediately asking for CUDA PyTorch again, with GPU clip detection
        # dead until it is reinstalled.
        cmds.append(
            install_cmd(
                [
                    "typing_extensions",
                    "audio-separator[gpu]",
                    NELUX_PACKAGE,
                    "transnetv2-pytorch",
                    *AUDIO_RUNTIME_PACKAGES,
                ],
                upgrade=True,
                constraints=runtime_constraints_file(),
            )
        )
    if force_reinstall_nelux:
        # The version record says nelux is installed but its native files
        # cannot actually load (e.g. one was quarantined by antivirus). A
        # plain install would short-circuit as already-satisfied.
        cmds.append(install_cmd([NELUX_PACKAGE], reinstall=True, no_deps=True))
    if repair_numeric_runtime:
        # Run this last so another setup dependency cannot replace the tested
        # NumPy/Numba pair afterward.
        cmds.append(get_numeric_runtime_repair_cmd())
    return cmds


def get_cpu_switch_cmds(
    *,
    reinstall_torch=True,
    cleanup_gpu_runtime=True,
    install_onnxruntime=True,
    install_audio_separator=True,
    repair_numeric_runtime=False,
):
    cmds = []
    # See get_gpu_switch_cmds for why only the opposite runtime is
    # pre-uninstalled here : torch is swapped in-place via --force-reinstall.
    if cleanup_gpu_runtime:
        uninstall_cmd = _get_uninstall_cmd(["onnxruntime-gpu"])
        if uninstall_cmd:
            cmds.append(uninstall_cmd)
    if reinstall_torch:
        cmds.append(get_torch_install_cmd(False))
    if install_onnxruntime:
        # Scoped, and carrying the pin file. This is the step that killed the
        # audio engine on a GPU -> CPU switch: told simply to "upgrade", uv
        # also pulled NumPy to the newest release on the index, Numba cannot
        # load against it, and audio separation was dead the moment the switch
        # reported success.
        cmds.append(
            install_cmd(
                ["onnxruntime"],
                upgrade_packages=["onnxruntime"],
                constraints=runtime_constraints_file(),
            )
        )
    if install_audio_separator:
        # CPU mode: install audio-separator and scenedetect. Constrained for
        # the same reason as the GPU path — see get_gpu_switch_cmds. CPU mode
        # has no CUDA to lose, but the pinned PyTorch version still has to
        # survive so both modes stay on one tested pair.
        cmds.append(
            install_cmd(
                [
                    "typing_extensions",
                    "audio-separator",
                    "scenedetect>=0.6.7,<0.8",
                    *AUDIO_RUNTIME_PACKAGES,
                ],
                upgrade=True,
                constraints=runtime_constraints_file(),
            )
        )
    if repair_numeric_runtime:
        cmds.append(get_numeric_runtime_repair_cmd())
    return cmds
