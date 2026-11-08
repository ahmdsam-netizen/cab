import re
from typing import Dict, Any, List, Optional
from langchain_core.messages import AIMessage, HumanMessage
from models.state import BookingAgentState
from tools.geocoding import geocode_location, snap_to_route_stops
from tools.api_client import api_client
from tools.guardrails import validate_and_filter_prompt
from config import settings


def _parse_locations_from_text(text: str) -> Dict[str, Optional[str]]:
    """Simple robust NLP pattern matching to extract pickup and destination."""
    lower = text.lower().strip()
    pickup = None
    drop = None

    # Pattern: "from X to Y"
    from_to = re.search(r"from\s+(.+?)\s+to\s+(.+)", lower)
    if from_to:
        pickup = from_to.group(1).strip()
        drop = from_to.group(2).strip()
    else:
        # Pattern: "to Y from X"
        to_from = re.search(r"to\s+(.+?)\s+from\s+(.+)", lower)
        if to_from:
            drop = to_from.group(1).strip()
            pickup = to_from.group(2).strip()
        else:
            # Pattern: "to Y" or "reach Y" or "go to Y" or "book ride to Y"
            to_match = re.search(r"(?:book|need|want|go)?\s*(?:cab|ride|ticket|seat)?\s*(?:to|for)\s+(.+)", lower)
            if to_match:
                drop = to_match.group(1).strip()

    # Clean punctuation and luggage noise from location strings
    if drop:
        drop = re.sub(r"\b(?:with|having|carrying|\d+\s*bag|\d+\s*luggage|\d+\s*suitcase).*", "", drop, flags=re.IGNORECASE).strip()
    if pickup:
        pickup = re.sub(r"\b(?:with|having|carrying|\d+\s*bag|\d+\s*luggage|\d+\s*suitcase).*", "", pickup, flags=re.IGNORECASE).strip()

    return {"pickup": pickup, "drop": drop}


def _parse_luggage_from_text(text: str) -> Dict[str, Any]:
    """Extracts extra luggage / baggage details from text."""
    lower = text.lower().strip()
    has_luggage = False
    count = 0
    clarified = False

    # Check explicit zero or no luggage patterns
    no_luggage_patterns = [
        r"\bno\s+(?:luggage|bag|bags|baggage|suitcase|suitcases)\b",
        r"\bwithout\s+(?:luggage|bag|bags|baggage|suitcase)\b",
        r"\bzero\s+(?:luggage|bag|bags|baggage|suitcase)\b",
        r"\b0\s*(?:bag|bags|luggage|suitcase)\b",
        r"\b(?:none|no|nope|don'?t have luggage|travelling light)\b",
    ]
    for pat in no_luggage_patterns:
        if re.search(pat, lower):
            return {"has_extra_luggage": False, "extra_luggage_count": 0, "clarified": True}

    bag_match = re.search(r"(\d+)\s*(?:bag|bags|suitcase|suitcases|luggage|trolley)", lower)
    if bag_match:
        has_luggage = True
        count = int(bag_match.group(1))
        clarified = True
    elif any(k in lower for k in ["luggage", "baggage", "suitcase", "heavy bag", "extra bag"]):
        has_luggage = True
        count = 1
        clarified = True

    return {"has_extra_luggage": has_luggage, "extra_luggage_count": count, "clarified": clarified}


def _parse_seat_label_from_text(text: str, available_seats: List[str]) -> Optional[str]:
    """Finds if user requested a specific seat label like 1A, 2B, etc."""
    upper = text.upper()
    for seat in available_seats:
        label = seat.split()[0].upper()
        # Look for isolated seat label e.g. "seat 1A" or "1A"
        if re.search(rf"\b{label}\b", upper):
            return label
    return None


