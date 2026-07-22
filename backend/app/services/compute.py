import os
import subprocess
from typing import Any


def cpu_device() -> dict[str, Any]:
    cpu_count = os.cpu_count() or 1
    return {
        "id": "cpu",
        "type": "cpu",
        "name": f"CPU ({cpu_count} cores)",
        "label": f"CPU ({cpu_count} cores)",
        "available": True,
    }


def gpu_snapshot() -> dict[str, Any]:
    torch_snapshot = _torch_cuda_snapshot()
    cuda_devices = torch_snapshot.get("devices") if isinstance(torch_snapshot.get("devices"), list) else []
    detected_devices = _merge_detected_devices(_host_nvidia_devices_from_env(), _nvidia_smi_devices())
    device_options = [*cuda_devices, cpu_device()] if cuda_devices else [cpu_device()]
    primary = _primary_device(cuda_devices, detected_devices)
    return {
        "available": bool(cuda_devices),
        "provider": "cuda" if cuda_devices else None,
        "devices": cuda_devices,
        "device_options": device_options,
        "detected_devices": detected_devices,
        "host_detected": bool(detected_devices),
        "docker_gpu_enabled": os.getenv("ANOTATOR_DOCKER_GPU_ENABLED", "").lower() == "true",
        "utilization_percent": primary.get("utilization_percent") if primary else None,
        "memory_total_bytes": primary.get("memory_total_bytes") if primary else None,
        "memory_used_bytes": primary.get("memory_used_bytes") if primary else None,
        **torch_snapshot,
    }


def available_training_devices() -> list[dict[str, Any]]:
    return gpu_snapshot()["device_options"]


def available_training_device_ids() -> set[str]:
    return {str(device["id"]) for device in available_training_devices() if device.get("available")}


def _torch_cuda_snapshot() -> dict[str, Any]:
    try:
        import torch
    except Exception as exc:
        return {
            "cuda_available": False,
            "cuda_device_count": 0,
            "torch_error": str(exc),
        }

    snapshot: dict[str, Any] = {
        "torch_version": getattr(torch, "__version__", None),
        "torch_cuda_version": getattr(getattr(torch, "version", None), "cuda", None),
    }
    try:
        cuda_available = bool(torch.cuda.is_available())
        cuda_device_count = int(torch.cuda.device_count())
    except Exception as exc:
        return {
            **snapshot,
            "cuda_available": False,
            "cuda_device_count": 0,
            "torch_error": str(exc),
        }

    devices: list[dict[str, Any]] = []
    if cuda_available:
        for index in range(cuda_device_count):
            try:
                properties = torch.cuda.get_device_properties(index)
                memory_total = int(getattr(properties, "total_memory", 0) or 0)
            except Exception:
                properties = None
                memory_total = 0
            try:
                name = torch.cuda.get_device_name(index)
            except Exception:
                name = f"CUDA GPU {index}"
            devices.append(
                {
                    "id": str(index),
                    "type": "cuda",
                    "index": index,
                    "name": name,
                    "label": f"GPU {index} - {name}",
                    "memory_total_bytes": memory_total or None,
                    "available": True,
                    "provider": "cuda",
                }
            )

    return {
        **snapshot,
        "cuda_available": cuda_available,
        "cuda_device_count": cuda_device_count,
        "devices": devices,
    }


def _nvidia_smi_devices() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,name,utilization.gpu,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:
        return []

    devices: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            continue
        utilization = _int_or_none(parts[2]) if len(parts) > 2 else None
        memory_mb = _int_or_none(parts[3]) if len(parts) > 3 else None
        memory_used_mb = _int_or_none(parts[4]) if len(parts) > 4 else None
        devices.append(
            {
                "id": parts[0],
                "type": "cuda",
                "index": _int_or_none(parts[0]),
                "name": parts[1],
                "label": f"GPU {parts[0]} - {parts[1]}",
                "memory_total_bytes": memory_mb * 1024 * 1024 if memory_mb is not None else None,
                "memory_used_bytes": memory_used_mb * 1024 * 1024 if memory_used_mb is not None else None,
                "utilization_percent": utilization,
                "available": False,
                "provider": "nvidia-smi",
                "unavailable_reason": None,
            }
        )
    return devices


def _host_nvidia_devices_from_env() -> list[dict[str, Any]]:
    raw = os.getenv("HOST_NVIDIA_GPUS", "").strip()
    if not raw:
        return []
    devices: list[dict[str, Any]] = []
    for entry in raw.split(";"):
        parts = [part.strip() for part in entry.split("|")]
        if len(parts) < 2:
            continue
        memory_mb = _int_or_none(parts[2]) if len(parts) > 2 else None
        devices.append(
            {
                "id": parts[0],
                "type": "cuda",
                "index": _int_or_none(parts[0]),
                "name": parts[1],
                "label": f"GPU {parts[0]} - {parts[1]}",
                "memory_total_bytes": memory_mb * 1024 * 1024 if memory_mb is not None else None,
                "available": False,
                "provider": "host-nvidia-smi",
                "unavailable_reason": _host_gpu_unavailable_reason(),
            }
        )
    return devices


def _host_gpu_unavailable_reason() -> str:
    if os.getenv("ANOTATOR_DOCKER_GPU_ENABLED", "").lower() == "true":
        return "GPU detectada no host, mas CUDA indisponivel no backend"
    return "Docker sem acesso a GPU NVIDIA"


def _merge_detected_devices(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for group in groups:
        for device in group:
            key = str(device.get("id") or device.get("index") or device.get("name"))
            updated = {**merged.get(key, {}), **device}
            if updated.get("unavailable_reason") is None:
                updated.pop("unavailable_reason", None)
            merged[key] = updated
    return list(merged.values())


def _primary_device(cuda_devices: list[dict[str, Any]], detected_devices: list[dict[str, Any]]) -> dict[str, Any] | None:
    if detected_devices:
        return detected_devices[0]
    if cuda_devices:
        return cuda_devices[0]
    return None


def _int_or_none(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
