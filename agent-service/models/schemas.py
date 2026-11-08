from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any


class ChatRequest(BaseModel):
    message: Optional[str] = Field(None, description="User's natural language input or option selection")
    input_type: Optional[str] = Field("text", description="Input modality: 'text' or 'voice'")
    audio_base64: Optional[str] = Field(None, description="Base64 encoded audio for voice input")
    thread_id: str = Field(..., description="Unique conversation session ID (e.g. user ID)")
    user_id: Optional[str] = Field(None, description="Authenticated Customer User ID")
    auth_token: Optional[str] = Field(None, description="Customer Sanctum Bearer token")
    user_current_lat: Optional[float] = Field(None, description="Device GPS Latitude")
    user_current_lng: Optional[float] = Field(None, description="Device GPS Longitude")
    action: Optional[str] = Field(None, description="Optional explicit action: 'confirm', 'cancel', 'select'")
    selected_departure_id: Optional[int] = Field(None, description="Departure ID chosen from options")
    has_extra_luggage: Optional[bool] = Field(None, description="Whether passenger has extra luggage")
    extra_luggage_count: Optional[int] = Field(None, description="Number of extra bags/suitcases")
    selected_seat_labels: Optional[List[str]] = Field(None, description="Preferred seat labels (e.g. ['1A'])")
    voice_mode: Optional[bool] = Field(False, description="Whether passenger wants an audio response alongside text")
    preferred_language: Optional[str] = Field("en", description="Language preference for voice: 'en', 'hi', or 'ur'")


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
    audio_base64: Optional[str] = Field(None, description="Base64 encoded MP3 audio response")
    audio_format: Optional[str] = Field("mp3", description="Audio format, e.g. 'mp3'")
    audio_language: Optional[str] = Field(None, description="Spoken voice language code ('en', 'hi', 'ur')")


class DriverEventRequest(BaseModel):
    seat_hold_id: int
    event: str = Field(..., description="DRIVER_ACCEPTED or DRIVER_REJECTED")
    driver_id: Optional[int] = None
    reason: Optional[str] = None


class RateLimitConfigRequest(BaseModel):
    max_conversations_per_day: Optional[int] = Field(None, ge=1, description="Max new conversations allowed per day per user")
    max_requests_per_day: Optional[int] = Field(None, ge=1, description="Max total requests allowed per day per user")
    max_requests_per_minute: Optional[int] = Field(None, ge=1, description="Burst / RPM limit per user")
    enabled: Optional[bool] = Field(None, description="Whether rate limiting is globally active")


class RateLimitConfigResponse(BaseModel):
    max_conversations_per_day: int
    max_requests_per_day: int
    max_requests_per_minute: int
    enabled: bool


class UserRateLimitUsageResponse(BaseModel):
    user_id: str
    date: str
    conversations_used_today: int
    max_conversations_per_day: int
    requests_used_today: int
    max_requests_per_day: int
    requests_last_minute: int
    max_requests_per_minute: int


class ApiKeyConfigRequest(BaseModel):
    openai_api_key: Optional[str] = Field(None, description="OpenAI API Key")
    gemini_api_key: Optional[str] = Field(None, description="Gemini / Google AI API Key")
    llm_provider: Optional[str] = Field(None, description="Active LLM provider: 'openai' or 'google'")


class ApiKeyConfigResponse(BaseModel):
    openai_api_key_masked: Optional[str] = None
    gemini_api_key_masked: Optional[str] = None
    llm_provider: str
    status: str