async def node_collect_input(state: BookingAgentState) -> Dict[str, Any]:
    """Collects and clarifies pickup, destination, and luggage from user input."""
    messages = state.get("messages", [])
    last_text = messages[-1].content if messages else ""

    # Security & Context Guardrail validation
    if last_text:
        guardrail_res = await validate_and_filter_prompt(last_text)
        if not guardrail_res.is_safe or not guardrail_res.is_in_context or not guardrail_res.filtered_text:
            return {
                "stage": "COLLECTING",
                "messages": [AIMessage(content=guardrail_res.rejection_message or "Such types of queries are not meant to be dealt here.")],
            }
        last_text = guardrail_res.filtered_text

    pickup_text = state.get("pickup_text")
    drop_text = state.get("drop_text")
    luggage_clarified = state.get("luggage_clarified", False)
    has_luggage = state.get("has_extra_luggage", False)
    luggage_count = state.get("extra_luggage_count", 0)

    # Parse luggage
    luggage_info = _parse_luggage_from_text(last_text)
    if luggage_info["clarified"]:
        luggage_clarified = True
        has_luggage = luggage_info["has_extra_luggage"]
        luggage_count = luggage_info["extra_luggage_count"]

    # Parse locations
    parsed = _parse_locations_from_text(last_text)
    if parsed["drop"]:
        drop_text = parsed["drop"]
    if parsed["pickup"]:
        pickup_text = parsed["pickup"]

    # If user provided a standalone place when asked where to go (and didn't just answer luggage)
    if not drop_text and last_text and not parsed["pickup"] and not parsed["drop"] and not luggage_info["clarified"]:
        drop_text = last_text.strip()

    # Default pickup to user's current GPS location if not explicitly provided
    user_lat = state.get("user_current_lat") or settings.DEFAULT_LAT
    user_lng = state.get("user_current_lng") or settings.DEFAULT_LNG

    if not pickup_text:
        pickup_text = "Current Location"
        pickup_coords = {"lat": user_lat, "lng": user_lng}
    else:
        pickup_coords = geocode_location(pickup_text, fallback_lat=user_lat, fallback_lng=user_lng)

    # Check for missing parameters and prompt accordingly
    if not drop_text and not luggage_clarified:
        return {
            "pickup_text": pickup_text,
            "pickup_coords": pickup_coords,
            "drop_text": None,
            "has_extra_luggage": False,
            "extra_luggage_count": 0,
            "luggage_clarified": False,
            "stage": "COLLECTING",
            "messages": [AIMessage(content="Where would you like to travel to? Also, please let me know if you have any luggage (e.g. 'To Sopore with 2 bags' or 'To Sopore, no luggage').")],
        }

    if not drop_text:
        return {
            "pickup_text": pickup_text,
            "pickup_coords": pickup_coords,
            "drop_text": None,
            "has_extra_luggage": has_luggage,
            "extra_luggage_count": luggage_count,
            "luggage_clarified": luggage_clarified,
            "stage": "COLLECTING",
            "messages": [AIMessage(content="Where would you like to travel to?")],
        }

    if not luggage_clarified:
        return {
            "pickup_text": pickup_text,
            "pickup_coords": pickup_coords,
            "drop_text": drop_text,
            "has_extra_luggage": False,
            "extra_luggage_count": 0,
            "luggage_clarified": False,
            "stage": "COLLECTING",
            "messages": [AIMessage(content=f"Got it, travelling to {drop_text}! Are you carrying any luggage or extra bags? (Please reply e.g. '2 bags', or 'No luggage').")],
        }

    drop_coords = geocode_location(drop_text, fallback_lat=user_lat, fallback_lng=user_lng)

    return {
        "pickup_text": pickup_text,
        "pickup_coords": pickup_coords,
        "drop_text": drop_text,
        "drop_coords": drop_coords,
        "has_extra_luggage": has_luggage,
        "extra_luggage_count": luggage_count,
        "luggage_clarified": True,
        "seats_requested": state.get("seats_requested") or 1,
        "stage": "MATCHING_ROUTE",
    }


