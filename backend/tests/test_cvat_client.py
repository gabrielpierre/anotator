from app.core.config import Settings
from app.services.cvat_client import CvatClient


def _settings(**overrides: str) -> Settings:
    values = {
        "CVAT_BASE_URL": "http://cvat.test",
        "CVAT_ACCESS_TOKEN": "abc123",
        **overrides,
    }
    return Settings(**values)


def test_cvat_client_uses_token_auth_by_default() -> None:
    client = CvatClient(_settings())

    assert client._headers()["Authorization"] == "Token abc123"


def test_cvat_client_allows_bearer_scheme() -> None:
    client = CvatClient(_settings(CVAT_AUTH_SCHEME="Bearer"))

    assert client._headers()["Authorization"] == "Bearer abc123"


def test_cvat_client_can_skip_auth_for_public_endpoints() -> None:
    client = CvatClient(_settings(CVAT_HOST_HEADER="localhost"))

    assert client._headers(include_auth=False) == {"Host": "localhost"}


def test_cvat_client_rewrites_localhost_download_urls_to_configured_base_url() -> None:
    client = CvatClient(_settings(CVAT_BASE_URL="http://host.docker.internal:8080"))

    assert (
        client._download_url("http://localhost/api/tasks/5/dataset/download?rq_id=abc")
        == "http://host.docker.internal:8080/api/tasks/5/dataset/download?rq_id=abc"
    )
