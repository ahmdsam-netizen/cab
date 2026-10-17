import uvicorn
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage
from typing import Dict, Any, Optional

from config import settings
from models.schemas import ChatRequest, ChatResponse, DriverEventRequest
from graph.workflow import booking_graph
from graph.nodes import node_create_hold, node_handle_driver_acceptance, node_handle_driver_rejection

app = FastAPI(
    title="DreamCabs AI Fixed-Route Agent Microservice",
    description="Conversational station-to-station ride booking powered by LangGraph",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Registry mapping seat_hold_id -> thread_id for driver webhook lookups
SEAT_HOLD_THREADS: Dict[int, str] = {}


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "dreamcabs-agent-service",
        "llm_provider": settings.LLM_PROVIDER,
        "laravel_api": settings.LARAVEL_API_BASE_URL,
    }


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    config = {"configurable": {"thread_id": request.thread_id}}
    current_snapshot = booking_graph.get_state(config)
    current_state = current_snapshot.values if current_snapshot else {}
    current_stage = current_state.get("stage", "START")

    user_text = request.message.strip().lower()

    # Check if user is confirming or choosing during CONFIRMING_DEPARTURE stage
    if current_stage == "CONFIRMING_DEPARTURE":
        # Check luggage update
        from graph.nodes import _parse_luggage_from_text, _parse_seat_label_from_text
        lug_info = _parse_luggage_from_text(request.message)
        if request.has_extra_luggage is not None:
            current_state["has_extra_luggage"] = request.has_extra_luggage
            current_state["extra_luggage_count"] = request.extra_luggage_count or 0
        elif lug_info["has_extra_luggage"]:
            current_state["has_extra_luggage"] = True
            current_state["extra_luggage_count"] = lug_info["extra_luggage_count"]

        # Check seat selection
        avail = current_state.get("available_seat_labels", [])
        seat_from_text = _parse_seat_label_from_text(request.message, avail)
        if request.selected_seat_labels:
            current_state["selected_seat_labels"] = request.selected_seat_labels
        elif seat_from_text:
            current_state["selected_seat_labels"] = [seat_from_text]

        is_confirm = (
            request.action == "confirm"
            or any(word in user_text for word in ["confirm", "yes", "book", "proceed", "go ahead", "okay", "ok"])
            or bool(seat_from_text)
        )

        # Allow user to pick a specific departure ID
        if request.selected_departure_id:
            for dep in current_state.get("remaining_departures", []):
                if dep.get("id") == request.selected_departure_id:
                    current_state["current_departure"] = dep
                    break

        if is_confirm:
            # Advance to creating hold
            updated = await node_create_hold(current_state)
            if updated.get("seat_hold_id"):
                SEAT_HOLD_THREADS[updated["seat_hold_id"]] = request.thread_id

            booking_graph.update_state(config, updated)
            last_msg = updated["messages"][-1].content
            return ChatResponse(
                reply=last_msg,
                stage=updated.get("stage", "AWAITING_DRIVER"),
                thread_id=request.thread_id,
                seat_hold_id=updated.get("seat_hold_id"),
                available_seats=current_state.get("available_seat_labels"),
                selected_seats=updated.get("selected_seat_labels"),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
            )

    # Initial or normal conversational prompt
    inputs = {
        "messages": [HumanMessage(content=request.message)],
        "auth_token": request.auth_token or current_state.get("auth_token"),
        "user_current_lat": request.user_current_lat or current_state.get("user_current_lat"),
        "user_current_lng": request.user_current_lng or current_state.get("user_current_lng"),
    }
    if request.has_extra_luggage is not None:
        inputs["has_extra_luggage"] = request.has_extra_luggage
        inputs["extra_luggage_count"] = request.extra_luggage_count or 0

    result = await booking_graph.ainvoke(inputs, config=config)
    last_reply = result["messages"][-1].content if result.get("messages") else "Processing..."
    
    return ChatResponse(
        reply=last_reply,
        stage=result.get("stage", "UNKNOWN"),
        thread_id=request.thread_id,
        options=result.get("remaining_departures"),
        matched_route=result.get("matched_route"),
        available_seats=result.get("available_seat_labels"),
        selected_seats=result.get("selected_seat_labels"),
        luggage={
            "has_extra_luggage": result.get("has_extra_luggage", False),
            "extra_luggage_count": result.get("extra_luggage_count", 0),
        },
        seat_hold_id=result.get("seat_hold_id"),
        payment_order=result.get("payment_order"),
    )


@app.post("/webhook/driver-event", response_model=ChatResponse)
async def driver_event_webhook(payload: DriverEventRequest):
    """
    Webhook triggered by Laravel when a driver accepts or rejects a seat hold.
    Wakes up the user's LangGraph thread without the LLM holding any connection.
    """
    thread_id = SEAT_HOLD_THREADS.get(payload.seat_hold_id)
    if not thread_id:
        # Fallback thread_id lookup by string id if mapped directly
        thread_id = str(payload.seat_hold_id)

    config = {"configurable": {"thread_id": thread_id}}
    snapshot = booking_graph.get_state(config)
    if not snapshot or not snapshot.values:
        raise HTTPException(status_code=404, detail="Conversation state for seat hold not found.")

    state = snapshot.values

    if payload.event == "DRIVER_ACCEPTED":
        updated = await node_handle_driver_acceptance(state)
    elif payload.event == "DRIVER_REJECTED":
        updated = await node_handle_driver_rejection(state)
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported driver event: {payload.event}")

    booking_graph.update_state(config, updated)
    last_msg = updated["messages"][-1].content if updated.get("messages") else "Event processed."

    return ChatResponse(
        reply=last_msg,
        stage=updated.get("stage", "UNKNOWN"),
        thread_id=thread_id,
        options=updated.get("remaining_departures"),
        seat_hold_id=updated.get("seat_hold_id"),
        payment_order=updated.get("payment_order"),
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8105, reload=True)
