from typing import Any, NamedTuple

import httpx

from app.core.config import Settings


class CvatClientError(RuntimeError):
    pass


class CvatBinaryResponse(NamedTuple):
    content: bytes
    content_type: str | None


class CvatClient:
    def __init__(self, settings: Settings):
        self.base_url = settings.cvat_base_url.rstrip("/")
        self.token = settings.cvat_access_token
        self.timeout = settings.cvat_request_timeout_seconds

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    @property
    def authenticated(self) -> bool:
        return bool(self.token)

    def _headers(self) -> dict[str, str]:
        if not self.token:
            return {}
        return {"Authorization": f"Token {self.token}"}

    def get_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url}{path}"
        try:
            response = httpx.get(url, headers=self._headers(), params=params, timeout=self.timeout)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(str(exc)) from exc

    def post_json(
        self,
        path: str,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json", **self._headers()}
        try:
            response = httpx.post(
                url,
                headers=headers,
                params=params,
                json=payload or {},
                timeout=self.timeout,
            )
            response.raise_for_status()
            if not response.content:
                return None
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(str(exc)) from exc

    def patch_json(
        self,
        path: str,
        payload: dict[str, Any],
        params: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {"Content-Type": "application/json", **self._headers()}
        try:
            response = httpx.patch(
                url,
                headers=headers,
                params=params,
                json=payload,
                timeout=self.timeout,
            )
            response.raise_for_status()
            if not response.content:
                return None
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(str(exc)) from exc

    def get_bytes(self, path: str, params: dict[str, Any] | None = None) -> CvatBinaryResponse:
        url = f"{self.base_url}{path}"
        try:
            response = httpx.get(url, headers=self._headers(), params=params, timeout=self.timeout)
            response.raise_for_status()
            return CvatBinaryResponse(
                content=response.content,
                content_type=response.headers.get("content-type"),
            )
        except httpx.HTTPError as exc:
            raise CvatClientError(str(exc)) from exc

    def get_url_bytes(self, url_or_path: str) -> CvatBinaryResponse:
        url = url_or_path if url_or_path.startswith("http") else f"{self.base_url}{url_or_path}"
        try:
            response = httpx.get(url, headers=self._headers(), timeout=self.timeout)
            response.raise_for_status()
            return CvatBinaryResponse(
                content=response.content,
                content_type=response.headers.get("content-type"),
            )
        except httpx.HTTPError as exc:
            raise CvatClientError(str(exc)) from exc

    def server_about(self) -> dict[str, Any]:
        return self.get_json("/api/server/about")

    def list_projects(self) -> list[dict[str, Any]]:
        return self._paginated("/api/projects")

    def list_tasks(self) -> list[dict[str, Any]]:
        return self._paginated("/api/tasks")

    def list_jobs(self) -> list[dict[str, Any]]:
        return self._paginated("/api/jobs")

    def retrieve_task(self, task_id: str | int) -> dict[str, Any]:
        return self.get_json(f"/api/tasks/{task_id}")

    def retrieve_task_data_meta(self, task_id: str | int) -> dict[str, Any]:
        return self.get_json(f"/api/tasks/{task_id}/data/meta")

    def retrieve_task_preview(self, task_id: str | int) -> CvatBinaryResponse:
        return self.get_bytes(f"/api/tasks/{task_id}/preview")

    def retrieve_task_frame(self, task_id: str | int, frame: int) -> CvatBinaryResponse:
        return self.get_bytes(
            f"/api/tasks/{task_id}/data",
            {"type": "frame", "number": frame, "quality": "original"},
        )

    def retrieve_job_annotations(self, job_id: str | int) -> dict[str, Any]:
        return self.get_json(f"/api/jobs/{job_id}/annotations/")

    def partial_update_job_annotations(
        self,
        job_id: str | int,
        action: str,
        payload: dict[str, Any],
    ) -> Any:
        return self.patch_json(
            f"/api/jobs/{job_id}/annotations/",
            payload,
            params={"action": action},
        )

    def create_task_dataset_export(
        self,
        task_id: str | int,
        *,
        export_format: str,
        filename: str,
        save_images: bool,
    ) -> dict[str, Any]:
        payload = self.post_json(
            f"/api/tasks/{task_id}/dataset/export",
            params={
                "format": export_format,
                "filename": filename,
                "save_images": str(save_images).lower(),
            },
        )
        return payload if isinstance(payload, dict) else {}

    def retrieve_request(self, request_id: str) -> dict[str, Any]:
        return self.get_json(f"/api/requests/{request_id}")

    def list_quality_reports(self, *, task_id: str | int | None = None) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"page_size": 100}
        if task_id is not None:
            params["task_id"] = task_id
        return self._results(self.get_json("/api/quality/reports", params))

    def retrieve_quality_report_data(self, report_id: str | int) -> Any:
        return self.get_json(f"/api/quality/reports/{report_id}/data", {"format": "json"})

    def _paginated(self, path: str, page_size: int = 100) -> list[dict[str, Any]]:
        page = 1
        rows: list[dict[str, Any]] = []
        while True:
            payload = self.get_json(path, {"page": page, "page_size": page_size})
            rows.extend(self._results(payload))
            if not isinstance(payload, dict) or not payload.get("next"):
                return rows
            page += 1

    @staticmethod
    def _results(payload: Any) -> list[dict[str, Any]]:
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict) and isinstance(payload.get("results"), list):
            return payload["results"]
        return []
