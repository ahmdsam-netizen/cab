import uvicorn
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage
from typing import Dict, Any, Optional, Tuple

from config import settings
from models.schemas import (
    ChatRequest,
    ChatResponse,
    DriverEventRequest,
    RateLimitConfigRequest,
    RateLimitConfigResponse,
    UserRateLimitUsageResponse,
)
from graph.workflow import booking_graph
from graph.nodes import node_create_hold, node_handle_driver_acceptance, node_handle_driver_rejection
from tools.guardrails import validate_and_filter_prompt
from tools.rate_limiter import rate_limiter
from tools.tts import generate_speech_audio

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


async def clear_thread_memory(thread_id: str):
    """Wipes all temporary memory and state associated with a thread_id."""
    if hasattr(booking_graph, "checkpointer") and booking_graph.checkpointer is not None:
        if hasattr(booking_graph.checkpointer, "adelete_thread"):
            await booking_graph.checkpointer.adelete_thread(thread_id)
        elif hasattr(booking_graph.checkpointer, "delete_thread"):
            booking_graph.checkpointer.delete_thread(thread_id)

    # Remove any lingering seat hold associations
    to_delete = [hid for hid, tid in SEAT_HOLD_THREADS.items() if tid == thread_id]
    for hid in to_delete:
        SEAT_HOLD_THREADS.pop(hid, None)


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "dreamcabs-agent-service",
        "llm_provider": settings.LLM_PROVIDER,
        "laravel_api": settings.LARAVEL_API_BASE_URL,
    }


async def _synthesize_voice_if_requested(
    text: str,
    voice_mode: Optional[bool],
    language: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    """
    Synthesizes speech via edge-tts if voice_mode is enabled.
    Returns (audio_base64, audio_language).
    """
    if not voice_mode or not text:
        return None, None
    lang = (language or "en").lower().strip()
    audio_b64 = await generate_speech_audio(text, language=lang)
    return audio_b64, lang


@app.post("/chat/start", response_model=ChatResponse)
async def start_new_chat_endpoint(request: ChatRequest):
    """
    Explicitly resets and deletes old temporary chat memory when a user clicks 'Start'.
    Fresh data starts getting recorded from this point forward.
    """
    user_id = request.user_id or request.auth_token or request.thread_id
    rate_limiter.check_and_record(user_id=user_id, thread_id=request.thread_id, is_new_conversation=True)

    await clear_thread_memory(request.thread_id)
    reply_msg = "Hello! Welcome to DreamCabs. Where would you like to travel today? (You can mention your destination and any luggage, e.g. 'To Sopore with 2 bags')."
    audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_msg, request.voice_mode, request.preferred_language)

    return ChatResponse(
        reply=reply_msg,
        stage="COLLECTING",
        thread_id=request.thread_id,
        audio_base64=audio_b64,
        audio_format="mp3" if audio_b64 else None,
        audio_language=audio_lang,
    )


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    raw_message = (request.message or "").strip()

    # Check if user clicked 'Start' or requested a new chat
    is_start_trigger = (
        request.action in ["start", "new_chat", "reset"]
        or raw_message.lower() in ["start", "/start", "start new chat", "new chat", "restart"]
    )

    # Check User-ID level Rate Limit (Daily Conversations, Daily Requests, and Burst/RPM)
    user_id = request.user_id or request.auth_token or request.thread_id
    rate_limiter.check_and_record(
        user_id=user_id,
        thread_id=request.thread_id,
        is_new_conversation=is_start_trigger,
    )

    if is_start_trigger:
        # Wipe all previous conversation memory
        await clear_thread_memory(request.thread_id)

        # If user just triggered start without a separate booking message
        if not raw_message or raw_message.lower() in ["start", "/start", "start new chat", "new chat", "restart"]:
            reply_msg = "Hello! Welcome to DreamCabs. Where would you like to travel today? (You can mention your destination and any luggage, e.g. 'To Sopore with 2 bags')."
            audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_msg, request.voice_mode, request.preferred_language)
            return ChatResponse(
                reply=reply_msg,
                stage="COLLECTING",
                thread_id=request.thread_id,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

    config = {"configurable": {"thread_id": request.thread_id}}
    current_snapshot = booking_graph.get_state(config)
    current_state = current_snapshot.values if current_snapshot else {}
    current_stage = current_state.get("stage", "START")

    # Security Guardrail and Out-of-Context Filter Check
    guardrail_res = await validate_and_filter_prompt(raw_message)
    if not guardrail_res.is_safe or not guardrail_res.is_in_context or not guardrail_res.filtered_text:
        reply_msg = guardrail_res.rejection_message or "Such types of queries are not meant to be dealt here."
        audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_msg, request.voice_mode, request.preferred_language)
        return ChatResponse(
            reply=reply_msg,
            stage=current_stage,
            thread_id=request.thread_id,
            options=current_state.get("remaining_departures"),
            matched_route=current_state.get("matched_route"),
            available_seats=current_state.get("available_seat_labels"),
            selected_seats=current_state.get("selected_seat_labels"),
            luggage={
                "has_extra_luggage": current_state.get("has_extra_luggage", False),
                "extra_luggage_count": current_state.get("extra_luggage_count", 0),
            },
            seat_hold_id=current_state.get("seat_hold_id"),
            audio_base64=audio_b64,
            audio_format="mp3" if audio_b64 else None,
            audio_language=audio_lang,
        )

    # Use sanitized/filtered prompt for booking state machine
    request.message = guardrail_res.filtered_text
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
            audio_b64, audio_lang = await _synthesize_voice_if_requested(last_msg, request.voice_mode, request.preferred_language)
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
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

    # Initial or normal conversational prompt
    user_msg_content = request.message or ""
    inputs = {
        "messages": [HumanMessage(content=user_msg_content)],
        "auth_token": request.auth_token or current_state.get("auth_token"),
        "user_current_lat": request.user_current_lat or current_state.get("user_current_lat"),
        "user_current_lng": request.user_current_lng or current_state.get("user_current_lng"),
        "input_type": request.input_type or "text",
    }
    if request.has_extra_luggage is not None:
        inputs["has_extra_luggage"] = request.has_extra_luggage
        inputs["extra_luggage_count"] = request.extra_luggage_count or 0
        inputs["luggage_clarified"] = True

    result = await booking_graph.ainvoke(inputs, config=config)
    last_reply = result["messages"][-1].content if result.get("messages") else "Processing..."
    audio_b64, audio_lang = await _synthesize_voice_if_requested(last_reply, request.voice_mode, request.preferred_language)
    
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
        audio_base64=audio_b64,
        audio_format="mp3" if audio_b64 else None,
        audio_language=audio_lang,
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


