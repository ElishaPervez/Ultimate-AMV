import io
import logging
import os
import re
import sys
from pathlib import Path

from .config import MODELS_DIR, add_recent_file, ensure_dirs
from .hardware import get_hw_info
from .models import get_active_model, get_model_display_name, get_model_settings


class TqdmCapture(io.StringIO):
    TQDM_PATTERN = re.compile(r"(\d+)%\|")

    def __init__(self, callback=None, original_stderr=None):
        super().__init__()
        self.callback = callback
        self.original_stderr = original_stderr or sys.__stderr__
        self.last_percent = -1
        self.sent_indeterminate = False

    def write(self, text):
        if self.original_stderr:
            self.original_stderr.write(text)
        cleaned = text.strip()
        if self.callback and cleaned:
            match = self.TQDM_PATTERN.search(cleaned)
            if match:
                percent = int(match.group(1))
                if percent != self.last_percent:
                    self.last_percent = percent
                    self.callback(percent, cleaned)
            elif not self.sent_indeterminate and ("iB" in cleaned or "B/s" in cleaned):
                self.sent_indeterminate = True
                self.callback(-1, cleaned)
        return super().write(text)

    def flush(self):
        if self.original_stderr:
            self.original_stderr.flush()
        super().flush()


def _pad_audio_if_needed(input_path, output_dir):
    try:
        from pydub import AudioSegment

        pydub_ok = True
    except ImportError:
        AudioSegment = None
        pydub_ok = False

    temp_input_path = None
    processing_input = str(input_path)
    is_padded = False
    original_duration_ms = 0

    if pydub_ok:
        audio = AudioSegment.from_file(str(input_path))
        original_duration_ms = len(audio)
        if original_duration_ms < 10000:
            padding = 10000 - original_duration_ms + 1000
            padded = audio + AudioSegment.silent(duration=padding)
            temp_input_path = output_dir / f"temp_{input_path.stem}.wav"
            padded.export(str(temp_input_path), format="wav")
            processing_input = str(temp_input_path)
            is_padded = True

    return processing_input, temp_input_path, is_padded, original_duration_ms, pydub_ok


def _run_audio_separator(processing_input, output_dir, model_name, model_settings, hw, progress_callback, output_format):
    from audio_separator.separator import Separator

    if progress_callback:
        progress_callback("loading", -1, "Loading AI model...")

    mdx_params = {}
    vr_params = {}
    if model_settings["fp16"]:
        mdx_params["enable_fp16"] = True
    if model_settings["batch_size"] > 1:
        mdx_params["batch_size"] = model_settings["batch_size"]
        vr_params["batch_size"] = model_settings["batch_size"]

    sep_config = {
        "log_level": logging.ERROR,
        "model_file_dir": str(MODELS_DIR),
        "output_dir": str(output_dir),
        "output_format": output_format.upper(),
    }
    if mdx_params:
        sep_config["mdx_params"] = mdx_params
    if vr_params:
        sep_config["vr_params"] = vr_params
    if model_settings.get("fp16") and hw.get("gpu_type") != "cpu":
        sep_config["use_autocast"] = True

    phase = {"name": "model-download"}

    def on_tqdm_progress(percent, _raw_text):
        if not progress_callback:
            return
        if phase["name"] == "model-download":
            progress_callback("model-download", percent, "Downloading AI model files...")
        elif percent >= 0:
            progress_callback("processing", percent, f"{percent}% complete")

    original_stderr = sys.stderr
    capture = TqdmCapture(callback=on_tqdm_progress, original_stderr=original_stderr)
    try:
        sys.stderr = capture
        separator = Separator(**sep_config)
        separator.load_model(model_filename=model_name)
        phase["name"] = "processing"

        if progress_callback:
            device_label = "CUDA (FP16)" if hw.get("gpu_type") != "cpu" and model_settings.get("fp16") else "CPU"
            progress_callback("processing", 0, f"Processing on {device_label}...")
        output_files = separator.separate(processing_input)
    finally:
        sys.stderr = original_stderr

    if not output_files:
        raise RuntimeError("Separation produced no output files")

    return output_files


def _process_output_files(output_files, input_path, output_dir, is_padded, pydub_ok, original_duration_ms, output_format):
    clean_stem = input_path.stem.replace(" (original)", "")
    outputs = []
    original_backup = None

    if "(original)" not in input_path.stem:
        backup_path = output_dir / f"{input_path.stem} (original){input_path.suffix}"
        if not backup_path.exists():
            try:
                os.rename(str(input_path), str(backup_path))
                original_backup = str(backup_path)
            except OSError as exc:
                logging.warning("Could not backup original file: %s", exc)

    for item in output_files:
        src = Path(item)
        if not src.is_absolute():
            src = output_dir / item
        if not src.exists():
            continue

        if is_padded and pydub_ok:
            try:
                from pydub import AudioSegment
                AudioSegment.from_file(str(src))[:original_duration_ms].export(str(src), format=output_format)
            except Exception as exc:
                logging.warning("Could not trim padded audio: %s", exc)

        suffix = "[vocals]" if "vocal" in src.name.lower() else "[instrumental]"
        dst = output_dir / f"{clean_stem} {suffix}{src.suffix}"
        if dst.exists():
            os.remove(str(dst))
        os.rename(str(src), str(dst))
        outputs.append(str(dst))

    return outputs, original_backup


def _cleanup_resources(temp_input_path):
    if temp_input_path and temp_input_path.exists():
        try:
            temp_input_path.unlink()
        except OSError:
            pass

    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def run_separation(input_file, model_name=None, progress_callback=None, output_format="wav"):
    ensure_dirs()
    input_path = Path(input_file)
    if not input_path.is_file():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    output_format = (output_format or "wav").lower()
    if output_format not in {"wav", "mp3"}:
        output_format = "wav"

    hw = get_hw_info()
    if model_name is None:
        model_name = get_active_model(hw)
    model_settings = get_model_settings(model_name, hw)

    output_dir = input_path.parent
    temp_input_path = None

    try:
        processing_input, temp_input_path, is_padded, original_duration_ms, pydub_ok = _pad_audio_if_needed(
            input_path, output_dir
        )

        output_files = _run_audio_separator(
            processing_input, output_dir, model_name, model_settings, hw, progress_callback, output_format
        )

        if progress_callback:
            progress_callback("finalizing", 96, "Saving stems...")

        outputs, original_backup = _process_output_files(
            output_files, input_path, output_dir, is_padded, pydub_ok, original_duration_ms, output_format
        )

        add_recent_file(str(input_path))

        if progress_callback:
            progress_callback("complete", 100, "Extraction complete")

        return {"ok": True, "outputs": outputs}
    finally:
        _cleanup_resources(temp_input_path)
