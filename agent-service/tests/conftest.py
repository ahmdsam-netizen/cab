import pytest
from config import settings

@pytest.fixture(autouse=True)
def mock_llm_for_tests():
    original_provider = settings.LLM_PROVIDER
    settings.LLM_PROVIDER = "mock"
    yield
    settings.LLM_PROVIDER = original_provider