# --- ADMIN PANEL RATE LIMIT MANAGEMENT ENDPOINTS ---

@app.get("/admin/rate-limits/config", response_model=RateLimitConfigResponse)
async def get_rate_limit_config(x_admin_key: Optional[str] = Header(None)):
    """Fetches active rate limiter settings for Admin Panel."""
    return rate_limiter.get_config()


@app.post("/admin/rate-limits/config", response_model=RateLimitConfigResponse)
async def update_rate_limit_config(payload: RateLimitConfigRequest, x_admin_key: Optional[str] = Header(None)):
    """Dynamically updates rate limiter settings from Admin Panel without service restart."""
    return rate_limiter.update_config(
        max_conversations_per_day=payload.max_conversations_per_day,
        max_requests_per_day=payload.max_requests_per_day,
        max_requests_per_minute=payload.max_requests_per_minute,
        enabled=payload.enabled,
    )


@app.get("/admin/rate-limits/usage/{user_id}", response_model=UserRateLimitUsageResponse)
async def get_user_rate_limit_usage(user_id: str, x_admin_key: Optional[str] = Header(None)):
    """Fetches a specific user's daily conversation and request metrics for Admin Panel."""
    return rate_limiter.get_usage(user_id)


@app.post("/admin/rate-limits/reset/{user_id}")
async def reset_user_rate_limit(user_id: str, x_admin_key: Optional[str] = Header(None)):
    """Resets rate limiting usage metrics for a user (e.g. for customer support unblocking)."""
    rate_limiter.reset_user(user_id)
    return {"status": "success", "message": f"Rate limits reset for user {user_id}"}


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8105, reload=True)
