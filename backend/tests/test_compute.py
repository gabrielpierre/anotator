from app.services.compute import gpu_snapshot


def test_gpu_snapshot_always_exposes_cpu_as_training_option() -> None:
    snapshot = gpu_snapshot()
    options = snapshot["device_options"]

    assert any(option["id"] == "cpu" and option["available"] for option in options)
