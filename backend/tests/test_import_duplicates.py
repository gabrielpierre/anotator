import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import JobRecord, Project, Task, TaskDataMeta
from app.schemas import ImportTaskCreate
from app.services.imports import (
    DuplicateImportImagesError,
    _batch_task_name,
    _media_file_batches,
    build_import_file_manifest,
    validate_import_file_manifest_unique,
)


def _session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _manifest(filename: str, content: bytes = b"image") -> list[dict]:
    return build_import_file_manifest([(filename, content, "image/jpeg")])


def test_import_batches_split_large_dataset_by_safe_upload_size() -> None:
    files = [
        ("b.jpg", b"b" * 5, "image/jpeg"),
        ("a.jpg", b"a" * 5, "image/jpeg"),
        ("c.jpg", b"c" * 4, "image/jpeg"),
    ]

    batches = _media_file_batches(files, max_upload_bytes=10)

    assert [[filename for filename, _content, _type in batch] for batch in batches] == [
        ["a.jpg", "b.jpg"],
        ["c.jpg"],
    ]


def test_import_batch_task_name_keeps_single_task_name() -> None:
    assert _batch_task_name("Lote 23/07/2026", 1, 1) == "Lote 23/07/2026"


def test_import_rejects_same_image_content_in_existing_project_task() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        project = Project(external_id="5", name="Projeto")
        db.add(project)
        db.flush()
        db.add(
            Task(
                external_id="21",
                project_external_id="5",
                name="Lote existente",
                raw={"local_import_manifest": {"files": _manifest("torre.jpg", b"same")}},
            )
        )
        db.commit()

        payload = ImportTaskCreate(project_id=project.id, name="Novo lote")
        with pytest.raises(DuplicateImportImagesError, match="mesmo conteudo em Lote existente"):
            validate_import_file_manifest_unique(db, payload, _manifest("renomeada.jpg", b"same"))


def test_import_rejects_same_filename_from_legacy_task_metadata() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        project = Project(external_id="5", name="Projeto")
        db.add(project)
        db.add(Task(external_id="21", project_external_id="5", name="Lote antigo"))
        db.add(
            TaskDataMeta(task_external_id="21", frame_count=1, frames=[{"name": "camera_01.png"}])
        )
        db.commit()

        payload = ImportTaskCreate(project_id=project.id, name="Novo lote")
        with pytest.raises(DuplicateImportImagesError, match="mesmo nome em Lote antigo"):
            validate_import_file_manifest_unique(db, payload, _manifest("CAMERA_01.png", b"other"))


def test_import_allows_same_image_in_different_project() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        project_a = Project(external_id="5", name="Projeto A")
        project_b = Project(external_id="6", name="Projeto B")
        db.add_all([project_a, project_b])
        db.flush()
        db.add(
            Task(
                external_id="21",
                project_external_id="5",
                name="Lote A",
                raw={"local_import_manifest": {"files": _manifest("torre.jpg", b"same")}},
            )
        )
        db.commit()

        payload = ImportTaskCreate(project_id=project_b.id, name="Novo lote")
        validate_import_file_manifest_unique(db, payload, _manifest("torre.jpg", b"same"))


def test_import_allows_same_filename_when_existing_hash_is_different() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        project = Project(external_id="5", name="Projeto")
        db.add(project)
        db.flush()
        db.add(
            Task(
                external_id="21",
                project_external_id="5",
                name="Lote existente",
                raw={"local_import_manifest": {"files": _manifest("frame.jpg", b"first")}},
            )
        )
        db.commit()

        payload = ImportTaskCreate(project_id=project.id, name="Novo lote")
        validate_import_file_manifest_unique(db, payload, _manifest("frame.jpg", b"second"))


def test_import_rejects_duplicate_against_active_import_job() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        project = Project(external_id="5", name="Projeto")
        db.add(project)
        db.flush()
        db.add(
            JobRecord(
                kind="import",
                status="running",
                progress=5,
                name="Import CVAT task Lote em andamento",
                raw={
                    "payload": ImportTaskCreate(
                        project_id=project.id, name="Lote em andamento"
                    ).model_dump(mode="json"),
                    "upload_artifacts": _manifest("torre.jpg", b"same"),
                },
            )
        )
        db.commit()

        payload = ImportTaskCreate(project_id=project.id, name="Novo lote")
        with pytest.raises(DuplicateImportImagesError, match="Lote em andamento"):
            validate_import_file_manifest_unique(db, payload, _manifest("renomeada.jpg", b"same"))
