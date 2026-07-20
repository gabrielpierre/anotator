from fastapi.testclient import TestClient

from app.main import create_app


def test_list_directories_returns_only_child_directories(tmp_path) -> None:
    (tmp_path / "images").mkdir()
    (tmp_path / "labels").mkdir()
    (tmp_path / "readme.txt").write_text("not a directory")

    client = TestClient(create_app())
    response = client.get("/api/v1/system/directories", params={"path": str(tmp_path)})

    assert response.status_code == 200
    data = response.json()
    assert data["path"] == str(tmp_path.resolve())
    assert data["parent"] == str(tmp_path.resolve().parent)
    assert [entry["name"] for entry in data["entries"]] == ["images", "labels"]


def test_list_directories_rejects_missing_path(tmp_path) -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/system/directories", params={"path": str(tmp_path / "missing")})

    assert response.status_code == 404
