from app.services.artifacts import artifact_id_for_uri, uri_for_artifact_id


def test_artifact_id_roundtrip_hides_raw_s3_uri() -> None:
    uri = "s3://anotator-artifacts/dataset-releases/release/task.zip"
    artifact_id = artifact_id_for_uri(uri)

    assert artifact_id != uri
    assert "s3://" not in artifact_id
    assert uri_for_artifact_id(artifact_id) == uri
