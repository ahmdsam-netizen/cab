import time
import pytest
from fastapi.testclient import TestClient
from api.main import app

client = TestClient(app)


def test_health_check():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "healthy"
    assert data["service"] == "dreamcabs-agent-service"


def test_chat_e2e_flow():
    thread_id = "test-e2e-user-99"

    # Step 1: User asks for a ride from Batamaloo to Sopore with luggage (both specified)
    resp1 = client.post(
        "/chat",
        json={
            "message": "I need to book a cab from Batamaloo to Sopore with 2 bags",
            "thread_id": thread_id,
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
            "auth_token": "test-token",
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "CONFIRMING_DEPARTURE"
    assert "Batamaloo" in data1["reply"] or "Sopore" in data1["reply"]
    assert len(data1["options"]) >= 1
    assert data1["luggage"]["has_extra_luggage"] is True
    assert data1["luggage"]["extra_luggage_count"] == 2

    # Step 2: User confirms the ride requesting specific seat 1A
    resp2 = client.post(
        "/chat",
        json={
            "message": "Book seat 1A",
            "thread_id": thread_id,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["stage"] == "AWAITING_DRIVER"
    assert data2["seat_hold_id"] is not None
    assert data2["selected_seats"] == ["1A"]
    assert "Seat 1A" in data2["reply"]
    hold_id = data2["seat_hold_id"]

    # Step 3: Driver rejects -> webhook triggers
    resp3 = client.post(
        "/webhook/driver-event",
        json={
            "seat_hold_id": hold_id,
            "event": "DRIVER_REJECTED",
        },
    )
    assert resp3.status_code == 200
    data3 = resp3.json()
    assert data3["stage"] == "CONFIRMING_DEPARTURE"
    assert "unable to accept" in data3["reply"]
    assert len(data3["options"]) >= 1  # Next departures shown

    # Step 4: User confirms the next departure
    resp4 = client.post(
        "/chat",
        json={
            "message": "Confirm next one",
            "thread_id": thread_id,
        },
    )
    assert resp4.status_code == 200
    data4 = resp4.json()
    assert data4["stage"] == "AWAITING_DRIVER"
    new_hold_id = data4["seat_hold_id"]

    # Step 5: Driver accepts -> webhook triggers
    resp5 = client.post(
        "/webhook/driver-event",
        json={
            "seat_hold_id": new_hold_id,
            "event": "DRIVER_ACCEPTED",
        },
    )
    assert resp5.status_code == 200
    data5 = resp5.json()
    assert data5["stage"] == "ACCEPTED_PAYMENT"
    assert data5["payment_order"] is not None
    assert "Confirmed" in data5["reply"]


def test_missing_boarding_and_luggage_clarification_loop():
    thread_id = "test-clarification-loop-user-1"

    # Step 1: User only gives destination ("I want to go to Sopore"), no boarding location, no luggage
    # Expected: Prompt asks for luggage (defaults pickup to current location)
    resp1 = client.post(
        "/chat",
        json={
            "message": "I want to go to Sopore",
            "thread_id": thread_id,
            "user_current_lat": 34.0722,
            "user_current_lng": 74.8105,
            "input_type": "text",
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "COLLECTING"
    assert "luggage" in data1["reply"].lower() or "bag" in data1["reply"].lower()

    # Step 2: User responds to luggage question with "no luggage"
    # Expected: Luggage clarified, pickup auto-snaps to Current Location -> Proceed to CONFIRMING_DEPARTURE
    resp2 = client.post(
        "/chat",
        json={
            "message": "No luggage",
            "thread_id": thread_id,
            "input_type": "voice",
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["stage"] == "CONFIRMING_DEPARTURE"
    assert data2["luggage"]["has_extra_luggage"] is False
    assert data2["luggage"]["extra_luggage_count"] == 0
    assert len(data2["options"]) >= 1


def test_missing_boarding_when_luggage_already_declared():
    thread_id = "test-missing-pickup-with-luggage-user"

    # User declares destination and luggage: "I want to go to Sopore with 2 bags" (pickup missing)
    # Expected: Auto-snaps pickup to Current GPS coordinates (Scenario 02) -> CONFIRMING_DEPARTURE
    resp1 = client.post(
        "/chat",
        json={
            "message": "I want to go to Sopore with 2 bags",
            "thread_id": thread_id,
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "CONFIRMING_DEPARTURE"
    assert data1["luggage"]["has_extra_luggage"] is True
    assert data1["luggage"]["extra_luggage_count"] == 2
    assert len(data1["options"]) >= 1


def test_missing_luggage_when_boarding_already_declared():
    thread_id = "test-missing-luggage-with-pickup-user"

    # User declares destination and boarding: "From Batamaloo to Lal Chowk" (luggage missing)
    # Expected: Ask for luggage
    resp1 = client.post(
        "/chat",
        json={
            "message": "From Batamaloo to Lal Chowk",
            "thread_id": thread_id,
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "COLLECTING"
    assert "luggage" in data1["reply"].lower()

    # User answers luggage: "1 bag"
    # Expected: Both are now clarified -> CONFIRMING_DEPARTURE
    resp2 = client.post(
        "/chat",
        json={
            "message": "1 bag",
            "thread_id": thread_id,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["stage"] == "CONFIRMING_DEPARTURE"
    assert data2["luggage"]["has_extra_luggage"] is True
    assert data2["luggage"]["extra_luggage_count"] == 1
    assert len(data2["options"]) >= 1


def test_start_new_chat_clears_old_temporary_memory():
    thread_id = "test-session-reset-user"

    # Step 1: User engages in booking (stored temporarily)
    resp1 = client.post(
        "/chat",
        json={
            "message": "I need a ride from Batamaloo to Sopore with 2 bags",
            "thread_id": thread_id,
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp1.status_code == 200
    assert resp1.json()["stage"] == "CONFIRMING_DEPARTURE"

    # Step 2: User clicks 'Start' or 'Start New Chat'
    resp_reset = client.post(
        "/chat/start",
        json={
            "message": "Start",
            "thread_id": thread_id,
        },
    )
    assert resp_reset.status_code == 200
    data_reset = resp_reset.json()
    assert data_reset["stage"] == "COLLECTING"
    assert "Welcome" in data_reset["reply"]

    # Step 3: Now user asks something fresh. Old destination Sopore and luggage (2 bags) must NOT be present
    resp3 = client.post(
        "/chat",
        json={
            "message": "Start",
            "action": "start",
            "thread_id": thread_id,
        },
    )
    assert resp3.status_code == 200
    assert resp3.json()["stage"] == "COLLECTING"


def test_route_without_luggage_prompts_for_luggage_first():
    """Verify that when a user searches 'i wanna go to lal chowk from hazratbal' without luggage,
    the assistant halts at COLLECTING stage and asks for luggage FIRST."""
    thread_id = "test-session-hazratbal-lalchowk-" + str(int(time.time() * 1000))

    # Turn 1: User specifies pickup and drop, but NO luggage
    resp1 = client.post(
        "/chat",
        json={
            "message": "i wanna go to lal chowk from hazratbal",
            "thread_id": thread_id,
            "user_current_lat": 34.1256,
            "user_current_lng": 74.8415,
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "COLLECTING"
    assert "luggage" in data1["reply"].lower() or "bags" in data1["reply"].lower()
    assert data1["options"] is None or len(data1["options"]) == 0

    # Turn 2: User answers luggage question: "no luggage"
    resp2 = client.post(
        "/chat",
        json={
            "message": "no luggage",
            "thread_id": thread_id,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["stage"] == "CONFIRMING_DEPARTURE"
    assert data2["luggage"]["has_extra_luggage"] is False
    assert data2["luggage"]["extra_luggage_count"] == 0
    assert len(data2["options"]) >= 1
    assert "No extra luggage" in data2["reply"]


def test_luggage_affirmative_without_count_asks_how_many():
    """Verify that when a user says 'yes i have laguage' without count,
    the assistant asks how many bags/luggage they are carrying instead of defaulting to 1."""
    thread_id = "test-session-luggage-count-" + str(int(time.time() * 1000))

    # Turn 1: User specifies pickup and drop
    resp1 = client.post(
        "/chat",
        json={
            "message": "from hazratbal to lal chowk",
            "thread_id": thread_id,
            "user_current_lat": 34.1256,
            "user_current_lng": 74.8415,
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "COLLECTING"
    assert "luggage" in data1["reply"].lower()

    # Turn 2: User says 'yes i have laguage' (no count specified)
    resp2 = client.post(
        "/chat",
        json={
            "message": "yes i have laguage",
            "thread_id": thread_id,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    # MUST stay at COLLECTING and ask how many bags
    assert data2["stage"] == "COLLECTING"
    assert "how many" in data2["reply"].lower()
    assert data2["options"] is None or len(data2["options"]) == 0

    # Turn 3: User answers count: "2 bags"
    resp3 = client.post(
        "/chat",
        json={
            "message": "2 bags",
            "thread_id": thread_id,
        },
    )
    assert resp3.status_code == 200
    data3 = resp3.json()
    assert data3["stage"] == "CONFIRMING_DEPARTURE"
    assert data3["luggage"]["has_extra_luggage"] is True
    assert data3["luggage"]["extra_luggage_count"] == 2
    assert "2 extra bag(s)" in data3["reply"]


def test_multi_stage_departure_then_seat_selection_flow():
    """Verify the 50 scenario Route Match card flow:
    1. First presents the matched route with next upcoming vehicle and available seats.
    2. User picks seat or confirms.
    3. Creates seat hold and transitions to AWAITING_DRIVER."""
    thread_id = "test-session-multi-step-" + str(int(time.time() * 1000))

    # Step 1: User requests route with luggage
    resp1 = client.post(
        "/chat",
        json={
            "message": "i wanna go to lal chowk from hazratbal with 1 bag",
            "thread_id": thread_id,
            "user_current_lat": 34.1256,
            "user_current_lng": 74.8415,
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "CONFIRMING_DEPARTURE"
    assert "Route Match" in data1["reply"] or "Next Vehicle" in data1["reply"]
    assert len(data1["options"]) >= 1

    # Step 2: User specifies seat choice or confirm: "Book seat 1A"
    resp2 = client.post(
        "/chat",
        json={
            "message": "Book seat 1A",
            "thread_id": thread_id,
        },
    )
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["stage"] == "AWAITING_DRIVER"
    assert data2["seat_hold_id"] is not None
    assert data2["selected_seats"] == ["1A"]
    assert "Seat 1A" in data2["reply"]
    assert "request sent to driver" in data2["reply"].lower()




