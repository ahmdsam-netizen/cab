import re
import base64
import logging
from typing import Optional, Dict
import edge_tts

logger = logging.getLogger(__name__)

# Native Neural Voices for Indian English, Hindi, and Urdu
VOICE_MAP: Dict[str, str] = {
    "en": "en-IN-NeerjaNeural",     # Indian English (Fluent & natural)
    "hi": "hi-IN-SwaraNeural",      # Hindi (Clear & polite)
    "ur": "ur-IN-GulNeural",        # Urdu (Refined Indian Urdu)
}

# Fallback voice map if regional dialect preferred
VOICE_MAP_FALLBACKS: Dict[str, str] = {
    "en": "en-IN-PrabhatNeural",
    "hi": "hi-IN-MadhurNeural",
    "ur": "ur-PK-UzmaNeural",
}


def clean_text_for_speech(text: str) -> str:
    """
    Cleans markdown formatting, emojis, currency symbols, and special characters
    so that TTS speaks naturally without pronouncing syntax artifacts.
    """
    if not text:
        return ""

    s = text

    # Currency replacements
    s = re.sub(r"₹\s*(\d+)", r"\1 rupees", s)
    s = re.sub(r"Rs\.?\s*(\d+)", r"\1 rupees", s)

    # Remove markdown bold/italics/code/headers
    s = re.sub(r"[*_~`#]", "", s)

    # Replace arrows
    s = re.sub(r"-->|->|&rarr;|→", " to ", s)

    # Remove emojis and special symbol glyphs
    emoji_pattern = re.compile(
        r"[\U00010000-\U0010ffff"
        r"\u2600-\u26ff"
        r"\u2700-\u27bf"
        r"\u2300-\u23ff"
        r"\u2b50\u200d\ufe0f"
        r"🚍📍🎯⏰💰💺🧳👉✅⚠️🎉💳❌ℹ️]+",
        flags=re.UNICODE,
    )
    s = emoji_pattern.sub("", s)

    # Normalize bullet points and dashes
    s = re.sub(r"^\s*[-•]\s*", "", s, flags=re.MULTILINE)

    # Clean whitespace and repeated newlines
    s = re.sub(r"\n+", ". ", s)
    s = re.sub(r"\s+", " ", s).strip()

    return s


def adapt_booking_text_for_language(text: str, target_lang: str) -> str:
    """
    Adapts standard booking status phrases into conversational Hindi or Urdu
    when user has selected that voice language.
    """
    lang = (target_lang or "en").lower().strip()
    if lang == "en":
        return clean_text_for_speech(text)

    cleaned = clean_text_for_speech(text)
    lower = cleaned.lower()

    if lang == "hi":
        # 1. Missing luggage prompt
        if "travelling to" in lower and "luggage" in lower:
            dest_match = re.search(r"travelling to ([^!.]+)", cleaned, re.IGNORECASE)
            dest = dest_match.group(1).strip() if dest_match else "गंतव्य"
            return f"{dest} के लिए यात्रा! क्या आपके पास कोई सामान या अतिरिक्त बैग हैं? कृपया बैगों की संख्या बताएं, या कहें कि कोई सामान नहीं है।"

        # 2. Destination asking prompt
        if "where would you like to travel" in lower:
            return "नमस्ते! आप कहाँ यात्रा करना चाहते हैं? कृपया अपने गंतव्य और सामान के बारे में बताएं।"

        # 3. Seat hold created & waiting for driver
        if "seat hold" in lower and "created" in lower and "driver" in lower:
            return f"आपकी सीट आरक्षित कर ली गई है। हमने ड्राइवर को आपका अनुरोध भेज दिया है। कृपया ड्राइवर की स्वीकृति की प्रतीक्षा करें।"

        # 4. Driver rejection
        if "unable to accept" in lower or "could not accept" in lower:
            return f"पिछली गाड़ी के ड्राइवर अनुरोध स्वीकार नहीं कर सके। हमें इस रूट पर अगली गाड़ी मिल गई है। क्या आप इसे बुक करना चाहते हैं?"

        # 5. Driver acceptance & confirmed
        if "seat confirmed" in lower or "confirmed by driver" in lower:
            return f"बधाई हो! ड्राइवर ने आपकी सीट कन्फर्म कर दी है। कृपया यात्रा पास डाउनलोड करने के लिए भुगतान पूरा करें।"

    elif lang == "ur":
        # 1. Missing luggage prompt
        if "travelling to" in lower and "luggage" in lower:
            dest_match = re.search(r"travelling to ([^!.]+)", cleaned, re.IGNORECASE)
            dest = dest_match.group(1).strip() if dest_match else "منزل"
            return f"{dest} کے لیے سفر! کیا آپ کے پاس کوئی سامان یا اضافی بیگ ہے؟ برائے مہربانی بیگ کی تعداد بتائیں، یا کہیں کہ کوئی سامان نہیں ہے۔"

        # 2. Destination asking prompt
        if "where would you like to travel" in lower:
            return "السلام علیکم! آپ کہاں کا سفر کرنا چاہتے ہیں؟ برائے مہربانی اپنی منزل اور سامان کے بارے میں بتائیں۔"

        # 3. Seat hold created & waiting for driver
        if "seat hold" in lower and "created" in lower and "driver" in lower:
            return f"آپ کی سیٹ محفوظ کر لی گئی ہے۔ ہم نے ڈرائیور کو آپ کی درخواست بھیج دی ہے۔ برائے مہربانی ڈرائیور کی منظوری کا انتظار کریں۔"

        # 4. Driver rejection
        if "unable to accept" in lower or "could not accept" in lower:
            return f"پچھلی گاڑی کے ڈرائیور درخواست قبول نہیں کر سکے۔ ہمیں اس روٹ پر اگلی گاڑی مل گئی ہے۔ کیا آپ اسے بک کرنا چاہتے ہیں؟"

        # 5. Driver acceptance & confirmed
        if "seat confirmed" in lower or "confirmed by driver" in lower:
            return f"مبارک ہو! ڈرائیور نے آپ کی سیٹ کنفرم کر دی ہے۔ بورڈنگ پاس ڈاؤن لوڈ کرنے کے لیے برائے مہربانی ادائیگی مکمل کریں۔"

    # Default fallback: read cleaned text
    return cleaned


async def generate_speech_audio(text: str, language: str = "en") -> Optional[str]:
    """
    Synthesizes text into MP3 audio via edge-tts.
    Returns base64-encoded MP3 audio string or None on failure.
    """
    if not text or not text.strip():
        return None

    lang = (language or "en").lower().strip()
    voice = VOICE_MAP.get(lang, VOICE_MAP["en"])

    # Adapt and clean text for target language
    speech_text = adapt_booking_text_for_language(text, target_lang=lang)
    if not speech_text:
        speech_text = clean_text_for_speech(text)

    try:
        communicate = edge_tts.Communicate(speech_text, voice)
        audio_chunks = []

        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_chunks.append(chunk["data"])

        if not audio_chunks:
            return None

        raw_audio = b"".join(audio_chunks)
        return base64.b64encode(raw_audio).decode("utf-8")

    except Exception as e:
        logger.warning(f"edge-tts voice synthesis failed for language '{lang}' (voice: {voice}): {e}")
        return None