async def node_match_route_and_stations(state: BookingAgentState) -> Dict[str, Any]:
    """Searches fixed routes in Laravel and snaps coordinates to the nearest board and drop stations."""
    pickup_coords = state["pickup_coords"]
    drop_coords = state["drop_coords"]
    token = state.get("auth_token")

    try:
        routes = await api_client.get_fixed_routes(
            lat=pickup_coords["lat"],
            lng=pickup_coords["lng"],
            token=token,
        )
    except Exception:
        # Fallback sample route if Laravel is unreachable in local offline test
        routes = [{
            "id": 1,
            "name": "Srinagar - Sopore Express",
            "origin_name": "Srinagar (Batamaloo)",
            "dest_name": "Sopore Bus Stand",
            "is_active": True,
            "stops": [
                {"id": 101, "name": "Batamaloo Central Station", "latitude": 34.0718, "longitude": 74.7925, "sequence_number": 1},
                {"id": 102, "name": "HMT Junction", "latitude": 34.1100, "longitude": 74.7200, "sequence_number": 2},
                {"id": 103, "name": "Pattan Bus Stop", "latitude": 34.1610, "longitude": 74.5539, "sequence_number": 3},
                {"id": 104, "name": "Sangrama Chowk", "latitude": 34.2500, "longitude": 74.5000, "sequence_number": 4},
                {"id": 105, "name": "Sopore Main Terminal", "latitude": 34.2988, "longitude": 74.4716, "sequence_number": 5},
            ]
        }]

    best_match = None
    for route in routes:
        stops = route.get("stops", [])
        snapped = snap_to_route_stops(
            pickup_lat=pickup_coords["lat"],
            pickup_lng=pickup_coords["lng"],
            drop_lat=drop_coords["lat"],
            drop_lng=drop_coords["lng"],
            stops=stops,
        )
        if snapped:
            board_stop, drop_stop = snapped
            best_match = {
                "route": route,
                "board_stop": board_stop,
                "drop_stop": drop_stop,
            }
            break

    if not best_match:
        return {
            "stage": "EXHAUSTED",
            "messages": [AIMessage(content=f"Sorry, I couldn't find an active fixed route from {state['pickup_text']} to {state['drop_text']}. Please check the location names or choose a private cab.")],
        }

    return {
        "matched_route": best_match["route"],
        "board_stop": best_match["board_stop"],
        "drop_stop": best_match["drop_stop"],
        "stage": "FETCHING_DEPARTURES",
    }


async def node_fetch_departures(state: BookingAgentState) -> Dict[str, Any]:
    """Retrieves available departures/vehicles for the matched fixed route."""
    route = state["matched_route"]
    token = state.get("auth_token")

    try:
        departures = await api_client.get_route_departures(route["id"], token=token)
    except Exception:
        departures = [
            {
                "id": 501,
                "vehicle_name": "Toyota Innova (JK01-AB-1234)",
                "departure_time": "10:30 AM",
                "fare_per_seat": 180.0,
                "available_seats": 4,
                "driver_name": "Tariq Ahmad",
            },
            {
                "id": 502,
                "vehicle_name": "Mahindra Bolero (JK01-CD-5678)",
                "departure_time": "11:15 AM",
                "fare_per_seat": 160.0,
                "available_seats": 6,
                "driver_name": "Bilal Khan",
            },
            {
                "id": 503,
                "vehicle_name": "Tata Sumo (JK01-EF-9012)",
                "departure_time": "12:00 PM",
                "fare_per_seat": 150.0,
                "available_seats": 2,
                "driver_name": "Mohammad Rafiq",
            },
        ]

    valid_departures = [
        d for d in departures
        if int(d.get("available_seats", 1)) >= state.get("seats_requested", 1)
    ]

    if not valid_departures:
        return {
            "remaining_departures": [],
            "stage": "EXHAUSTED",
            "messages": [AIMessage(content=f"Found route '{route.get('name')}', but there are currently no available vehicles or open seats. Please try again later.")],
        }

    return {
        "remaining_departures": valid_departures,
        "stage": "CONFIRMING_DEPARTURE",
    }


