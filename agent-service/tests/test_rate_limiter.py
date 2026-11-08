import pytest
from fastapi.testclient import TestClient
from api.main import app
from tools.rate_limiter import rate_limiter

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_limiter():
    """Reset rate limiter to standard testing baseline before each test."""
    rate_limiter.update_config(
        max_conversations_per_day=5,
        max_requests_per_day=100,
        max_requests_per_minute=25,
        enabled=True,
    )
    rate_limiter._user_records.clear()


def test_user_daily_conversation_limit():
    user_id = "test-user-limit-1"

    # User starts 5 new conversations successfully
    for i in range(1, 6):
        resp = client.post(
            "/chat/start",
            json={
                "user_id": user_id,
                "thread_id": f"thread-{user_id}-{i}",
                "message": "Start",
            },
        )
        assert resp.status_code == 200, f"Conversation {i} should be allowed"

    # 6th new conversation must be blocked by rate limiter
    resp6 = client.post(
        "/chat/start",
        json={
            "user_id": user_id,
            "thread_id": f"thread-{user_id}-6",
            "message": "Start",
        },
    )
    assert resp6.status_code == 429
    assert "Daily conversation limit reached" in resp6.json()["detail"]


def test_ongoing_conversation_requests_do_not_consume_new_conversation_quota():
    user_id = "test-user-ongoing-1"
    thread_id = f"thread-{user_id}-stable"

    # Start conversation 1
    resp1 = client.post(
        "/chat/start",
        json={
            "user_id": user_id,
            "thread_id": thread_id,
            "message": "Start",
        },
    )
    assert resp1.status_code == 200

    # Send multiple requests within the SAME conversation thread
    for i in range(10):
        resp = client.post(
            "/chat",
            json={
                "user_id": user_id,
                "thread_id": thread_id,
                "message": f"Message {i} to Sopore",
                "user_current_lat": 34.0718,
                "user_current_lng": 74.7925,
            },
        )
        assert resp.status_code == 200

    # User has sent 11 total requests, but only 1 conversation was used
    usage = client.get(f"/admin/rate-limits/usage/{user_id}").json()
    assert usage["conversations_used_today"] == 1
    assert usage["requests_used_today"] == 11


def test_daily_requests_limit():
    user_id = "test-user-req-limit"
    thread_id = "thread-req-limit"

    # Configure max requests per day = 3 for this test
    client.post(
        "/admin/rate-limits/config",
        json={"max_requests_per_day": 3},
    )

    # Send 3 requests (allowed)
    for _ in range(3):
        resp = client.post(
            "/chat",
            json={
                "user_id": user_id,
                "thread_id": thread_id,
                "message": "To Sopore with 2 bags",
                "user_current_lat": 34.0718,
                "user_current_lng": 74.7925,
            },
        )
        assert resp.status_code == 200

    # 4th request must be blocked by daily request limit
    resp4 = client.post(
        "/chat",
        json={
            "user_id": user_id,
            "thread_id": thread_id,
            "message": "To Sopore with 2 bags",
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp4.status_code == 429
    assert "Daily request limit reached" in resp4.json()["detail"]


def test_admin_panel_configuration_and_reset():
    # 1. Admin reads current config
    get_res = client.get("/admin/rate-limits/config")
    assert get_res.status_code == 200
    cfg = get_res.json()
    assert cfg["max_conversations_per_day"] == 5
    assert cfg["max_requests_per_day"] == 100

    # 2. Admin updates config to new limits
    update_res = client.post(
        "/admin/rate-limits/config",
        json={
            "max_conversations_per_day": 8,
            "max_requests_per_day": 150,
            "max_requests_per_minute": 30,
        },
    )
    assert update_res.status_code == 200
    new_cfg = update_res.json()
    assert new_cfg["max_conversations_per_day"] == 8
    assert new_cfg["max_requests_per_day"] == 150
    assert new_cfg["max_requests_per_minute"] == 30

    # 3. Admin resets a specific user
    user_id = "blocked-customer-123"
    client.post(
        "/chat/start",
        json={"user_id": user_id, "thread_id": "thread-1", "message": "Start"},
    )
    usage_before = client.get(f"/admin/rate-limits/usage/{user_id}").json()
    assert usage_before["conversations_used_today"] == 1

    reset_res = client.post(f"/admin/rate-limits/reset/{user_id}")
    assert reset_res.status_code == 200

    usage_after = client.get(f"/admin/rate-limits/usage/{user_id}").json()
    assert usage_after["conversations_used_today"] == 0
    assert usage_after["requests_used_today"] == 0
