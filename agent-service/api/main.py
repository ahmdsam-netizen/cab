import re
import uvicorn
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage, AIMessage
from typing import Dict, Any, Optional, Tuple

from config import settings
from models.schemas import (
    ChatRequest,
    ChatResponse,
    DriverEventRequest,
    RateLimitConfigRequest,
    RateLimitConfigResponse,
    UserRateLimitUsageResponse,
    ApiKeyConfigRequest,
    ApiKeyConfigResponse,
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


def _shape_chat_response_data(state: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[list], Optional[Dict[str, Any]]]:
    """Shapes matched_route (including board/drop stops), departures options, and selected departure for rich frontend cards."""
    matched_route = state.get("matched_route")
    if matched_route and isinstance(matched_route, dict):
        matched_route = dict(matched_route)
        if state.get("board_stop") and "board_stop" not in matched_route:
            matched_route["board_stop"] = state["board_stop"]
        if state.get("drop_stop") and "drop_stop" not in matched_route:
            matched_route["drop_stop"] = state["drop_stop"]
        if state.get("current_departure"):
            cd = state["current_departure"]
            if "price_per_seat" not in matched_route:
                matched_route["price_per_seat"] = cd.get("fare_per_seat") or cd.get("price_per_seat") or 150.0

    options = state.get("remaining_departures")
    if options and isinstance(options, list):
        cleaned_options = []
        for opt in options:
            o = dict(opt)
            if "fare_per_seat" in o and "price_per_seat" not in o:
                o["price_per_seat"] = o["fare_per_seat"]
            if "departure_time" in o and "announced_depart_at" not in o:
                o["announced_depart_at"] = o["departure_time"]
            cleaned_options.append(o)
        options = cleaned_options

    selected_dep = state.get("current_departure")
    if selected_dep and isinstance(selected_dep, dict):
        selected_dep = dict(selected_dep)
        if "fare_per_seat" in selected_dep and "price_per_seat" not in selected_dep:
            selected_dep["price_per_seat"] = selected_dep["fare_per_seat"]
        if "departure_time" in selected_dep and "announced_depart_at" not in selected_dep:
            selected_dep["announced_depart_at"] = selected_dep["departure_time"]

    return matched_route, options, selected_dep


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

    # Security Guardrail and Out-of-Context Filter Check (aware of current conversation stage)
    guardrail_res = await validate_and_filter_prompt(raw_message, stage=current_stage)
    if not guardrail_res.is_safe or not guardrail_res.is_in_context or not guardrail_res.filtered_text:
        reply_msg = guardrail_res.rejection_message or "Such types of queries are not meant to be dealt here."
        audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_msg, request.voice_mode, request.preferred_language)
        shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
        return ChatResponse(
            reply=reply_msg,
            stage=current_stage,
            thread_id=request.thread_id,
            options=shaped_options,
            selected_departure=shaped_selected_dep,
            matched_route=shaped_route,
            available_seats=current_state.get("available_seat_labels"),
            selected_seats=current_state.get("selected_seat_labels"),
            seats_requested=current_state.get("seats_requested", 1),
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
        from graph.nodes import (
            _parse_luggage_from_text,
            _parse_seats_requested_from_text,
            _parse_seat_labels_from_text,
            _parse_seat_label_from_text,
            _match_departure_from_text,
            _format_dep_time,
            node_present_options,
            node_create_hold,
            api_client,
        )
        from tools.llm_nlp import extract_booking_intent_llm

        rem_deps = current_state.get("remaining_departures", [])
        matched_dep = None

        # Try LLM semantic extraction first for complex phrasing (Urdu, Kashmiri, seat preference, etc.)
        llm_intent = await extract_booking_intent_llm(request.message, stage="CONFIRMING_DEPARTURE", context=current_state)
        if llm_intent:
            if llm_intent.is_cancelling or llm_intent.intent == "SHOW_OTHER_RIDES":
                user_text = "show other rides"
            if llm_intent.has_extra_luggage is not None:
                current_state["has_extra_luggage"] = llm_intent.has_extra_luggage
                current_state["extra_luggage_count"] = llm_intent.extra_luggage_count or 0
            if llm_intent.seats_requested and llm_intent.seats_requested > 1:
                current_state["seats_requested"] = llm_intent.seats_requested
            if llm_intent.selected_seat_labels:
                current_state["selected_seat_labels"] = llm_intent.selected_seat_labels
            if llm_intent.selected_departure_time:
                m_dep = _match_departure_from_text(llm_intent.selected_departure_time, rem_deps)
                if m_dep:
                    matched_dep = m_dep
            if not matched_dep and llm_intent.selected_departure_ordinal:
                m_dep = _match_departure_from_text(llm_intent.selected_departure_ordinal, rem_deps)
                if m_dep:
                    matched_dep = m_dep

        # Check if user explicitly wants to cancel booking entirely (Scenario 13)
        is_explicit_cancel = (
            any(k in user_text for k in ["cancel booking", "cancel the booking", "cancel ride"])
            or (user_text == "cancel")
        ) and not any(k in user_text for k in ["other", "switch", "different", "show"])
        if is_explicit_cancel:
            await clear_thread_memory(request.thread_id)
            cancel_msg = "Understood! Your booking request has been cancelled and no charges were made. Feel free to start a new chat whenever you are ready to travel."
            audio_b64, audio_lang = await _synthesize_voice_if_requested(cancel_msg, request.voice_mode, request.preferred_language)
            return ChatResponse(
                reply=cancel_msg,
                stage="START",
                thread_id=request.thread_id,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # Check if user wants to see all available rides again / switch back
        is_request_all_rides = any(
            phrase in user_text for phrase in [
                "other ride", "other rides", "all rides", "show rides", "different ride",
                "switch ride", "change ride", "back to rides"
            ]
        ) or (llm_intent and (llm_intent.is_cancelling or llm_intent.intent == "SHOW_OTHER_RIDES"))
        if is_request_all_rides:
            current_state["current_departure"] = None
            current_state["available_seat_labels"] = []
            options_result = await node_present_options(current_state)
            current_state.update(options_result)
            booking_graph.update_state(config, current_state)
            reply_text = options_result["messages"][-1].content
            audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_text, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=reply_text,
                stage="CONFIRMING_DEPARTURE",
                thread_id=request.thread_id,
                options=shaped_options,
                selected_departure=None,
                matched_route=shaped_route,
                available_seats=[],
                selected_seats=None,
                seats_requested=current_state.get("seats_requested", 1),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                seat_hold_id=None,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # Check if user wants to change destination mid-flight (Scenario 42)
        from graph.nodes import _parse_locations_from_text as _parse_locs
        parsed_dest = _parse_locs(request.message)
        if parsed_dest.get("drop") and parsed_dest["drop"] != current_state.get("drop_text"):
            from graph.nodes import (
                node_match_route_and_stations,
                node_fetch_departures,
            )
            from tools.geocoding import geocode_location
            current_state["drop_text"] = parsed_dest["drop"]
            current_state["drop_coords"] = geocode_location(parsed_dest["drop"])
            if parsed_dest.get("pickup"):
                current_state["pickup_text"] = parsed_dest["pickup"]
                current_state["pickup_coords"] = geocode_location(parsed_dest["pickup"])
            current_state["current_departure"] = None
            current_state["available_seat_labels"] = []
            current_state["selected_seat_labels"] = []

            matched = await node_match_route_and_stations(current_state)
            current_state.update(matched)
            if current_state.get("stage") in ["MATCHING_ROUTE", "FETCHING_DEPARTURES"]:
                deps = await node_fetch_departures(current_state)
                current_state.update(deps)
                opts = await node_present_options(current_state)
                current_state.update(opts)
            booking_graph.update_state(config, current_state)
            last_msg = current_state["messages"][-1].content
            audio_b64, audio_lang = await _synthesize_voice_if_requested(last_msg, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=last_msg,
                stage=current_state.get("stage", "CONFIRMING_DEPARTURE"),
                thread_id=request.thread_id,
                options=shaped_options,
                selected_departure=None,
                matched_route=shaped_route,
                available_seats=[],
                selected_seats=None,
                seats_requested=current_state.get("seats_requested", 1),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                seat_hold_id=None,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # 1. Check luggage update
        lug_info = _parse_luggage_from_text(request.message)
        if request.has_extra_luggage is not None:
            current_state["has_extra_luggage"] = request.has_extra_luggage
            current_state["extra_luggage_count"] = request.extra_luggage_count or 0
        elif lug_info["has_extra_luggage"]:
            current_state["has_extra_luggage"] = True
            current_state["extra_luggage_count"] = lug_info["extra_luggage_count"]

        # 2. Check seats requested update
        seats_extracted = _parse_seats_requested_from_text(request.message)
        if request.seats_requested:
            current_state["seats_requested"] = request.seats_requested
        elif seats_extracted:
            current_state["seats_requested"] = seats_extracted
        elif not current_state.get("seats_requested"):
            current_state["seats_requested"] = 1

        rem_deps = current_state.get("remaining_departures", [])

        # 3. Check if user picked or switched departure
        matched_dep = None
        if request.selected_departure_id:
            for dep in rem_deps:
                if dep.get("id") == request.selected_departure_id:
                    matched_dep = dep
                    break
        if not matched_dep:
            matched_dep = _match_departure_from_text(request.message, rem_deps)

        # 4. Check seat selection
        avail = current_state.get("available_seat_labels", [])
        seats_from_text = _parse_seat_labels_from_text(request.message, avail)
        if request.selected_seat_labels:
            current_state["selected_seat_labels"] = request.selected_seat_labels
            if len(request.selected_seat_labels) > current_state.get("seats_requested", 1):
                current_state["seats_requested"] = len(request.selected_seat_labels)
        elif seats_from_text:
            current_state["selected_seat_labels"] = seats_from_text
            if len(seats_from_text) > current_state.get("seats_requested", 1):
                current_state["seats_requested"] = len(seats_from_text)

        # Check explicit confirmation words
        is_explicit_confirm = (
            request.action == "confirm"
            or any(w in user_text for w in ["confirm booking", "confirm ride", "confirm", "proceed", "go ahead"])
            or bool(llm_intent and llm_intent.is_confirming)
        )

        # If user picked a departure AND has NOT specified seats yet AND did not send explicit confirm:
        # -> Fetch specific details and seat map for that departure, and present seat selection!
        if matched_dep and not seats_from_text and not is_explicit_confirm:
            current_state["current_departure"] = matched_dep
            token = current_state.get("auth_token")
            available_seats = []
            try:
                seat_map_resp = await api_client.get_departure_seat_map(matched_dep["id"], token=token)
                cells = seat_map_resp.get("cells", [])
                available_seats = [c.get("label") for c in cells if c.get("status") == "AVAILABLE" and c.get("label")]
            except Exception:
                if "Innova" in matched_dep.get("vehicle_name", ""):
                    available_seats = ["1A (Front)", "2A (Window)", "2B (Aisle)", "3A (Window)"]
                else:
                    available_seats = ["1A (Front)", "2A (Window)", "2B (Middle)", "2C (Window)"]

            current_state["available_seat_labels"] = available_seats
            dep_time_display = _format_dep_time(matched_dep)
            vehicle_name = matched_dep.get("vehicle_name") or matched_dep.get("vehicle_model") or "Fixed Shared Cab"
            driver_name = matched_dep.get("driver_name") or "Assigned Driver"
            fare = matched_dep.get("fare_per_seat") or matched_dep.get("price_per_seat") or 35.0
            has_lug = current_state.get("has_extra_luggage", False)
            lug_cnt = current_state.get("extra_luggage_count", 0)
            lug_text = f"{lug_cnt} extra bag(s) included" if has_lug else "No extra luggage"
            seats_text = ", ".join(available_seats) if available_seats else "Open seating"

            seats_req = current_state.get("seats_requested", 1)
            if seats_req > 1:
                fare_display = f"₹{fare} per seat (Total: ₹{fare * seats_req} for {seats_req} seats)"
                sample_seats = ', '.join(available_seats[:seats_req]) if available_seats else 'Seat 1A'
                seat_prompt = f"Which seats would you like to reserve? (Reply with {seats_req} seat choices like 'Seats {sample_seats}', or reply 'Confirm' to auto-assign {seats_req} seats)."
            else:
                fare_display = f"₹{fare} per seat"
                seat_prompt = "Which seat would you like to reserve? (Reply with your seat choice like 'Seat 1A', or reply 'Confirm' to auto-assign a seat)."

            reply_text = (
                f"**Ride Details ({dep_time_display})**:\n"
                f"• **Vehicle**: {vehicle_name} (Driver: {driver_name})\n"
                f"• **Fare**: {fare_display}\n"
                f"• **Luggage**: {lug_text}\n"
                f"• **Available Seats**: {seats_text}\n\n"
                f"{seat_prompt}"
            )

            current_state["messages"].append(AIMessage(content=reply_text))
            booking_graph.update_state(config, {
                "current_departure": matched_dep,
                "available_seat_labels": available_seats,
                "messages": [AIMessage(content=reply_text)],
            })
            audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_text, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=reply_text,
                stage="CONFIRMING_DEPARTURE",
                thread_id=request.thread_id,
                options=shaped_options,
                selected_departure=shaped_selected_dep,
                matched_route=shaped_route,
                available_seats=available_seats,
                selected_seats=current_state.get("selected_seat_labels"),
                seats_requested=seats_req,
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # Check if requested seat is already occupied (Scenario 23)
        if seats_from_text and current_state.get("available_seat_labels"):
            avail_labels = [s.split()[0].upper() for s in current_state["available_seat_labels"]]
            requested_labels = [s.split()[0].upper() for s in seats_from_text]
            unavailable = [s for s in requested_labels if s not in avail_labels]
            if unavailable:
                unavail_str = ", ".join(unavailable)
                alt_seat = current_state["available_seat_labels"][0]
                reply_text = (
                    f"⚠️ *Note: Seat {unavail_str} is already occupied.*\n\n"
                    f"**Available Seats**: {', '.join(current_state['available_seat_labels'])}\n\n"
                    f"👉 Would you like **{alt_seat}** or another available seat?"
                )
                audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_text, request.voice_mode, request.preferred_language)
                shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
                return ChatResponse(
                    reply=reply_text,
                    stage="CONFIRMING_DEPARTURE",
                    thread_id=request.thread_id,
                    options=shaped_options,
                    selected_departure=shaped_selected_dep,
                    matched_route=shaped_route,
                    available_seats=current_state["available_seat_labels"],
                    selected_seats=None,
                    seats_requested=current_state.get("seats_requested", 1),
                    luggage={
                        "has_extra_luggage": current_state.get("has_extra_luggage", False),
                        "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                    },
                    audio_base64=audio_b64,
                    audio_format="mp3" if audio_b64 else None,
                    audio_language=audio_lang,
                )

        # If user picked a departure and is ready to confirm, or has picked a seat:
        if matched_dep:
            current_state["current_departure"] = matched_dep

        # If user picked a seat without confirming yet (Scenario 25)
        has_confirm_keyword = is_explicit_confirm or any(word in user_text for word in ["yes", "okay", "ok", "confirm", "proceed", "go ahead", "book", "reserve", "hold", "prefer", "give me", "want", "take", "window"])
        is_just_seat_name = bool(re.match(r"^(?:seat\s+)?[1-4][a-d](?:\s+please)?$", user_text.strip()))
        if is_just_seat_name and seats_from_text and not is_explicit_confirm:
            current_state["selected_seat_labels"] = seats_from_text
            dep = current_state.get("current_departure") or (rem_deps[0] if rem_deps else {})
            dep_time_disp = _format_dep_time(dep)
            veh_name = dep.get("vehicle_name") or dep.get("vehicle_model") or "the vehicle"
            seats_str = ", ".join(seats_from_text)
            reply_text = f"Got it, seat {seats_str} selected! Reply **'Confirm'** to hold this seat on {veh_name} ({dep_time_disp})."
            current_state["messages"].append(AIMessage(content=reply_text))
            booking_graph.update_state(config, current_state)
            audio_b64, audio_lang = await _synthesize_voice_if_requested(reply_text, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=reply_text,
                stage="CONFIRMING_DEPARTURE",
                thread_id=request.thread_id,
                options=shaped_options,
                selected_departure=shaped_selected_dep,
                matched_route=shaped_route,
                available_seats=current_state.get("available_seat_labels"),
                selected_seats=seats_from_text,
                seats_requested=current_state.get("seats_requested", len(seats_from_text)),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                seat_hold_id=None,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # Only confirm if a departure was already selected or matched AND has_confirm_keyword
        is_confirm = has_confirm_keyword and (bool(current_state.get("current_departure")) or bool(rem_deps))

        if is_confirm:
            if not current_state.get("current_departure") and rem_deps:
                current_state["current_departure"] = rem_deps[0]

            # Advance to creating hold
            updated = await node_create_hold(current_state)
            if updated.get("seat_hold_id"):
                SEAT_HOLD_THREADS[updated["seat_hold_id"]] = request.thread_id

            booking_graph.update_state(config, updated)
            last_msg = updated["messages"][-1].content
            audio_b64, audio_lang = await _synthesize_voice_if_requested(last_msg, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=last_msg,
                stage=updated.get("stage", "AWAITING_DRIVER"),
                thread_id=request.thread_id,
                seat_hold_id=updated.get("seat_hold_id"),
                options=None,
                selected_departure=shaped_selected_dep,
                matched_route=shaped_route,
                available_seats=None,
                selected_seats=updated.get("selected_seat_labels"),
                seats_requested=updated.get("seats_requested", current_state.get("seats_requested", 1)),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

    # Handle messages while waiting for driver acceptance
    if current_stage == "AWAITING_DRIVER":
        from graph.nodes import (
            _match_departure_from_text,
            _parse_seat_labels_from_text,
            _format_dep_time,
            node_present_options,
            node_create_hold,
            node_handle_driver_acceptance,
            node_handle_driver_rejection,
            api_client,
        )

        # Check if user wants to change seat and confirm immediately (Scenario 25)
        new_seats = _parse_seat_labels_from_text(request.message, current_state.get("available_seat_labels", []))
        if new_seats and any(w in user_text for w in ["confirm", "hold", "book", "please"]):
            current_state["selected_seat_labels"] = new_seats
            updated = await node_create_hold(current_state)
            if updated.get("seat_hold_id"):
                SEAT_HOLD_THREADS[updated["seat_hold_id"]] = request.thread_id
            booking_graph.update_state(config, updated)
            last_msg = updated["messages"][-1].content
            audio_b64, audio_lang = await _synthesize_voice_if_requested(last_msg, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=last_msg,
                stage="AWAITING_DRIVER",
                thread_id=request.thread_id,
                seat_hold_id=updated.get("seat_hold_id"),
                options=None,
                selected_departure=shaped_selected_dep,
                matched_route=shaped_route,
                available_seats=None,
                selected_seats=updated.get("selected_seat_labels"),
                seats_requested=current_state.get("seats_requested", 1),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )
        cur_dep = current_state.get("current_departure") or {}
        driver_name = cur_dep.get("driver_name", "the driver")
        veh_name = cur_dep.get("vehicle_name", "the vehicle")
        seats = ", ".join(current_state.get("selected_seat_labels") or ["Auto"])

        # Check if driver has already accepted or rejected the seat hold in the backend
        hold_id = current_state.get("seat_hold_id")
        token = current_state.get("auth_token")
        if hold_id and hold_id != 999:
            try:
                hold_resp = await api_client.get_seat_hold(hold_id, token=token)
                hold_data = hold_resp.get("hold", hold_resp)
                if hold_data.get("status") == "ACCEPTED":
                    updated = await node_handle_driver_acceptance(current_state)
                    booking_graph.update_state(config, updated)
                    accept_msg = updated["messages"][-1].content
                    audio_b64, audio_lang = await _synthesize_voice_if_requested(accept_msg, request.voice_mode, request.preferred_language)
                    shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
                    return ChatResponse(
                        reply=accept_msg,
                        stage="ACCEPTED_PAYMENT",
                        thread_id=request.thread_id,
                        options=None,
                        selected_departure=shaped_selected_dep,
                        matched_route=shaped_route,
                        available_seats=None,
                        selected_seats=current_state.get("selected_seat_labels"),
                        seats_requested=current_state.get("seats_requested", 1),
                        luggage={
                            "has_extra_luggage": current_state.get("has_extra_luggage", False),
                            "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                        },
                        seat_hold_id=hold_id,
                        payment_order=updated.get("payment_order"),
                        audio_base64=audio_b64,
                        audio_format="mp3" if audio_b64 else None,
                        audio_language=audio_lang,
                    )
                elif hold_data.get("status") == "REJECTED":
                    updated = await node_handle_driver_rejection(current_state)
                    booking_graph.update_state(config, updated)
                    rej_msg = updated["messages"][-1].content
                    audio_b64, audio_lang = await _synthesize_voice_if_requested(rej_msg, request.voice_mode, request.preferred_language)
                    shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(updated)
                    return ChatResponse(
                        reply=rej_msg,
                        stage="CONFIRMING_DEPARTURE",
                        thread_id=request.thread_id,
                        options=shaped_options,
                        selected_departure=shaped_selected_dep,
                        matched_route=shaped_route,
                        available_seats=updated.get("available_seat_labels"),
                        selected_seats=None,
                        seats_requested=current_state.get("seats_requested", 1),
                        luggage={
                            "has_extra_luggage": current_state.get("has_extra_luggage", False),
                            "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                        },
                        seat_hold_id=None,
                        audio_base64=audio_b64,
                        audio_format="mp3" if audio_b64 else None,
                        audio_language=audio_lang,
                    )
            except Exception:
                pass

        # Check if user wants to cancel or choose a different ride
        is_cancel_or_switch = any(
            w in user_text for w in [
                "cancel", "stop", "change", "switch", "different", "other",
                "first", "second", "third", "pick another", "choose another"
            ]
        ) or bool(_match_departure_from_text(request.message, current_state.get("remaining_departures", [])))

        if is_cancel_or_switch:
            # Revert to CONFIRMING_DEPARTURE so user can pick another ride
            current_state["stage"] = "CONFIRMING_DEPARTURE"
            current_state["current_departure"] = None
            current_state["available_seat_labels"] = []
            current_state["selected_seat_labels"] = []
            current_state["seat_hold_id"] = None

            options_result = await node_present_options(current_state)
            current_state.update(options_result)
            booking_graph.update_state(config, current_state)

            msg_txt = "Ride request cancelled. Here are the available rides on this route:\n\n" + options_result["messages"][-1].content
            audio_b64, audio_lang = await _synthesize_voice_if_requested(msg_txt, request.voice_mode, request.preferred_language)
            shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
            return ChatResponse(
                reply=msg_txt,
                stage="CONFIRMING_DEPARTURE",
                thread_id=request.thread_id,
                options=shaped_options,
                selected_departure=None,
                matched_route=shaped_route,
                available_seats=[],
                selected_seats=None,
                seats_requested=current_state.get("seats_requested", 1),
                luggage={
                    "has_extra_luggage": current_state.get("has_extra_luggage", False),
                    "extra_luggage_count": current_state.get("extra_luggage_count", 0),
                },
                seat_hold_id=None,
                audio_base64=audio_b64,
                audio_format="mp3" if audio_b64 else None,
                audio_language=audio_lang,
            )

        # Status check or general waiting reply
        status_msg = (
            f"We are waiting for driver **{driver_name}** to accept your ride request on **{veh_name}** (Seat {seats}).\n\n"
            f"Please wait a moment for their response, or reply *'Cancel'* to choose another ride."
        )
        audio_b64, audio_lang = await _synthesize_voice_if_requested(status_msg, request.voice_mode, request.preferred_language)
        shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(current_state)
        return ChatResponse(
            reply=status_msg,
            stage="AWAITING_DRIVER",
            thread_id=request.thread_id,
            options=None,
            selected_departure=shaped_selected_dep,
            matched_route=shaped_route,
            available_seats=None,
            selected_seats=current_state.get("selected_seat_labels"),
            seats_requested=current_state.get("seats_requested", 1),
            luggage={
                "has_extra_luggage": current_state.get("has_extra_luggage", False),
                "extra_luggage_count": current_state.get("extra_luggage_count", 0),
            },
            seat_hold_id=current_state.get("seat_hold_id"),
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
    if request.seats_requested is not None:
        inputs["seats_requested"] = request.seats_requested

    result = await booking_graph.ainvoke(inputs, config=config)

    # Check if this was a one-shot booking confirmation (e.g. "Confirm seat on 10:30 AM Innova to Sopore.")
    is_one_shot_confirm = any(k in user_text for k in ["confirm seat", "confirm booking", "confirm ride", "confirm my seat"])
    if result.get("stage") == "CONFIRMING_DEPARTURE" and is_one_shot_confirm and result.get("current_departure"):
        from graph.nodes import node_create_hold
        hold_res = await node_create_hold(result)
        result.update(hold_res)
        if result.get("seat_hold_id"):
            SEAT_HOLD_THREADS[result["seat_hold_id"]] = request.thread_id
        booking_graph.update_state(config, result)

    last_reply = result["messages"][-1].content if result.get("messages") else "Processing..."
    audio_b64, audio_lang = await _synthesize_voice_if_requested(last_reply, request.voice_mode, request.preferred_language)
    shaped_route, shaped_options, shaped_selected_dep = _shape_chat_response_data(result)
    
    return ChatResponse(
        reply=last_reply,
        stage=result.get("stage", "UNKNOWN"),
        thread_id=request.thread_id,
        options=shaped_options,
        selected_departure=shaped_selected_dep,
        matched_route=shaped_route,
        available_seats=result.get("available_seat_labels"),
        selected_seats=result.get("selected_seat_labels"),
        seats_requested=result.get("seats_requested", 1),
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
        seats_requested=updated.get("seats_requested", state.get("seats_requested", 1)),
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


def _mask_key(key: Optional[str]) -> Optional[str]:
    if not key:
        return None
    k = key.strip()
    if len(k) <= 8:
        return "****"
    return k[:4] + "..." + k[-4:]


@app.get("/admin/api-keys", response_model=ApiKeyConfigResponse)
async def get_api_key_config(x_admin_key: Optional[str] = Header(None)):
    """Returns currently loaded LLM provider and masked API keys."""
    return ApiKeyConfigResponse(
        openai_api_key_masked=_mask_key(settings.OPENAI_API_KEY),
        gemini_api_key_masked=_mask_key(settings.GEMINI_API_KEY),
        llm_provider=settings.LLM_PROVIDER,
        status="configured" if (settings.OPENAI_API_KEY or settings.GEMINI_API_KEY) else "missing",
    )


@app.post("/admin/api-keys", response_model=ApiKeyConfigResponse)
async def update_api_key_config(payload: ApiKeyConfigRequest, x_admin_key: Optional[str] = Header(None)):
    """Dynamically updates API keys and provider in memory and persists to .env."""
    import os

    if payload.openai_api_key is not None:
        key = payload.openai_api_key.strip()
        settings.OPENAI_API_KEY = key if key else None
        os.environ["OPENAI_API_KEY"] = key if key else ""

    if payload.gemini_api_key is not None:
        key = payload.gemini_api_key.strip()
        settings.GEMINI_API_KEY = key if key else None
        os.environ["GEMINI_API_KEY"] = key if key else ""

    if payload.llm_provider is not None:
        settings.LLM_PROVIDER = payload.llm_provider.strip().lower()

    # Persist to agent-service/.env
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
    env_lines = []
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            env_lines = f.readlines()

    def set_env_var(lines, key, val):
        found = False
        new_lines = []
        for line in lines:
            if line.startswith(f"{key}="):
                new_lines.append(f"{key}={val}\n")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"{key}={val}\n")
        return new_lines

    if settings.OPENAI_API_KEY:
        env_lines = set_env_var(env_lines, "OPENAI_API_KEY", settings.OPENAI_API_KEY)
    if settings.GEMINI_API_KEY:
        env_lines = set_env_var(env_lines, "GEMINI_API_KEY", settings.GEMINI_API_KEY)
    if settings.LLM_PROVIDER:
        env_lines = set_env_var(env_lines, "LLM_PROVIDER", settings.LLM_PROVIDER)

    try:
        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(env_lines)
    except Exception:
        pass

    return ApiKeyConfigResponse(
        openai_api_key_masked=_mask_key(settings.OPENAI_API_KEY),
        gemini_api_key_masked=_mask_key(settings.GEMINI_API_KEY),
        llm_provider=settings.LLM_PROVIDER,
        status="configured" if (settings.OPENAI_API_KEY or settings.GEMINI_API_KEY) else "missing",
    )


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8105, reload=True)
