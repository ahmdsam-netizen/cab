from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    LARAVEL_API_BASE_URL: str = "http://localhost:8000/api"
    WEBHOOK_SECRET: str = "dreamcabs-agent-secret-key"
    LLM_PROVIDER: str = "openai"  # "openai", "google", or "mock"
    OPENAI_API_KEY: Optional[str] = None
    GEMINI_API_KEY: Optional[str] = None
    OPENAI_MODEL_NAME: str = "gpt-4o-mini"
    
    # Default fallback coordinates (e.g. Srinagar center)
    DEFAULT_LAT: float = 34.0837
    DEFAULT_LNG: float = 74.7973


settings = Settings()
