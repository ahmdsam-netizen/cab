# DreamCabs Fixed-Route Conversational Booking Agent

A production-grade Python microservice built with **FastAPI** and **LangGraph** enabling conversational booking of fixed-route station-to-station shared rides.

---

## Architecture Overview

```
                      ┌──────────────────────────────────────┐
                      │    FastAPI + LangGraph Service       │
 [Mobile App Chat] ──>│  POST /chat                          │
                      │  - Conversational NLP                │
                      │  - Station & Route Snapping          │
                      │  - Checkpointed State Persistence    │
                      └──────────────┬───────────────────────┘
                                     │ Calls Existing Laravel APIs
                                     ▼
                      ┌──────────────────────────────────────┐
                      │    Existing Laravel Backend          │
                      │  - GET  /api/fixed/routes            │
                      │  - GET  /api/fixed/routes/{id}/dep   │
                      │  - POST /api/fixed/seat-holds        │
                      │  - POST /api/fixed/seat-holds/order  │
                      └──────────────┬───────────────────────┘
                                     │ Driver Accepts / Declines
                                     ▼
                      ┌──────────────────────────────────────┐
                      │    POST /webhook/driver-event        │
                      │    Wakes up paused LangGraph state   │
                      └──────────────────────────────────────┘
```

---

## Key Features

1. **Station Snapping**:
   - Geocodes user natural language queries (e.g. *"I need a ride to Sopore from Lal Chowk"*).
   - If pickup is omitted, defaults to the user's current GPS location (`user_current_lat`, `user_current_lng`).
   - Automatically matches the nearest boarding stop and drop stop along the route in correct sequence (`sequence(board) < sequence(drop)`).

2. **Asynchronous Driver Wait (No LLM Blocking)**:
   - When the user confirms a departure, a seat hold is created (`POST /api/fixed/seat-holds`).
   - LangGraph pauses the thread and persists state to memory or database checkpointer.
   - The LLM and HTTP connection do **not** wait. Zero CPU usage while awaiting the driver.

3. **Rejection & Alternative Departures Loop**:
   - When a driver rejects, Laravel sends a webhook to `POST /webhook/driver-event`.
   - The agent pops the rejected departure from `remaining_departures` and presents the next available departure on that route.
   - The loop continues until a driver accepts or all options are exhausted.

4. **Payment Generation on Acceptance**:
   - When a driver accepts, the webhook triggers `POST /api/fixed/seat-holds/{id}/razorpay-order`.
   - The agent returns the Razorpay `order_id` and ticket summary to the client.

---

## Quick Start

### 1. Setup Virtual Environment
```bash
cd agent-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure Environment
```bash
cp .env.example .env
```

### 3. Run the Service
```bash
uvicorn api.main:app --port 8105 --reload
```

### 4. Run Automated Tests
```bash
PYTHONPATH=. pytest tests/
```

---

## API Endpoints

### 1. Chat Endpoint (`POST /chat`)
**Payload**:
```json
{
  "message": "Book a ride to Sopore",
  "thread_id": "customer_user_101",
  "user_current_lat": 34.0718,
  "user_current_lng": 74.7925,
  "auth_token": "sanctum_bearer_token"
}
```

### 2. Driver Webhook (`POST /webhook/driver-event`)
**Payload**:
```json
{
  "seat_hold_id": 501,
  "event": "DRIVER_ACCEPTED"
}
```
*(or `DRIVER_REJECTED`)*
