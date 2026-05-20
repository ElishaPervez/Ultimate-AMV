"""
Tests for backend/amv_audio/logs.py

Covers:
- add_log: creates record with correct shape, inserts at front, caps at 300
- get_logs: returns [] when file missing, returns list when valid, handles corrupt JSON
- append_terminal_log: appends line to text log file
- get_terminal_logs: reads from text log, falls back to json logs
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock
from datetime import datetime

import pytest

_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))


# ---------------------------------------------------------------------------
# Helpers to redirect log file paths via monkeypatching
# ---------------------------------------------------------------------------


def _get_log_module(tmp_path):
    """Import logs module and return (module, log_file_path, text_log_file_path)."""
    import amv_audio.logs as logs_mod
    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"
    return logs_mod, log_file, text_log_file


# ---------------------------------------------------------------------------
# get_logs
# ---------------------------------------------------------------------------


def test_get_logs_returns_empty_list_when_file_missing(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    with patch.object(logs_mod, "LOG_FILE", log_file):
        result = logs_mod.get_logs()
    assert result == []


def test_get_logs_returns_list_from_valid_file(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    records = [{"event": "test", "message": "hello", "level": "info", "details": {}, "created_at": "2024-01-01T00:00:00"}]
    log_file.write_text(json.dumps(records), encoding="utf-8")

    with patch.object(logs_mod, "LOG_FILE", log_file):
        result = logs_mod.get_logs()
    assert len(result) == 1
    assert result[0]["event"] == "test"


def test_get_logs_returns_empty_on_corrupt_json(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    log_file.write_text("{ broken!!!", encoding="utf-8")

    with patch.object(logs_mod, "LOG_FILE", log_file):
        result = logs_mod.get_logs()
    assert result == []


def test_get_logs_returns_empty_when_content_is_not_list(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    log_file.write_text(json.dumps({"not": "a list"}), encoding="utf-8")

    with patch.object(logs_mod, "LOG_FILE", log_file):
        result = logs_mod.get_logs()
    assert result == []


# ---------------------------------------------------------------------------
# add_log
# ---------------------------------------------------------------------------


def test_add_log_creates_record_with_correct_fields(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"

    with patch.object(logs_mod, "LOG_FILE", log_file), \
         patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        record = logs_mod.add_log("test.event", "Test message", level="warning", details={"x": 1})

    assert record["event"] == "test.event"
    assert record["message"] == "Test message"
    assert record["level"] == "warning"
    assert record["details"] == {"x": 1}
    assert "created_at" in record


def test_add_log_inserts_at_front_of_list(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"

    existing = [{"event": "old", "message": "old", "level": "info", "details": {}, "created_at": "x"}]
    log_file.write_text(json.dumps(existing), encoding="utf-8")

    with patch.object(logs_mod, "LOG_FILE", log_file), \
         patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        logs_mod.add_log("new.event", "New message")
        result = logs_mod.get_logs()

    assert result[0]["event"] == "new.event"
    assert result[1]["event"] == "old"


def test_add_log_caps_at_300_records(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"

    existing = [{"event": f"e{i}", "message": "m", "level": "info", "details": {}, "created_at": "x"} for i in range(300)]
    log_file.write_text(json.dumps(existing), encoding="utf-8")

    with patch.object(logs_mod, "LOG_FILE", log_file), \
         patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        logs_mod.add_log("new.event", "New message")
        result = logs_mod.get_logs()

    assert len(result) <= 300


def test_add_log_writes_to_disk(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"

    with patch.object(logs_mod, "LOG_FILE", log_file), \
         patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        logs_mod.add_log("disk.test", "Should be written")

    assert log_file.exists()
    on_disk = json.loads(log_file.read_text(encoding="utf-8"))
    assert isinstance(on_disk, list)
    assert on_disk[0]["event"] == "disk.test"


# ---------------------------------------------------------------------------
# append_terminal_log
# ---------------------------------------------------------------------------


def test_append_terminal_log_creates_file_and_appends(tmp_path):
    import amv_audio.logs as logs_mod

    text_log_file = tmp_path / "logs" / "ultimate-amv.log"

    with patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        logs_mod.append_terminal_log("line one")
        logs_mod.append_terminal_log("line two")

    content = text_log_file.read_text(encoding="utf-8")
    assert "line one\n" in content
    assert "line two\n" in content


def test_append_terminal_log_appends_not_overwrites(tmp_path):
    import amv_audio.logs as logs_mod

    text_log_file = tmp_path / "logs" / "ultimate-amv.log"
    text_log_file.parent.mkdir(parents=True, exist_ok=True)
    text_log_file.write_text("existing line\n", encoding="utf-8")

    with patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file):
        logs_mod.append_terminal_log("new line")

    content = text_log_file.read_text(encoding="utf-8")
    assert "existing line" in content
    assert "new line" in content


# ---------------------------------------------------------------------------
# get_terminal_logs
# ---------------------------------------------------------------------------


def test_get_terminal_logs_returns_lines_from_text_file(tmp_path):
    import amv_audio.logs as logs_mod

    text_log_file = tmp_path / "logs" / "ultimate-amv.log"
    text_log_file.parent.mkdir(parents=True, exist_ok=True)
    text_log_file.write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    with patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file), \
         patch.object(logs_mod, "LOG_FILE", tmp_path / "app_logs.json"):
        lines = logs_mod.get_terminal_logs(max_lines=500)

    assert "alpha" in lines
    assert "gamma" in lines


def test_get_terminal_logs_respects_max_lines(tmp_path):
    import amv_audio.logs as logs_mod

    text_log_file = tmp_path / "logs" / "ultimate-amv.log"
    text_log_file.parent.mkdir(parents=True, exist_ok=True)
    text_log_file.write_text("\n".join(f"line{i}" for i in range(100)) + "\n", encoding="utf-8")

    with patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file), \
         patch.object(logs_mod, "LOG_FILE", tmp_path / "app_logs.json"):
        lines = logs_mod.get_terminal_logs(max_lines=10)

    assert len(lines) <= 10


def test_get_terminal_logs_falls_back_to_json_when_text_log_missing(tmp_path):
    import amv_audio.logs as logs_mod

    log_file = tmp_path / "app_logs.json"
    text_log_file = tmp_path / "logs" / "ultimate-amv.log"
    records = [{"event": "fallback.test", "message": "from json", "level": "info", "details": {}, "created_at": "2024-01-01T00:00:00"}]
    log_file.write_text(json.dumps(records), encoding="utf-8")

    with patch.object(logs_mod, "TEXT_LOG_FILE", text_log_file), \
         patch.object(logs_mod, "LOG_FILE", log_file):
        lines = logs_mod.get_terminal_logs()

    joined = "\n".join(lines)
    assert "fallback.test" in joined or "from json" in joined
