from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import create_app


def test_list_directories_returns_only_child_directories(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SYSTEM_DIRECTORY_HOME", str(tmp_path))
    get_settings.cache_clear()
    (tmp_path / "images").mkdir()
    (tmp_path / "labels").mkdir()
    (tmp_path / "readme.txt").write_text("not a directory")

    client = TestClient(create_app())
    response = client.get("/api/v1/system/directories", params={"path": str(tmp_path)})

    assert response.status_code == 200
    data = response.json()
    assert data["path"] == str(tmp_path.resolve())
    assert data["parent"] is None
    assert [entry["name"] for entry in data["entries"]] == ["images", "labels"]
    get_settings.cache_clear()


def test_list_directories_rejects_missing_path(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SYSTEM_DIRECTORY_HOME", str(tmp_path))
    get_settings.cache_clear()
    client = TestClient(create_app())
    response = client.get("/api/v1/system/directories", params={"path": str(tmp_path / "missing")})

    assert response.status_code == 404
    get_settings.cache_clear()


def test_list_directories_rejects_path_outside_configured_root(tmp_path, monkeypatch) -> None:
    root = tmp_path / "root"
    outside = tmp_path / "outside"
    root.mkdir()
    outside.mkdir()
    monkeypatch.setenv("SYSTEM_DIRECTORY_HOME", str(root))
    get_settings.cache_clear()

    client = TestClient(create_app())
    response = client.get("/api/v1/system/directories", params={"path": str(outside)})

    assert response.status_code == 403
    get_settings.cache_clear()


def test_create_directory_creates_child_and_returns_listing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SYSTEM_DIRECTORY_HOME", str(tmp_path))
    get_settings.cache_clear()

    client = TestClient(create_app())
    response = client.post(
        "/api/v1/system/directories",
        json={"parent_path": str(tmp_path), "name": "novo-projeto"},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["path"] == str((tmp_path / "novo-projeto").resolve())
    assert data["parent"] == str(tmp_path.resolve())
    assert (tmp_path / "novo-projeto").is_dir()
    get_settings.cache_clear()


def test_create_directory_rejects_nested_name(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SYSTEM_DIRECTORY_HOME", str(tmp_path))
    get_settings.cache_clear()

    client = TestClient(create_app())
    response = client.post(
        "/api/v1/system/directories",
        json={"parent_path": str(tmp_path), "name": "../escape"},
    )

    assert response.status_code == 400
    get_settings.cache_clear()
