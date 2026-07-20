"""clean declarative baseline

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-07-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        _id(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("avatar_url", sa.Text(), nullable=True),
        sa.Column("password_hash", sa.Text(), nullable=False),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_role", "users", ["role"])
    op.create_index("ix_users_status", "users", ["status"])

    op.create_table(
        "user_sessions",
        _id(),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("token_hash", sa.String(length=128), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_token_hash", "user_sessions", ["token_hash"], unique=True)
    op.create_index("ix_user_sessions_expires_at", "user_sessions", ["expires_at"])

    op.create_table(
        "projects",
        _id(),
        sa.Column("external_id", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_projects_external_id", "projects", ["external_id"], unique=True)
    op.create_index("ix_projects_name", "projects", ["name"])

    op.create_table(
        "project_members",
        _id(),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "user_id", name="uq_project_members_project_user"),
    )
    op.create_index("ix_project_members_project_id", "project_members", ["project_id"])
    op.create_index("ix_project_members_user_id", "project_members", ["user_id"])
    op.create_index("ix_project_members_role", "project_members", ["role"])

    op.create_table(
        "tasks",
        _id(),
        sa.Column("external_id", sa.String(length=64), nullable=False),
        sa.Column("project_external_id", sa.String(length=64), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        _json("labels", list),
        sa.Column("preview_url", sa.Text(), nullable=True),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tasks_external_id", "tasks", ["external_id"], unique=True)
    op.create_index("ix_tasks_project_external_id", "tasks", ["project_external_id"])
    op.create_index("ix_tasks_name", "tasks", ["name"])

    op.create_table(
        "cvat_labels",
        _id(),
        sa.Column("external_id", sa.String(length=128), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("color", sa.String(length=64), nullable=True),
        sa.Column("project_external_id", sa.String(length=64), nullable=True),
        sa.Column("task_external_id", sa.String(length=64), nullable=True),
        _json("attributes", list),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cvat_labels_external_id", "cvat_labels", ["external_id"], unique=True)
    op.create_index("ix_cvat_labels_name", "cvat_labels", ["name"])
    op.create_index("ix_cvat_labels_project_external_id", "cvat_labels", ["project_external_id"])
    op.create_index("ix_cvat_labels_task_external_id", "cvat_labels", ["task_external_id"])

    op.create_table(
        "task_data_meta",
        _id(),
        sa.Column("task_external_id", sa.String(length=64), nullable=False),
        sa.Column("frame_count", sa.Integer(), nullable=False),
        sa.Column("chunk_size", sa.Integer(), nullable=True),
        sa.Column("start_frame", sa.Integer(), nullable=True),
        sa.Column("stop_frame", sa.Integer(), nullable=True),
        sa.Column("frame_filter", sa.String(length=255), nullable=True),
        _json("frames", list),
        _json("deleted_frames", list),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_data_meta_task_external_id", "task_data_meta", ["task_external_id"], unique=True)

    op.create_table(
        "task_previews",
        _id(),
        sa.Column("task_external_id", sa.String(length=64), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_task_previews_task_external_id", "task_previews", ["task_external_id"], unique=True)

    op.create_table(
        "annotation_records",
        _id(),
        sa.Column("external_id", sa.String(length=160), nullable=False),
        sa.Column("cvat_job_id", sa.String(length=64), nullable=False),
        sa.Column("task_external_id", sa.String(length=64), nullable=True),
        sa.Column("annotation_type", sa.String(length=32), nullable=False),
        sa.Column("cvat_annotation_id", sa.String(length=64), nullable=False),
        sa.Column("frame", sa.Integer(), nullable=True),
        sa.Column("label_id", sa.Integer(), nullable=True),
        sa.Column("label_name", sa.String(length=255), nullable=True),
        sa.Column("shape_type", sa.String(length=64), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        _json("points", list),
        sa.Column("review_state", sa.String(length=32), nullable=False),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_annotation_records_external_id", "annotation_records", ["external_id"], unique=True)
    op.create_index("ix_annotation_records_cvat_job_id", "annotation_records", ["cvat_job_id"])
    op.create_index("ix_annotation_records_task_external_id", "annotation_records", ["task_external_id"])
    op.create_index("ix_annotation_records_annotation_type", "annotation_records", ["annotation_type"])
    op.create_index("ix_annotation_records_cvat_annotation_id", "annotation_records", ["cvat_annotation_id"])
    op.create_index("ix_annotation_records_frame", "annotation_records", ["frame"])
    op.create_index("ix_annotation_records_label_id", "annotation_records", ["label_id"])
    op.create_index("ix_annotation_records_label_name", "annotation_records", ["label_name"])
    op.create_index("ix_annotation_records_review_state", "annotation_records", ["review_state"])

    op.create_table(
        "inference_suggestions",
        _id(),
        sa.Column("external_id", sa.String(length=180), nullable=False),
        sa.Column("task_external_id", sa.String(length=64), nullable=False),
        sa.Column("cvat_job_id", sa.String(length=64), nullable=True),
        sa.Column("frame", sa.Integer(), nullable=False),
        sa.Column("model_id", sa.String(length=128), nullable=False),
        sa.Column("model_version", sa.String(length=128), nullable=False),
        sa.Column("model_family", sa.String(length=64), nullable=False),
        sa.Column("label_id", sa.Integer(), nullable=True),
        sa.Column("label_name", sa.String(length=255), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column("nms_iou", sa.Float(), nullable=True),
        sa.Column("shape_type", sa.String(length=64), nullable=False),
        _json("points", list),
        sa.Column("status", sa.String(length=32), nullable=False),
        _json("origin"),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("external_id", name="uq_inference_suggestions_external_id"),
    )
    _indexes(
        "inference_suggestions",
        [
            "external_id",
            "task_external_id",
            "cvat_job_id",
            "frame",
            "model_id",
            "model_version",
            "model_family",
            "label_id",
            "label_name",
            "status",
        ],
        unique={"external_id"},
    )

    _revision_table("annotation_revisions", "annotation_external_id")
    _revision_table("track_revisions", "track_external_id")

    op.create_table(
        "job_records",
        _id(),
        sa.Column("external_id", sa.String(length=128), nullable=True),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("task_external_id", sa.String(length=64), nullable=True),
        _json("resource_metrics"),
        _json("raw"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_job_records_external_id", "job_records", ["external_id"], unique=True)
    op.create_index("ix_job_records_kind", "job_records", ["kind"])
    op.create_index("ix_job_records_status", "job_records", ["status"])
    op.create_index("ix_job_records_task_external_id", "job_records", ["task_external_id"])

    op.create_table(
        "review_decisions",
        _id(),
        sa.Column("cvat_job_id", sa.String(length=64), nullable=True),
        sa.Column("external_annotation_id", sa.String(length=128), nullable=False),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("corrected_label", sa.String(length=255), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("actor", sa.String(length=255), nullable=False),
        _json("payload"),
        sa.Column("cvat_synced", sa.Boolean(), nullable=False),
        sa.Column("cvat_error", sa.Text(), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_review_decisions_cvat_job_id", "review_decisions", ["cvat_job_id"])
    op.create_index("ix_review_decisions_external_annotation_id", "review_decisions", ["external_annotation_id"])
    op.create_index("ix_review_decisions_decision", "review_decisions", ["decision"])

    op.create_table(
        "dataset_releases",
        _id(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=True),
        _json("task_external_ids", list),
        _json("snapshot"),
        sa.Column("artifact_uri", sa.Text(), nullable=True),
        sa.Column("immutable", sa.Boolean(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_dataset_releases_name"),
    )
    op.create_index("ix_dataset_releases_name", "dataset_releases", ["name"])
    op.create_index("ix_dataset_releases_status", "dataset_releases", ["status"])
    op.create_index("ix_dataset_releases_project_id", "dataset_releases", ["project_id"])

    op.create_table(
        "training_runs",
        _id(),
        sa.Column("dataset_release_id", sa.String(length=36), nullable=False),
        sa.Column("model_family", sa.String(length=64), nullable=False),
        sa.Column("base_model", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        sa.Column("mlflow_run_id", sa.String(length=255), nullable=True),
        _json("config"),
        _json("metrics"),
        _json("artifacts", list),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_training_runs_dataset_release_id", "training_runs", ["dataset_release_id"])
    op.create_index("ix_training_runs_status", "training_runs", ["status"])

    op.create_table(
        "model_versions",
        _id(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=128), nullable=False),
        sa.Column("family", sa.String(length=64), nullable=False),
        sa.Column("base_model", sa.String(length=255), nullable=False),
        sa.Column("training_run_id", sa.String(length=36), nullable=True),
        sa.Column("dataset_release_id", sa.String(length=36), nullable=True),
        sa.Column("mlflow_run_id", sa.String(length=255), nullable=True),
        sa.Column("artifact_uri", sa.Text(), nullable=True),
        _json("metrics"),
        _json("params"),
        sa.Column("status", sa.String(length=32), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "version", name="uq_model_versions_name_version"),
    )
    op.create_index("ix_model_versions_name", "model_versions", ["name"])
    op.create_index("ix_model_versions_version", "model_versions", ["version"])
    op.create_index("ix_model_versions_family", "model_versions", ["family"])
    op.create_index("ix_model_versions_training_run_id", "model_versions", ["training_run_id"])
    op.create_index("ix_model_versions_dataset_release_id", "model_versions", ["dataset_release_id"])
    op.create_index("ix_model_versions_status", "model_versions", ["status"])

    op.create_table(
        "pipeline_definitions",
        _id(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("version", sa.String(length=128), nullable=False),
        _json("graph"),
        _json("config"),
        sa.Column("status", sa.String(length=32), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", "version", name="uq_pipeline_definitions_name_version"),
    )
    op.create_index("ix_pipeline_definitions_name", "pipeline_definitions", ["name"])
    op.create_index("ix_pipeline_definitions_version", "pipeline_definitions", ["version"])
    op.create_index("ix_pipeline_definitions_status", "pipeline_definitions", ["status"])

    op.create_table(
        "pipeline_runs",
        _id(),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("progress", sa.Float(), nullable=False),
        _json("definition"),
        _json("lineage"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_pipeline_runs_status", "pipeline_runs", ["status"])

    op.create_table(
        "derived_assets",
        _id(),
        sa.Column("external_id", sa.String(length=220), nullable=False),
        sa.Column("pipeline_run_id", sa.String(length=36), nullable=False),
        sa.Column("dataset_release_id", sa.String(length=36), nullable=True),
        sa.Column("source_task_external_id", sa.String(length=64), nullable=True),
        sa.Column("source_annotation_id", sa.String(length=160), nullable=True),
        sa.Column("source_track_id", sa.String(length=160), nullable=True),
        sa.Column("frame", sa.Integer(), nullable=True),
        sa.Column("label_id", sa.Integer(), nullable=True),
        sa.Column("label_name", sa.String(length=255), nullable=True),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("crop_uri", sa.Text(), nullable=True),
        sa.Column("preview_url", sa.Text(), nullable=True),
        _json("bbox"),
        _json("padding"),
        sa.Column("model_id", sa.String(length=128), nullable=True),
        sa.Column("model_version", sa.String(length=128), nullable=True),
        sa.Column("score", sa.Float(), nullable=True),
        _json("human_corrections"),
        _json("lineage"),
        sa.Column("status", sa.String(length=32), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("external_id", name="uq_derived_assets_external_id"),
    )
    _indexes(
        "derived_assets",
        [
            "external_id",
            "pipeline_run_id",
            "dataset_release_id",
            "source_task_external_id",
            "source_annotation_id",
            "source_track_id",
            "frame",
            "label_id",
            "label_name",
            "split",
            "model_id",
            "model_version",
            "status",
        ],
        unique={"external_id"},
    )

    op.create_table(
        "artifact_records",
        _id(),
        sa.Column("uri", sa.Text(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("owner_type", sa.String(length=64), nullable=True),
        sa.Column("owner_id", sa.String(length=128), nullable=True),
        _json("raw"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("uri", name="uq_artifact_records_uri"),
    )
    op.create_index("ix_artifact_records_name", "artifact_records", ["name"])
    op.create_index("ix_artifact_records_kind", "artifact_records", ["kind"])
    op.create_index("ix_artifact_records_owner_type", "artifact_records", ["owner_type"])
    op.create_index("ix_artifact_records_owner_id", "artifact_records", ["owner_id"])

    op.create_table(
        "audit_events",
        _id(),
        sa.Column("actor", sa.String(length=255), nullable=False),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("target", sa.String(length=255), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        _json("payload"),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_events_action", "audit_events", ["action"])


def downgrade() -> None:
    for table_name in (
        "audit_events",
        "artifact_records",
        "derived_assets",
        "pipeline_runs",
        "pipeline_definitions",
        "model_versions",
        "training_runs",
        "dataset_releases",
        "review_decisions",
        "job_records",
        "track_revisions",
        "annotation_revisions",
        "inference_suggestions",
        "annotation_records",
        "task_previews",
        "task_data_meta",
        "cvat_labels",
        "tasks",
        "project_members",
        "projects",
        "user_sessions",
        "users",
    ):
        op.drop_table(table_name)


def _id() -> sa.Column:
    return sa.Column("id", sa.String(length=36), nullable=False)


def _timestamps() -> tuple[sa.Column, sa.Column]:
    return (
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def _json(name: str, _default_type=dict) -> sa.Column:
    return sa.Column(name, sa.JSON(), nullable=False)


def _revision_table(table_name: str, external_column: str) -> None:
    op.create_table(
        table_name,
        _id(),
        sa.Column(external_column, sa.String(length=160), nullable=False),
        sa.Column("cvat_job_id", sa.String(length=64), nullable=True),
        sa.Column("decision", sa.String(length=32), nullable=False),
        sa.Column("action", sa.String(length=32), nullable=False),
        _json("before"),
        _json("after"),
        sa.Column("actor", sa.String(length=255), nullable=False),
        sa.Column("cvat_synced", sa.Boolean(), nullable=False),
        sa.Column("cvat_error", sa.Text(), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(f"ix_{table_name}_{external_column}", table_name, [external_column])
    op.create_index(f"ix_{table_name}_cvat_job_id", table_name, ["cvat_job_id"])
    op.create_index(f"ix_{table_name}_decision", table_name, ["decision"])
    op.create_index(f"ix_{table_name}_action", table_name, ["action"])


def _indexes(table_name: str, columns: list[str], *, unique: set[str] | None = None) -> None:
    unique = unique or set()
    for column in columns:
        op.create_index(f"ix_{table_name}_{column}", table_name, [column], unique=column in unique)
