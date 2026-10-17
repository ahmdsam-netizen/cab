import pytest
from tools.api_client import LaravelApiClient


def test_api_client_headers():
    client = LaravelApiClient(base_url="http://test.api")
    headers_no_token = client._headers()
    assert headers_no_token["Accept"] == "application/json"
    assert "Authorization" not in headers_no_token

    headers_with_token = client._headers("sample_bearer_token")
    assert headers_with_token["Authorization"] == "Bearer sample_bearer_token"


def test_api_client_url_formatting():
    client = LaravelApiClient(base_url="http://localhost:8000/api/")
    assert client.base_url == "http://localhost:8000/api"
