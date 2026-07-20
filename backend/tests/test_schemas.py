from app.schemas import ReviewDecisionCreate


def test_review_decision_payload_defaults() -> None:
    payload = ReviewDecisionCreate(external_annotation_id="ann-1", decision="accepted")
    assert payload.actor == "local-user"
    assert payload.payload == {}
