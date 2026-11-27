"""Apply one persisted monitoring slot to a service's incident state."""

from dataclasses import dataclass
from typing import Literal

INTERVAL_SECONDS = 60
FAILURES_TO_OPEN = 3


@dataclass(frozen=True)
class Transition:
    down_streak: int = 0
    first_down_at: int | None = None
    event: Literal["down", "recovered"] | None = None
    started_at: int | None = None


def transition(
    *,
    state: str,
    slot: int,
    previous_slot: int | None,
    down_streak: int,
    first_down_at: int | None,
    incident_open: bool,
) -> Transition:
    """Evaluate an increasing sequence of UTC minute slots."""
    if incident_open:
        return Transition(event="recovered") if state == "up" else Transition()
    if state != "down":
        return Transition()

    if previous_slot != slot - INTERVAL_SECONDS or first_down_at is None:
        return Transition(down_streak=1, first_down_at=slot)
    if down_streak + 1 >= FAILURES_TO_OPEN:
        return Transition(event="down", started_at=first_down_at)
    return Transition(down_streak=down_streak + 1, first_down_at=first_down_at)
