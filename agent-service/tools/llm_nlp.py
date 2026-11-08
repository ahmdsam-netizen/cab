import json
import logging
import re
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
import httpx

from config import settings

logger = logging.getLogger(__name__)


class ExtractedBookingIntent(BaseModel):
    intent: str = Field(
        "GENERAL",
        description="Intent: NEW_SEARCH, CLARIFY_LUGGAGE, SELECT_DEPARTURE, SELECT_SEATS, CONFIRM, CANCEL, SHOW_OTHER_RIDES, INQUIRY, UNRELATED"
    )
    pickup: Optional[str] = Field(None, description="Pickup landmark, station, or 'Current Location'")
    drop: Optional[str] = Field(None, description="Destination landmark or station")
    has_extra_luggage: Optional[bool] = Field(None, description="True if passenger has luggage/bags, False if none/zero/light, None if unmentioned")
    extra_luggage_count: Optional[int] = Field(None, description="Number of bags/suitcases/luggage pieces")
    seats_requested: Optional[int] = Field(1, description="Number of seats/passengers requested (default 1)")
    selected_seat_labels: Optional[List[str]] = Field(None, description="List of seat labels requested (e.g. ['1A'], ['2A', '2B']) or normalized from preference")
    selected_departure_time: Optional[str] = Field(None, description="Departure time mentioned by user (e.g. '10:30 AM', '11:15', '00:55')")
    selected_departure_ordinal: Optional[str] = Field(None, description="'first', 'second', 'third', 'last', 'next' departure")
    selected_vehicle_preference: Optional[str] = Field(None, description="'innova', 'bolero', 'sumo' if user specifies a vehicle type")
    language_detected: Optional[str] = Field("en", description="Language code: 'en', 'hi', 'ur', 'ks' (Kashmiri)")
    is_clarifying_luggage: bool = Field(False, description="True if answering a luggage clarification prompt")
    is_confirming: bool = Field(False, description="True if user is confirming or agreeing to proceed")
    is_cancelling: bool = Field(False, description="True if user wants to cancel")


SYSTEM_PROMPT = """You are the core NLP extraction engine for DreamCabs, a station-to-station fixed-route shared cab service in Kashmir (Srinagar, Sopore, Baramulla, Pattan, Sangrama, Sheikh ul-Alam Airport, etc.).

Your job is to analyze the user's natural language input in the context of fixed-route cab booking and extract all relevant booking entities into structured JSON.

You must handle:
1. English, Hinglish / Roman Urdu (e.g., "Batamaloo se Sopore jana hai, 1 bag sath hai", "Confirm kar do front seat 1A"), and Kashmiri transliteration (e.g., "Me chhu Sopore gatsun Batamaloo peth, bag chhum akh", "Confirm kariv").
2. Colloquial landmark mapping:
   - "Ghanta Ghar", "Lal Chowk", "Batamaloo Stand", "Hazratbal", "Sopore Stand", "Baramulla Stand", "Pattan Stop", "Sangrama Chowk", "Airport".
   - If user refers to their current place / "my location" / "here" / "current gps", set pickup="Current Location".
3. Luggage understanding:
   - Explicit bags: "1 bag", "2 suitcases", "3 luggage", "25kg trolley bag" -> has_extra_luggage=true, extra_luggage_count=N.
   - Negative luggage: "no luggage", "zero bags", "none", "traveling light", "just a jacket" -> has_extra_luggage=false, extra_luggage_count=0.
   - Self-corrections: "with 3 bags, actually no just 1 bag" -> extra_luggage_count=1.
4. Passenger / seat count:
   - "2 seats", "we are 2", "for 3 people", "couple", "pair", "2 tickets" -> seats_requested=2. Default is 1.
5. Seat preferences & labels:
   - Specific labels: "Seat 1A", "2A and 2B", "3A" -> selected_seat_labels=["1A"] or ["2A", "2B"].
   - "front passenger seat" / "front seat next to driver" -> map to ["1A"].
   - "window seat" -> map to ["2A"].
   - "middle seat" / "aisle seat" -> map to ["2B"].
6. Departure selection:
   - By time: "10:30 AM", "11:15", "12:00 PM", "22:55", "first ride", "second one", "next ride", "Innova", "Sumo".
7. Actions & confirmations:
   - Confirming: "confirm", "proceed", "yes", "okay", "go ahead", "haan confirm kar do", "kariv confirm" -> is_confirming=true.
   - Cancelling: "cancel", "stop", "change ride", "show other rides" -> is_cancelling=true.

Always output valid JSON strictly conforming to this schema:
{
  "intent": "NEW_SEARCH" | "CLARIFY_LUGGAGE" | "SELECT_DEPARTURE" | "SELECT_SEATS" | "CONFIRM" | "CANCEL" | "SHOW_OTHER_RIDES" | "INQUIRY" | "UNRELATED",
  "pickup": string or null,
  "drop": string or null,
  "has_extra_luggage": boolean or null,
  "extra_luggage_count": integer or null,
  "seats_requested": integer or 1,
  "selected_seat_labels": list of strings or null,
  "selected_departure_time": string or null,
  "selected_departure_ordinal": string or null,
  "selected_vehicle_preference": string or null,
  "language_detected": "en" | "hi" | "ur" | "ks",
  "is_clarifying_luggage": boolean,
  "is_confirming": boolean,
  "is_cancelling": boolean
}
"""


