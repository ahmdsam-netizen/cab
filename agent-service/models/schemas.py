from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


class ChatRequest(BaseModel):
    message: str = Field(..., description="User's natural language input or option selection")
    thread_id: str = Field(..., description="Unique conversation session ID (e.g. user ID)")
    auth_token: Optional[str] = Field(None, description="Customer Sanctum Bearer token")
    user_current_lat: Optional[float] = Field(None, description="Device GPS Latitude")
    user_current_lng: Optional[float] = Field(None, description="Device GPS Longitude")
    action: Optional[str] = Field(None, description="Optional explicit action: 'confirm', 'cancel', 'select'")
    selected_departure_id: Optional[int] = Field(None, description="Departure ID chosen from options")
    has_extra_luggage: Optional[bool] = Field(None, description="Whether passenger has extra luggage")
    extra_luggage_count: Optional[int] = Field(None, description="Number of extra bags/suitcases")
    selected_seat_labels: Optional[List[str]] = Field(None, description="Preferred seat labels (e.g. ['1A'])")


class ChatResponse(BaseModel):
    reply: str
    stage: str
    thread_id: str
    options: Optional[List[Dict[str, Any]]] = None
    matched_route: Optional[Dict[str, Any]] = None
    available_seats: Optional[List[str]] = None
    selected_seats: Optional[List[str]] = None
    luggage: Optional[Dict[str, Any]] = None
    seat_hold_id: Optional[int] = None
    payment_order: Optional[Dict[str, Any]] = None


class DriverEventRequest(BaseModel):
    seat_hold_id: int
    event: str = Field(..., description="DRIVER_ACCEPTED or DRIVER_REJECTED")
    driver_id: Optional[int] = None
    reason: Optional[str] = None
