import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import FrameWorkflowState, JobRecord, Project, Task, TaskDataMeta
from app.schemas import ImportTaskCreate
from app.services.annotations import FRAME_APPROVED
from app.services.imports import (
    DuplicateImportImagesError,
    _batch_task_name,
    _classification_folder_items,
    _upsert_dataset_import_frame_states,
    _media_file_batches,
    build_import_file_manifest,
    dedupe_classification_folder_upload_files,
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

    batches = _media_file_batches(files, max_upload_bytes=10, max_upload_files=0)

    assert [[filename for filename, _content, _type in batch] for batch in batches] == [
        ["a.jpg", "b.jpg"],
        ["c.jpg"],
    ]


def test_import_batches_split_large_dataset_by_safe_upload_file_count() -> None:
    files = [
        ("c.jpg", b"c", "image/jpeg"),
        ("a.jpg", b"a", "image/jpeg"),
        ("b.jpg", b"b", "image/jpeg"),
    ]

    batches = _media_file_batches(files, max_upload_bytes=0, max_upload_files=2)

    assert [[filename for filename, _content, _type in batch] for batch in batches] == [
        ["a.jpg", "b.jpg"],
        ["c.jpg"],
    ]


def test_import_batch_task_name_keeps_single_task_name() -> None:
    assert _batch_task_name("Lote 23/07/2026", 1, 1) == "Lote 23/07/2026"


def test_ready_dataset_import_marks_frames_approved() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        task = Task(external_id="21", name="Dataset pronto")
        db.add(task)
        db.commit()

        payload = ImportTaskCreate(name="Dataset pronto", annotation_import_target="ready")
        _upsert_dataset_import_frame_states(
            db,
            task,
            [
                {"frame": 0},
                {"frame": 0},
                {"frame": 1},
            ],
            payload,
        )
        db.commit()

        states = {
            state.frame: state
            for state in db.query(FrameWorkflowState).filter(FrameWorkflowState.task_external_id == "21").all()
        }
        assert states[0].status == FRAME_APPROVED
        assert states[0].annotation_count == 2
        assert states[1].status == FRAME_APPROVED
        assert states[1].raw["annotation_import_target"] == "ready"
        assert task.raw["dataset_import"]["annotation_import_target"] == "ready"


def test_classification_folder_items_accept_single_class_batch() -> None:
    items = _classification_folder_items(
        [
            ("train/tulip/a.jpg", b"a", "image/jpeg"),
            ("train/tulip/b.jpg", b"b", "image/jpeg"),
        ]
    )

    assert [item["source_name"] for item in items] == ["tulip", "tulip"]


def test_classification_folder_items_ignore_unlabeled_test_split() -> None:
    assert _classification_folder_items([("test/Image_1.jpg", b"a", "image/jpeg")]) == []


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
        with pytest.raises(DuplicateImportImagesError, match="Lote existente"):
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
        with pytest.raises(DuplicateImportImagesError, match="Lote antigo"):
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


def test_import_allows_same_basename_in_different_upload_folders() -> None:
    session_factory = _session_factory()
    with session_factory() as db:
        payload = ImportTaskCreate(name="Novo lote")
        manifest = build_import_file_manifest(
            [
                ("train/rose/frame.jpg", b"rose", "image/jpeg"),
                ("train/tulip/frame.jpg", b"tulip", "image/jpeg"),
            ]
        )

        validate_import_file_manifest_unique(db, payload, manifest)


def test_classification_upload_skips_same_class_duplicate_content() -> None:
    files = [
        ("train/sunflower/a.jpg", b"same", "image/jpeg"),
        ("train/sunflower/b.jpg", b"same", "image/jpeg"),
        ("train/rose/c.jpg", b"other", "image/jpeg"),
    ]

    filtered, report = dedupe_classification_folder_upload_files(files)

    assert [filename for filename, _content, _type in filtered] == [
        "train/sunflower/a.jpg",
        "train/rose/c.jpg",
    ]
    assert report["skipped_duplicate_count"] == 1
    assert report["skipped_duplicates"][0]["relative_path"] == "train/sunflower/b.jpg"


def test_classification_upload_rejects_duplicate_content_across_classes() -> None:
    files = [
        ("train/rose/a.jpg", b"same", "image/jpeg"),
        ("train/tulip/b.jpg", b"same", "image/jpeg"),
    ]

    with pytest.raises(DuplicateImportImagesError, match="duplica"):
        dedupe_classification_folder_upload_files(files)


def test_classification_upload_can_ignore_duplicate_content_across_classes() -> None:
    files = [
        ("train/rose/a.jpg", b"same", "image/jpeg"),
        ("train/tulip/b.jpg", b"same", "image/jpeg"),
        ("train/daisy/c.jpg", b"other", "image/jpeg"),
    ]

    filtered, report = dedupe_classification_folder_upload_files(files, duplicate_policy="ignore")

    assert [filename for filename, _content, _type in filtered] == [
        "train/rose/a.jpg",
        "train/daisy/c.jpg",
    ]
    assert report["skipped_duplicate_count"] == 1


def test_classification_upload_can_include_duplicate_content_across_classes() -> None:
    files = [
        ("train/rose/a.jpg", b"same", "image/jpeg"),
        ("train/tulip/b.jpg", b"same", "image/jpeg"),
    ]

    filtered, report = dedupe_classification_folder_upload_files(files, duplicate_policy="include")

    assert filtered == files
    assert report["skipped_duplicate_count"] == 0


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
