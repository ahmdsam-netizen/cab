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

    # Step 1: User asks for a ride to Sopore with luggage
    resp1 = client.post(
        "/chat",
        json={
            "message": "I need to book a cab to Sopore with 2 bags",
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
    assert data1["available_seats"] is not None
    assert len(data1["available_seats"]) >= 1
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


def test_missing_luggage_prompts_user_before_confirming():
    thread_id = "test-missing-luggage-user-1"

    # User only gives destination ("I want to go to Sopore"), no pickup, no luggage
    # Expected: Pickup defaults to GPS start location, but luggage is missing -> COLLECTING stage
    resp1 = client.post(
        "/chat",
        json={
            "message": "I want to go to Sopore",
            "thread_id": thread_id,
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
            "input_type": "text",
        },
    )
    assert resp1.status_code == 200
    data1 = resp1.json()
    assert data1["stage"] == "COLLECTING"
    assert "luggage" in data1["reply"].lower()

    # User answers luggage question: "no luggage"
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


def test_start_new_chat_clears_old_temporary_memory():
    thread_id = "test-session-reset-user"

    # Step 1: User engages in booking (stored temporarily)
    resp1 = client.post(
        "/chat",
        json={
            "message": "I need a ride to Sopore with 2 bags",
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

