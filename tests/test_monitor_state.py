import pytest

from serverhub.integrations.monitor_state import INTERVAL_SECONDS, Transition, transition


@pytest.mark.parametrize(
    ("state", "previous_slot", "before", "incident_open", "after"),
    [
        pytest.param("up", None, Transition(), False, Transition(), id="initial-up"),
        pytest.param("down", None, Transition(), False, Transition(1, 180), id="initial-down"),
        pytest.param("down", 120, Transition(1, 120), False, Transition(2, 120), id="second-down"),
        pytest.param(
            "down",
            120,
            Transition(2, 60),
            False,
            Transition(event="down", started_at=60),
            id="third-down",
        ),
        pytest.param(
            "down", 60, Transition(2, 0), False, Transition(1, 180), id="one-missing-slot"
        ),
        pytest.param("unknown", 120, Transition(2, 60), False, Transition(), id="unknown-resets"),
        pytest.param("up", 120, Transition(2, 60), False, Transition(), id="up-resets"),
        pytest.param("down", 120, Transition(), False, Transition(1, 180), id="down-after-reset"),
        pytest.param("down", 120, Transition(), True, Transition(), id="no-duplicate-down"),
        pytest.param("unknown", 120, Transition(), True, Transition(), id="unknown-keeps-open"),
        pytest.param("down", 60, Transition(), True, Transition(), id="gap-keeps-open"),
        pytest.param(
            "up", 60, Transition(), True, Transition(event="recovered"), id="up-closes-after-gap"
        ),
        pytest.param("up", 120, Transition(), False, Transition(), id="no-duplicate-recovery"),
    ],
)
def test_monitor_transition(state, previous_slot, before, incident_open, after):
    assert (
        transition(
            state=state,
            slot=3 * INTERVAL_SECONDS,
            previous_slot=previous_slot,
            down_streak=before.down_streak,
            first_down_at=before.first_down_at,
            incident_open=incident_open,
        )
        == after
    )
