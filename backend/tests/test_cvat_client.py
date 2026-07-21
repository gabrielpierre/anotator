from app.core.config import Settings
from app.services.cvat_client import CvatClient


def _settings(**overrides: str) -> Settings:
    return Settings(
        CVAT_BASE_URL="http://cvat.test",
        CVAT_ACCESS_TOKEN="abc123",
        **overrides,
    )


def test_cvat_client_uses_bearer_auth_by_default() -> None:
    client = CvatClient(_settings())

    assert client._headers()["Authorization"] == "Bearer abc123"


def test_cvat_client_allows_legacy_token_scheme() -> None:
    client = CvatClient(_settings(CVAT_AUTH_SCHEME="Token"))

    assert client._headers()["Authorization"] == "Token abc123"


def test_cvat_client_can_skip_auth_for_public_endpoints() -> None:
    client = CvatClient(_settings(CVAT_HOST_HEADER="localhost"))

    assert client._headers(include_auth=False) == {"Host": "localhost"}