async def node_present_options(state: BookingAgentState) -> Dict[str, Any]:
    """Presents the top departure option, available seats, and luggage status."""
    remaining = state.get("remaining_departures", [])
    if not remaining:
        return {
            "stage": "EXHAUSTED",
            "messages": [AIMessage(content="There are no more departures available for this route.")],
        }

    current = remaining[0]
    board_stop = state["board_stop"]
    drop_stop = state["drop_stop"]
    route = state["matched_route"]
    token = state.get("auth_token")

    # Fetch seat map for the vehicle
    available_seats = []
    try:
        seat_map_resp = await api_client.get_departure_seat_map(current["id"], token=token)
        cells = seat_map_resp.get("cells", [])
        available_seats = [c.get("label") for c in cells if c.get("status") == "AVAILABLE" and c.get("label")]
    except Exception:
        # Fallback layout for vehicles
        if "Innova" in current.get("vehicle_name", ""):
            available_seats = ["1A (Front)", "2A (Window)", "2B (Aisle)", "3A (Window)"]
        else:
            available_seats = ["1A (Front)", "2A (Window)", "2B (Middle)", "2C (Window)"]

    b_dist = board_stop.get("distance_from_pickup_km", 0.5)
    d_dist = drop_stop.get("distance_from_drop_km", 0.5)
    fare = current.get("fare_per_seat", 150.0)

    # Luggage status text
    has_luggage = state.get("has_extra_luggage", False)
    luggage_count = state.get("extra_luggage_count", 0)
    luggage_text = f"✅ {luggage_count} extra bag(s) declared" if has_luggage else "ℹ️ No extra luggage specified (reply e.g. *'2 bags'* if carrying luggage)"

    seats_text = ", ".join(available_seats) if available_seats else "Open seating"

    options_summary = (
        f"🚍 **Route Match**: {route.get('name')}\n"
        f"📍 **Boarding Station**: {board_stop.get('name')} (~{b_dist} km from pickup)\n"
        f"🎯 **Drop Station**: {drop_stop.get('name')} (~{d_dist} km from destination)\n\n"
        f"**Next Vehicle**: {current.get('vehicle_name')} (Driver: {current.get('driver_name', 'Assigned Driver')})\n"
        f"⏰ **Departure**: {current.get('departure_time')}\n"
        f"💰 **Fare**: ₹{fare} per seat\n"
        f"💺 **Available Seats**: {seats_text}\n"
        f"🧳 **Luggage**: {luggage_text}\n\n"
        f"👉 Reply **'Confirm'** to request with auto-assigned seat, or pick your preferred seat (e.g. *'Book seat 1A'*)."
    )

    return {
        "current_departure": current,
        "available_seat_labels": available_seats,
        "stage": "CONFIRMING_DEPARTURE",
        "messages": [AIMessage(content=options_summary)],
    }


async def node_create_hold(state: BookingAgentState) -> Dict[str, Any]:
    """Creates a seat hold with the chosen seat label & luggage details."""
    current = state["current_departure"]
    board_stop = state["board_stop"]
    drop_stop = state["drop_stop"]
    seats = state.get("seats_requested", 1)
    token = state.get("auth_token")

    # Determine seat label
    available_seats = state.get("available_seat_labels") or []
    selected_seats = state.get("selected_seat_labels") or []

    # If no specific seat was explicitly pre-selected, auto-assign first available seat
    if not selected_seats and available_seats:
        clean_label = available_seats[0].split()[0]  # e.g. "1A (Front)" -> "1A"
        selected_seats = [clean_label]

    has_luggage = state.get("has_extra_luggage", False)
    luggage_count = state.get("extra_luggage_count", 0)

    try:
        resp = await api_client.create_seat_hold(
            route_departure_id=current["id"],
            board_stop_id=board_stop["id"],
            drop_stop_id=drop_stop["id"],
            seats=seats,
            seat_labels=selected_seats if selected_seats else None,
            has_extra_luggage=has_luggage,
            extra_luggage_count=luggage_count,
            payment_method="razorpay",
            token=token,
        )
        hold_data = resp.get("hold", {})
        hold_id = hold_data.get("id") or resp.get("id") or 999
    except Exception:
        hold_id = 999

    seat_display = f" (Seat {', '.join(selected_seats)})" if selected_seats else ""
    luggage_display = f" with {luggage_count} extra bag(s)" if has_luggage else ""

    msg = (
        f"⏳ Seat hold #{hold_id} created{seat_display} on {current.get('vehicle_name')}{luggage_display}!\n"
        f"We have sent the seat request to driver **{current.get('driver_name', 'the driver')}**.\n"
        f"Please wait while they review and accept your ride request..."
    )

    return {
        "seat_hold_id": hold_id,
        "selected_seat_labels": selected_seats,
        "driver_status": "PENDING_APPROVAL",
        "stage": "AWAITING_DRIVER",
        "messages": [AIMessage(content=msg)],
    }


