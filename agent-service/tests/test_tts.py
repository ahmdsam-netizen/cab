import pytest
from fastapi.testclient import TestClient
from api.main import app
from tools.tts import clean_text_for_speech, adapt_booking_text_for_language, generate_speech_audio

client = TestClient(app)


def test_clean_text_for_speech():
    raw_markdown = "🚍 **Route Match**: Srinagar - Sopore Express\n💰 **Fare**: ₹180 per seat\n👉 Reply **Confirm**"
    cleaned = clean_text_for_speech(raw_markdown)

    # Check markdown artifacts and emojis are removed
    assert "**" not in cleaned
    assert "🚍" not in cleaned
    assert "👉" not in cleaned
    # Check currency is converted to readable words
    assert "180 rupees" in cleaned


def test_language_adaptation_hindi_and_urdu():
    english_prompt = "Where would you like to travel to?"

    hindi_text = adapt_booking_text_for_language(english_prompt, "hi")
    assert "नमस्ते" in hindi_text or "यात्रा" in hindi_text

    urdu_text = adapt_booking_text_for_language(english_prompt, "ur")
    assert "السلام" in urdu_text or "سفر" in urdu_text


@pytest.mark.asyncio
async def test_generate_speech_audio_multilingual():
    # 1. English
    en_audio = await generate_speech_audio("Your cab to Sopore is confirmed", language="en")
    assert en_audio is not None
    assert len(en_audio) > 100

    # 2. Hindi
    hi_audio = await generate_speech_audio("सोपोर के लिए आपकी कैब कन्फर्म हो गई है", language="hi")
    assert hi_audio is not None
    assert len(hi_audio) > 100

    # 3. Urdu
    ur_audio = await generate_speech_audio("سوپور کے لیے آپ کی کیب کنفرم ہو گئی ہے", language="ur")
    assert ur_audio is not None
    assert len(ur_audio) > 100


def test_api_chat_with_voice_mode_english():
    resp = client.post(
        "/chat",
        json={
            "message": "I need to book a cab to Sopore with 2 bags",
            "thread_id": "test-voice-en-user",
            "voice_mode": True,
            "preferred_language": "en",
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["reply"] is not None
    # Voice mode enabled -> must return audio_base64
    assert data["audio_base64"] is not None
    assert len(data["audio_base64"]) > 500
    assert data["audio_format"] == "mp3"
    assert data["audio_language"] == "en"


def test_api_chat_with_voice_mode_urdu():
    resp = client.post(
        "/chat",
        json={
            "message": "To Sopore with 2 bags",
            "thread_id": "test-voice-ur-user",
            "voice_mode": True,
            "preferred_language": "ur",
            "user_current_lat": 34.0718,
            "user_current_lng": 74.7925,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["reply"] is not None
    assert data["audio_base64"] is not None
    assert len(data["audio_base64"]) > 500
    assert data["audio_language"] == "ur"
