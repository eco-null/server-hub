"""Host statistics from /proc (Linux); every value is None when unavailable."""

from __future__ import annotations

import shutil
import socket
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_prev: tuple[int, int] | None = None
_last: tuple[float, float | None] = (0.0, None)


def _read_cpu() -> tuple[int, int] | None:
    try:
        with Path("/proc/stat").open() as f:
            for line in f:
                if line.startswith("cpu "):
                    nums = [int(x) for x in line.split()[1:]]
                    if len(nums) < 4:
                        return None
                    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
                    return sum(nums), idle
    except (OSError, ValueError):
        return None
    return None


def cpu_percent() -> float | None:
    """CPU use since the previous sample; takes a short sample on first call."""
    global _prev, _last
    with _lock:
        now = time.monotonic()
        if _last[1] is not None and now - _last[0] < 1.0:
            return _last[1]
        cur = _read_cpu()
        if cur is None:
            return None
        if _prev is None:
            time.sleep(0.2)
            _prev, cur = cur, _read_cpu()
            if cur is None:
                return None
        total, idle = cur[0] - _prev[0], cur[1] - _prev[1]
        _prev = cur
        value = round(100.0 * (1 - idle / total), 1) if total > 0 else None
        _last = (now, value)
        return value


def memory_percent() -> float | None:
    try:
        data = {}
        with Path("/proc/meminfo").open() as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    data[parts[0].rstrip(":")] = int(parts[1])
        total, available = data.get("MemTotal"), data.get("MemAvailable")
        if not total or available is None:
            return None
        return round(100.0 * (total - available) / total, 1)
    except (OSError, ValueError):
        return None


def disk_percent(path: str = "/") -> float | None:
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    if usage.total <= 0:
        return None
    return round(100.0 * usage.used / usage.total, 1)


def hostname() -> str:
    try:
        name = Path("/etc/hostname").read_text().strip()
    except OSError:
        name = ""
    return name or socket.gethostname()


def snapshot() -> dict:
    return {
        "hostname": hostname(),
        "cpu": cpu_percent(),
        "memory": memory_percent(),
        "disk": disk_percent(),
    }
