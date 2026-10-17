from typing import TypedDict, Optional, List, Dict, Any, Annotated
from langgraph.graph.message import add_messages
from langchain_core.messages import BaseMessage


class BookingAgentState(TypedDict):
    # Chat conversation messages
    messages: Annotated[List[BaseMessage], add_messages]

    # User & Device context
    auth_token: Optional[str]
    user_current_lat: Optional[float]
    user_current_lng: Optional[float]

    # Extracted destination and origin queries
    pickup_text: Optional[str]
    drop_text: Optional[str]
    pickup_coords: Optional[Dict[str, float]]  # {"lat": float, "lng": float}
    drop_coords: Optional[Dict[str, float]]    # {"lat": float, "lng": float}
    seats_requested: int

    # Route and station snapping
    matched_route: Optional[Dict[str, Any]]
    board_stop: Optional[Dict[str, Any]]
    drop_stop: Optional[Dict[str, Any]]

    # Luggage & Baggage details
    has_extra_luggage: bool
    extra_luggage_count: int

    # Seat Selection
    available_seat_labels: List[str]
    selected_seat_labels: List[str]

    # Candidate vehicles / departures (ordered by departure time / preference)
    remaining_departures: List[Dict[str, Any]]
    current_departure: Optional[Dict[str, Any]]

    # Seat hold & driver lifecycle
    seat_hold_id: Optional[int]
    driver_status: Optional[str]  # "NONE", "PENDING_APPROVAL", "ACCEPTED", "REJECTED"
    
    # Payment order details
    payment_order: Optional[Dict[str, Any]]

    # FSM stage tracker
    stage: str  # "COLLECTING", "CONFIRMING_DEPARTURE", "AWAITING_DRIVER", "ACCEPTED_PAYMENT", "EXHAUSTED", "CANCELLED"
