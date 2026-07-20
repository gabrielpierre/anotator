from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app


def test_health_endpoint() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_internal_api_key_protects_non_exempt_routes(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_API_KEY", "secret-local-key")
    get_settings.cache_clear()

    with TestClient(create_app()) as client:
        assert client.get("/api/v1/health").status_code == 200
        assert client.get("/api/v1/projects").status_code == 401
        assert client.get("/api/v1/projects", headers={"X-API-Key": "secret-local-key"}).status_code == 200
        assert client.get("/api/v1/projects", headers={"Authorization": "Bearer secret-local-key"}).status_code == 200
        assert client.get("/api/v1/projects?api_key=secret-local-key").status_code == 200

    get_settings.cache_clear()
