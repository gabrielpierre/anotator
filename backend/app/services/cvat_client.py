from typing import Any, NamedTuple
from urllib.parse import urljoin, urlparse, urlunparse

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
        self.auth_scheme = (settings.cvat_auth_scheme or "Bearer").strip() or "Bearer"
        self.host_header = settings.cvat_host_header
        self.timeout = settings.cvat_request_timeout_seconds

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    @property
    def authenticated(self) -> bool:
        return bool(self.token)

    def _headers(self, *, include_auth: bool = True) -> dict[str, str]:
        headers = {}
        if include_auth and self.token:
            headers["Authorization"] = f"{self.auth_scheme} {self.token}"
        if self.host_header:
            headers["Host"] = self.host_header
        return headers

    def _format_http_error(self, exc: httpx.HTTPError, url: str) -> str:
        if isinstance(exc, httpx.HTTPStatusError):
            status_code = exc.response.status_code
            if status_code in {401, 403}:
                return (
                    "CVAT recusou a autenticacao. Verifique se CVAT_ACCESS_TOKEN "
                    "tem um token valido e se CVAT_AUTH_SCHEME esta correto. "
                    "No CVAT local deste projeto, use CVAT_AUTH_SCHEME=Token."
                )
            if status_code == 404:
                return (
                    f"CVAT retornou 404 para {url}. Em ambiente Docker local, confirme "
                    "CVAT_HOST_HEADER=localhost quando CVAT_BASE_URL usar host.docker.internal."
                )
            return f"CVAT retornou HTTP {status_code} para {url}: {exc.response.text[:500]}"
        if isinstance(exc, httpx.ConnectError):
            return (
                f"CVAT nao esta acessivel em {self.base_url}. Verifique se o CVAT esta "
                "rodando em http://localhost:8080 e se backend/worker conseguem resolver "
                "host.docker.internal."
            )
        return str(exc)

    def get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
        *,
        include_auth: bool = True,
    ) -> Any:
        url = f"{self.base_url}{path}"
        try:
            response = httpx.get(
                url,
                headers=self._headers(include_auth=include_auth),
                params=params,
                timeout=self.timeout,
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(self._format_http_error(exc, url)) from exc

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
            raise CvatClientError(self._format_http_error(exc, url)) from exc

    def post_multipart(
        self,
        path: str,
        *,
        data: dict[str, Any] | None = None,
        files: list[tuple[str, tuple[str, bytes, str]]] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        try:
            response = httpx.post(
                url,
                headers=self._headers(),
                params=params,
                data=data or {},
                files=files or [],
                timeout=self.timeout,
            )
            response.raise_for_status()
            if not response.content:
                return None
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(self._format_http_error(exc, url)) from exc

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
            raise CvatClientError(self._format_http_error(exc, url)) from exc

    def delete_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url}{path}"
        try:
            response = httpx.delete(
                url,
                headers=self._headers(),
                params=params,
                timeout=self.timeout,
            )
            response.raise_for_status()
            if not response.content:
                return {}
            return response.json()
        except httpx.HTTPError as exc:
            raise CvatClientError(self._format_http_error(exc, url)) from exc

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
            raise CvatClientError(self._format_http_error(exc, url)) from exc

    def get_url_bytes(self, url_or_path: str) -> CvatBinaryResponse:
        url = self._download_url(url_or_path)
        try:
            response = httpx.get(url, headers=self._headers(), timeout=self.timeout)
            response.raise_for_status()
            return CvatBinaryResponse(
                content=response.content,
                content_type=response.headers.get("content-type"),
            )
        except httpx.HTTPError as exc:
            raise CvatClientError(self._format_http_error(exc, url)) from exc

    def _download_url(self, url_or_path: str) -> str:
        if not url_or_path.startswith("http"):
            return urljoin(f"{self.base_url}/", url_or_path.lstrip("/"))

        parsed = urlparse(url_or_path)
        if parsed.hostname not in {"localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"}:
            return url_or_path

        base = urlparse(self.base_url)
        if not base.netloc:
            return url_or_path
        return urlunparse(parsed._replace(scheme=base.scheme or parsed.scheme, netloc=base.netloc))

    def server_about(self) -> dict[str, Any]:
        return self.get_json("/api/server/about", include_auth=False)

    def current_user(self) -> dict[str, Any]:
        return self.get_json("/api/users/self")

    def list_projects(self) -> list[dict[str, Any]]:
        return self._paginated("/api/projects")

    def list_tasks(self) -> list[dict[str, Any]]:
        return self._paginated("/api/tasks")

    def list_jobs(self) -> list[dict[str, Any]]:
        return self._paginated("/api/jobs")

    def list_labels(
        self,
        *,
        project_id: str | int | None = None,
        task_id: str | int | None = None,
        job_id: str | int | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {}
        if project_id is not None:
            params["project_id"] = project_id
        if task_id is not None:
            params["task_id"] = task_id
        if job_id is not None:
            params["job_id"] = job_id
        return self._paginated("/api/labels", params=params)

    def retrieve_task(self, task_id: str | int) -> dict[str, Any]:
        return self.get_json(f"/api/tasks/{task_id}")

    def delete_task(self, task_id: str | int) -> dict[str, Any]:
        result = self.delete_json(f"/api/tasks/{task_id}")
        return result if isinstance(result, dict) else {}

    def create_task(
        self,
        *,
        name: str,
        labels: list[dict[str, Any]],
        project_id: str | int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"name": name, "labels": labels}
        if project_id is not None:
            payload["project_id"] = project_id
        result = self.post_json("/api/tasks", payload)
        return result if isinstance(result, dict) else {}

    def upload_task_data(
        self,
        task_id: str | int,
        *,
        files: list[tuple[str, bytes, str]],
        image_quality: int = 70,
    ) -> dict[str, Any]:
        multipart = [
            (f"client_files[{index}]", (filename, content, content_type))
            for index, (filename, content, content_type) in enumerate(files)
        ]
        result = self.post_multipart(
            f"/api/tasks/{task_id}/data",
            data={"image_quality": str(image_quality), "sorting_method": "lexicographical"},
            files=multipart,
        )
        return result if isinstance(result, dict) else {}

    def retrieve_task_data_meta(self, task_id: str | int) -> dict[str, Any]:
        return self.get_json(f"/api/tasks/{task_id}/data/meta")

    def retrieve_task_preview(self, task_id: str | int) -> CvatBinaryResponse:
        return self.get_bytes(f"/api/tasks/{task_id}/preview")

    def retrieve_task_frame(
        self,
        task_id: str | int,
        frame: int,
        *,
        quality: str = "original",
    ) -> CvatBinaryResponse:
        return self.get_bytes(
            f"/api/tasks/{task_id}/data",
            {"type": "frame", "number": frame, "quality": quality},
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

    def _paginated(
        self,
        path: str,
        page_size: int = 100,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        page = 1
        rows: list[dict[str, Any]] = []
        while True:
            request_params = {**(params or {}), "page": page, "page_size": page_size}
            payload = self.get_json(path, request_params)
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
