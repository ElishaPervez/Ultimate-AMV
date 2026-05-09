import copy
import json
import logging
import os
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = BACKEND_DIR / "models"


def _default_state_dir():
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "com.elishapervez.ultimateamv"
    base = os.environ.get("XDG_DATA_HOME")
    if base:
        return Path(base) / "ultimate-amv"
    return Path.home() / ".local" / "share" / "ultimate-amv"


STATE_DIR = Path(os.environ.get("ULTIMATE_AMV_STATE_DIR") or _default_state_dir())
CONFIG_FILE = STATE_DIR / "config.json"
HISTORY_FILE = STATE_DIR / "audio_history.json"

DEFAULT_CONFIG = {
    "recent_files": [],
    "max_recent": 20,
    "force_cpu": False,
    "setup_type": "cpu",
    "clip_extraction_mode": "cpu",
    "setup_complete": False,
    "download_path": "",
    "theme": "cyan",
    "theme_color_a": "#48d7ff",
    "theme_color_b": "#63e6a2",
}


def _default_config():
    return copy.deepcopy(DEFAULT_CONFIG)


def ensure_dirs():
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)


def load_config():
    ensure_dirs()
    if not CONFIG_FILE.exists():
        config = _default_config()
        save_config(config)
        return config
    try:
        return {**_default_config(), **json.loads(CONFIG_FILE.read_text(encoding="utf-8"))}
    except (json.JSONDecodeError, OSError) as exc:
        logging.warning("Could not load audio config: %s", exc)
        return _default_config()


def save_config(config):
    ensure_dirs()
    CONFIG_FILE.write_text(json.dumps(config, indent=2), encoding="utf-8")


def add_recent_file(path):
    config = load_config()
    recents = config.get("recent_files", [])
    if path in recents:
        recents.remove(path)
    recents.insert(0, path)
    config["recent_files"] = recents[: config.get("max_recent", 20)]
    save_config(config)


def get_history():
    if not HISTORY_FILE.exists():
        return []
    try:
        history = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        return history if isinstance(history, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def add_history(record):
    history = get_history()
    record = {
        "created_at": datetime.now().isoformat(timespec="seconds"),
        **record,
    }
    history.insert(0, record)
    HISTORY_FILE.write_text(json.dumps(history[:100], indent=2), encoding="utf-8")
    return record