async def extract_booking_intent_llm(
    text: str,
    stage: str = "START",
    context: Optional[Dict[str, Any]] = None,
) -> Optional[ExtractedBookingIntent]:
    """
    Invokes the configured LLM (OpenAI / Gemini) with structured output
    to extract booking parameters from natural language.
    Returns None if no LLM key is configured or on network/API failure.
    """
    if not text or not text.strip():
        return None

    if getattr(settings, "LLM_PROVIDER", "").lower() == "mock":
        return None

    # Check for active API key
    has_openai = bool(settings.OPENAI_API_KEY and len(settings.OPENAI_API_KEY) > 10)
    has_gemini = bool(settings.GEMINI_API_KEY and len(settings.GEMINI_API_KEY) > 5)

    if not has_openai and not has_gemini:
        return None

    ctx_desc = f"Current conversation stage: {stage}."
    if context:
        if context.get("drop_text"):
            ctx_desc += f" Known destination: {context['drop_text']}."
        if context.get("pickup_text"):
            ctx_desc += f" Known pickup: {context['pickup_text']}."
        if context.get("available_seat_labels"):
            ctx_desc += f" Available seats for current ride: {context['available_seat_labels']}."
        if context.get("remaining_departures"):
            deps = [d.get("departure_time") or d.get("announced_depart_at") for d in context["remaining_departures"][:3]]
            ctx_desc += f" Upcoming departure times: {deps}."

    user_prompt = f"Context: {ctx_desc}\nUser message: \"{text.strip()}\""

    async def _call_gemini() -> Optional[ExtractedBookingIntent]:
        if not has_gemini:
            return None
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": SYSTEM_PROMPT + "\n\n" + user_prompt}
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.0,
            }
        }
        for model in ["gemini-3.5-flash-lite", "gemini-flash-latest"]:
            try:
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={settings.GEMINI_API_KEY}"
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(url, json=payload)
                    if resp.status_code == 200:
                        data = resp.json()
                        candidates = data.get("candidates", [])
                        if candidates:
                            raw_text = candidates[0]["content"]["parts"][0]["text"].strip()
                            if raw_text.startswith("```"):
                                raw_text = raw_text.split("```")[1]
                                if raw_text.startswith("json"):
                                    raw_text = raw_text[4:].strip()
                            parsed = json.loads(raw_text)
                            return ExtractedBookingIntent(**parsed)
                    else:
                        logger.warning(f"Gemini ({model}) extraction returned HTTP {resp.status_code}: {resp.text}")
            except Exception as e:
                logger.warning(f"Gemini ({model}) extraction failed: {type(e).__name__}: {e}")
        return None

    async def _call_openai() -> Optional[ExtractedBookingIntent]:
        if not has_openai:
            return None
        try:
            headers = {
                "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
                "Content-Type": "application/json",
            }
            body = {
                "model": getattr(settings, "OPENAI_MODEL_NAME", "gpt-4o-mini"),
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.0,
                "response_format": {"type": "json_object"},
            }
            async with httpx.AsyncClient(timeout=4.0) as client:
                resp = await client.post("https://api.openai.com/v1/chat/completions", headers=headers, json=body)
                if resp.status_code == 200:
                    data = resp.json()
                    content = data["choices"][0]["message"]["content"].strip()
                    parsed = json.loads(content)
                    return ExtractedBookingIntent(**parsed)
                else:
                    logger.warning(f"OpenAI NLP extraction returned HTTP {resp.status_code}: {resp.text}")
        except Exception as e:
            logger.warning(f"OpenAI NLP extraction failed: {e}")
        return None

    provider = (getattr(settings, "LLM_PROVIDER", "") or "").lower().strip()
    if provider in ["google", "gemini"]:
        res = await _call_gemini()
        if res is not None:
            return res
        return await _call_openai()
    else:
        res = await _call_openai()
        if res is not None:
            return res
        return await _call_gemini()