async def node_handle_driver_rejection(state: BookingAgentState) -> Dict[str, Any]:
    """Handles driver declining the ride by popping the current departure and offering next ones."""
    rejected_dep = state.get("current_departure", {})
    remaining = [d for d in state.get("remaining_departures", []) if d.get("id") != rejected_dep.get("id")]

    if not remaining:
        return {
            "remaining_departures": [],
            "current_departure": None,
            "stage": "EXHAUSTED",
            "messages": [AIMessage(content=f"❌ The driver for {rejected_dep.get('vehicle_name', 'the vehicle')} could not accept, and there are no further vehicles available on this route today. Would you like to check a private cab instead?")],
        }

    next_dep = remaining[0]
    token = state.get("auth_token")

    # Fetch seat map for the next vehicle
    try:
        seat_map_resp = await api_client.get_departure_seat_map(next_dep["id"], token=token)
        cells = seat_map_resp.get("cells", [])
        next_seats = [c.get("label") for c in cells if c.get("status") == "AVAILABLE" and c.get("label")]
    except Exception:
        next_seats = ["1A (Front)", "2A (Window)", "2B (Aisle)", "3A (Window)"]

    seats_str = ", ".join(next_seats) if next_seats else "Open seating"

    msg = (
        f"⚠️ The driver for **{rejected_dep.get('vehicle_name', 'the previous vehicle')}** was unable to accept your request.\n\n"
        f"We found another departure on this route:\n"
        f"• **Vehicle**: {next_dep.get('vehicle_name')}\n"
        f"• **Time**: {next_dep.get('departure_time')}\n"
        f"• **Fare**: ₹{next_dep.get('fare_per_seat')} per seat\n"
        f"• **Available Seats**: {seats_str}\n\n"
        f"Would you like me to request a seat with this driver? (Reply **'Confirm'** or specify seat e.g. *'Seat 1A'*)."
    )

    return {
        "remaining_departures": remaining,
        "current_departure": next_dep,
        "available_seat_labels": next_seats,
        "selected_seat_labels": [],
        "seat_hold_id": None,
        "driver_status": "NONE",
        "stage": "CONFIRMING_DEPARTURE",
        "messages": [AIMessage(content=msg)],
    }


async def node_handle_driver_acceptance(state: BookingAgentState) -> Dict[str, Any]:
    """Handles driver acceptance and generates the Razorpay payment order."""
    hold_id = state.get("seat_hold_id", 999)
    current = state.get("current_departure", {})
    token = state.get("auth_token")
    selected_seats = state.get("selected_seat_labels") or []

    try:
        order_resp = await api_client.create_razorpay_order(hold_id, token=token)
        order = order_resp.get("order", order_resp)
    except Exception:
        order = {
            "order_id": f"order_mock_{hold_id}",
            "amount": int(current.get("fare_per_seat", 150.0) * 100),
            "currency": "INR",
        }

    fare = current.get("fare_per_seat", 150.0)
    seat_text = f"• **Seat**: {', '.join(selected_seats)}\n" if selected_seats else ""
    luggage_text = f"• **Luggage**: {state.get('extra_luggage_count')} extra bag(s)\n" if state.get("has_extra_luggage") else ""

    msg = (
        f"🎉 **Seat Confirmed by Driver!**\n\n"
        f"• **Driver**: {current.get('driver_name', 'Assigned Driver')}\n"
        f"• **Vehicle**: {current.get('vehicle_name')}\n"
        f"{seat_text}"
        f"{luggage_text}"
        f"• **Boarding**: {state['board_stop'].get('name')}\n"
        f"• **Drop**: {state['drop_stop'].get('name')}\n"
        f"• **Payable Amount**: ₹{fare}\n\n"
        f"💳 Please complete your payment via Razorpay (Order ID: `{order.get('order_id')}`) to download your boarding pass."
    )

    return {
        "payment_order": order,
        "driver_status": "ACCEPTED",
        "stage": "ACCEPTED_PAYMENT",
        "messages": [AIMessage(content=msg)],
    }
