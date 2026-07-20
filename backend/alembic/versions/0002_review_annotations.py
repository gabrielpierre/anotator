"""review annotations

Revision ID: 0002_review_annotations
Revises: 0001_initial_schema
Create Date: 2026-07-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0002_review_annotations"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "annotation_records",
        sa.Column("id", sa.String(length=36), nullable=False),
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
        sa.Column("points", sa.JSON(), nullable=False),
        sa.Column("review_state", sa.String(length=32), nullable=False),
        sa.Column("raw", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
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

    for table_name, external_column in (
        ("annotation_revisions", "annotation_external_id"),
        ("track_revisions", "track_external_id"),
    ):
        op.create_table(
            table_name,
            sa.Column("id", sa.String(length=36), nullable=False),
            sa.Column(external_column, sa.String(length=160), nullable=False),
            sa.Column("cvat_job_id", sa.String(length=64), nullable=True),
            sa.Column("decision", sa.String(length=32), nullable=False),
            sa.Column("action", sa.String(length=32), nullable=False),
            sa.Column("before", sa.JSON(), nullable=False),
            sa.Column("after", sa.JSON(), nullable=False),
            sa.Column("actor", sa.String(length=255), nullable=False),
            sa.Column("cvat_synced", sa.Boolean(), nullable=False),
            sa.Column("cvat_error", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index(f"ix_{table_name}_{external_column}", table_name, [external_column])
        op.create_index(f"ix_{table_name}_cvat_job_id", table_name, ["cvat_job_id"])
        op.create_index(f"ix_{table_name}_decision", table_name, ["decision"])
        op.create_index(f"ix_{table_name}_action", table_name, ["action"])

    op.add_column("review_decisions", sa.Column("cvat_synced", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("review_decisions", sa.Column("cvat_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("review_decisions", "cvat_error")
    op.drop_column("review_decisions", "cvat_synced")
    op.drop_table("track_revisions")
    op.drop_table("annotation_revisions")
    op.drop_table("annotation_records")
