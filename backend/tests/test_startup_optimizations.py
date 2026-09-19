import pytest
import asyncio
import time
from fastapi.testclient import TestClient
from app.main import app, _app_state, _ReadinessState, _mark_ready, _mark_failed

@pytest.fixture
def unready_app():
    # Force app into INITIALIZING state
    original_state = _app_state
    app.state_backup = original_state
    
    import app.main as main_module
    main_module._app_state = _ReadinessState.INITIALIZING
    
    yield app
    
    # Restore
    main_module._app_state = original_state

def test_healthz_initializing(unready_app):
    client = TestClient(unready_app)
    response = client.get("/healthz")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "initializing"
    assert data["database"] == "connecting"

def test_root_always_responds(unready_app):
    client = TestClient(unready_app)
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["ready"] is False

def test_api_returns_503_while_initializing(unready_app):
    client = TestClient(unready_app)
    response = client.get("/api/me") # Or any /api/ endpoint
    assert response.status_code == 503
    assert response.json()["code"] == "SERVER_INITIALIZING"
    assert "Retry-After" in response.headers

def test_api_returns_503_on_failure(unready_app):
    import app.main as main_module
    main_module._mark_failed("Test failure")
    
    client = TestClient(unready_app)
    response = client.get("/api/me")
    assert response.status_code == 503
    assert response.json()["code"] == "SERVER_INIT_FAILED"

def test_healthz_on_failure(unready_app):
    import app.main as main_module
    main_module._mark_failed("Test DB failure")
    
    client = TestClient(unready_app)
    response = client.get("/healthz")
    assert response.status_code == 503
    data = response.json()
    assert data["status"] == "unhealthy"
    assert data["database"] == "init_failed"

def test_options_always_passes(unready_app):
    client = TestClient(unready_app)
    response = client.options("/api/me", headers={
        "Origin": "http://localhost:3000",
        "Access-Control-Request-Method": "GET"
    })
    assert response.status_code == 200
    assert "access-control-allow-origin" in response.headers
