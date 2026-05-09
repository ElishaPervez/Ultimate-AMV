import json
from datetime import datetime

from .config import STATE_DIR

LOG_FILE = STATE_DIR / "app_logs.json"
TEXT_LOG_FILE = STATE_DIR / "logs" / "ultimate-amv.log"


def add_log(event, message, level="info", details=None):
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logs = get_logs()
    created_at = datetime.now().isoformat(timespec="seconds")
    record = {
        "created_at": created_at,
        "level": level,
        "event": event,
        "message": message,
        "details": details or {},
    }
    logs.insert(0, record)
    LOG_FILE.write_text(json.dumps(logs[:300], indent=2), encoding="utf-8")
    append_terminal_log(f"[{created_at}] [{level.upper()}] {event}: {message}")
    if details:
        append_terminal_log(f"    details: {json.dumps(details, ensure_ascii=False)}")
    return record


def get_logs():
    if not LOG_FILE.exists():
        return []
    try:
        logs = json.loads(LOG_FILE.read_text(encoding="utf-8"))
        return logs if isinstance(logs, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def append_terminal_log(line):
    TEXT_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with TEXT_LOG_FILE.open("a", encoding="utf-8") as handle:
        handle.write(f"{line}\n")


def get_terminal_logs(max_lines=500):
    if not TEXT_LOG_FILE.exists():
        return _json_logs_as_terminal_lines(max_lines)
    try:
        lines = TEXT_LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        if lines:
            return lines[-max_lines:]
        return _json_logs_as_terminal_lines(max_lines)
    except OSError:
        return _json_logs_as_terminal_lines(max_lines)


def _json_logs_as_terminal_lines(max_lines):
    lines = []
    for record in reversed(get_logs()):
        lines.append(
            f"[{record.get('created_at', '')}] [{str(record.get('level', 'info')).upper()}] "
            f"{record.get('event', '')}: {record.get('message', '')}"
        )
        details = record.get("details") or {}
        if details:
            lines.append(f"    details: {json.dumps(details, ensure_ascii=False)}")
    return lines[-max_lines:]
