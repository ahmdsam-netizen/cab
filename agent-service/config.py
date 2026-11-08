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
    GUARDRAIL_MODEL_NAME: str = "gpt-4o-mini"
    GUARDRAIL_TIMEOUT_SEC: float = 3.0
    
    # Rate limiting defaults (can be modified dynamically via Admin API)
    RATE_LIMIT_ENABLED: bool = True
    DEFAULT_MAX_CONVERSATIONS_PER_DAY: int = 5
    DEFAULT_MAX_REQUESTS_PER_DAY: int = 100
    DEFAULT_MAX_REQUESTS_PER_MINUTE: int = 25
    ADMIN_API_KEY: str = "dreamcabs-admin-secret-key"

    # Default fallback coordinates (e.g. Srinagar center)
    DEFAULT_LAT: float = 34.0837
    DEFAULT_LNG: float = 74.7973


settings = Settings()
