import json
import logging
import os
import re
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path
from typing import Any

from django.conf import settings
from django.http import (
    FileResponse,
    HttpRequest,
    HttpResponse,
    HttpResponseBadRequest,
    JsonResponse,
)
from django.shortcuts import render
from django.urls import reverse
from django.utils.http import content_disposition_header
from django.views.decorators.http import require_GET, require_POST

from .document_workflow import (
    analysis_to_sections,
    add_detected_pdf_tables,
    analyze_document_chunk,
    chunk_count_for_pages,
    create_export,
    extract_pdf_tables,
    GroqRateLimitError,
    merge_document_chunks,
)
from .schedule_workflow import (
    apply_changes_xlsx,
    build_schedule_prompt,
    call_groq_schedule_analysis,
    extract_xlsx_structure,
)
logger = logging.getLogger(__name__)
MAX_PROMPT_CHARS = 100_000
PDF_SIGNATURE = b"%PDF-"


def _document_directory(request: HttpRequest) -> Path | None:
    job_id = request.session.get("pdf_job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-f]{32}", job_id):
        return None
    directory = Path(settings.PDF_JOB_ROOT) / job_id
    return directory if directory.is_dir() else None


def _remove_job_directory(directory: Path) -> None:
    if re.fullmatch(r"[0-9a-f]{32}", directory.name):
        shutil.rmtree(directory, ignore_errors=True)


def _remove_expired_jobs(root: Path) -> None:
    if not root.is_dir():
        return
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    try:
        directories = tuple(root.iterdir())
    except OSError:
        logger.warning("No se pudo inspeccionar el almacenamiento temporal de PDF.")
        return
    for directory in directories:
        if not re.fullmatch(r"[0-9a-f]{32}", directory.name) or not directory.is_dir():
            continue
        try:
            modified = datetime.fromtimestamp(directory.stat().st_mtime, tz=timezone.utc)
            if modified < cutoff:
                _remove_job_directory(directory)
        except OSError:
            logger.warning("No se pudo limpiar un trabajo temporal de PDF.")


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("No se pudieron recuperar los datos del documento. Vuelve a subirlo.") from exc


def _json_error(message: str, status: int = 422) -> JsonResponse:
    return JsonResponse({"error": message}, status=status)


def load_training_context() -> dict[str, list[str]]:
    """Load the column names used by the official agreements workbook."""
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise RuntimeError("Falta openpyxl. Instala las dependencias de requirements.txt.") from exc

    workbook_path = Path(settings.TRAINING_EXCEL_PATH)
    if not workbook_path.is_file():
        raise FileNotFoundError(f"No se encontró el archivo Excel de referencia: {workbook_path}")

    workbook = load_workbook(workbook_path, read_only=True, data_only=True)
    try:
        if not workbook.worksheets:
            raise ValueError(f"El archivo Excel no contiene hojas: {workbook_path}")
        worksheet = workbook.worksheets[0]
        first_row = next(
            worksheet.iter_rows(min_row=1, max_row=1, values_only=True),
            None,
        )
        if first_row is None:
            raise ValueError(f"La primera hoja del Excel está vacía: {workbook_path}")
        headers = [str(value).strip() if value is not None else "" for value in first_row]
    finally:
        workbook.close()

    if not any(headers):
        raise ValueError(f"La primera fila del Excel no contiene encabezados: {workbook_path}")
    return {"headers": headers}


def extract_pages_from_pdf(pdf_path: str | os.PathLike[str]) -> list[str]:
    """Extract text from a PDF, using Tesseract OCR only for pages without text."""
    try:
        import pymupdf
    except ImportError as exc:
        raise RuntimeError("Falta PyMuPDF. Instala las dependencias de requirements.txt.") from exc

    try:
        document = pymupdf.open(pdf_path)
    except (pymupdf.FileDataError, pymupdf.EmptyFileError) as exc:
        raise ValueError("El archivo seleccionado no es un PDF válido o está dañado.") from exc

    pages: list[str] = []
    with document:
        if document.is_encrypted:
            raise ValueError("El PDF está protegido con contraseña y no se puede leer.")
        if document.page_count == 0:
            raise ValueError("El PDF no contiene páginas.")
        if document.page_count > settings.MAX_PDF_PAGES:
            raise ValueError(
                f"El documento tiene más de {settings.MAX_PDF_PAGES} páginas, el límite permitido."
            )

        scanned_pages: list[tuple[int, Any]] = []
        for page_number, page in enumerate(document, start=1):
            text = page.get_text("text").strip()
            pages.append(text)
            if not text:
                scanned_pages.append((page_number - 1, page))

        if scanned_pages:
            try:
                import pytesseract
                from PIL import Image
            except ImportError as exc:
                raise RuntimeError(
                    "El PDF necesita OCR, pero faltan pytesseract o Pillow. Instala requirements.txt."
                ) from exc

            tesseract_cmd = os.environ.get("TESSERACT_CMD")
            if tesseract_cmd:
                pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
            language = os.environ.get("TESSERACT_LANG", "spa")
            for page_number, page in scanned_pages:
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                with Image.open(BytesIO(pixmap.tobytes("png"))) as image:
                    try:
                        pages[page_number] = pytesseract.image_to_string(image, lang=language).strip()
                    except pytesseract.TesseractNotFoundError as exc:
                        raise RuntimeError(
                            "No se encontró el ejecutable de Tesseract. Instálalo y define TESSERACT_CMD."
                        ) from exc
                    except pytesseract.TesseractError as exc:
                        raise RuntimeError(
                            f"Tesseract no pudo procesar la página {page_number + 1}; verifica el idioma {language!r}."
                        ) from exc

    return pages


def extract_text_from_pdf(pdf_path: str | os.PathLike[str]) -> str:
    return "\n\n".join(extract_pages_from_pdf(pdf_path))


def ask_llm_for_summary(pages: list[str]) -> str:
    """Ask Groq to return one JSON object keyed by the workbook's exact headers."""
    api_key = settings.GROQ_API_KEY.strip()
    if not api_key:
        raise RuntimeError(
            "Falta GROQ_API_KEY. Configúrala como variable de entorno antes de procesar un PDF."
        )

    context = load_training_context()
    headers = context["headers"]
    document_text = "\n\n".join(
        f"PÁGINA {number}:\n{text}" for number, text in enumerate(pages, start=1)
    )
    if len(document_text) > MAX_PROMPT_CHARS:
        raise ValueError(
            f"El texto extraído supera el límite de {MAX_PROMPT_CHARS} caracteres para el análisis."
        )

    prompt = (
        "Extrae del documento los datos que correspondan a los siguientes campos. "
        "Devuelve únicamente un objeto JSON válido, sin Markdown, usando exactamente estos nombres "
        "de campo y una cadena vacía cuando un dato no aparezca. No inventes información.\n"
        f"CAMPOS: {json.dumps(headers, ensure_ascii=False)}\n\n"
        f"DOCUMENTO:\n{document_text}"
    )
    body = json.dumps(
        {
            "model": settings.GROQ_MODEL,
            "temperature": 0,
            "messages": [{"role": "user", "content": prompt}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        settings.GROQ_API_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "groq-python/0.31.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=settings.GROQ_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Groq respondió con el estado HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"No se pudo conectar con Groq: {exc.reason}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Groq devolvió una respuesta que no es JSON válido.") from exc

    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("La respuesta de Groq no contiene el texto esperado.") from exc
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Groq devolvió una respuesta vacía.")
    return content.strip()


def parse_extracted_record(result: str | dict[str, Any], headers: list[str]) -> dict[str, Any]:
    if isinstance(result, dict):
        extracted = result
    else:
        normalized = result.strip()
        normalized = re.sub(r"^```(?:json)?\s*|\s*```$", "", normalized, flags=re.IGNORECASE)
        try:
            extracted = json.loads(normalized)
        except json.JSONDecodeError as exc:
            raise ValueError("La respuesta del modelo no contiene un objeto JSON válido.") from exc

    if not isinstance(extracted, dict):
        raise ValueError("La respuesta del modelo debe ser un objeto JSON.")

    record: dict[str, Any] = {}
    for header in headers:
        value = extracted.get(header, "")
        if value is None:
            value = ""
        elif isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        record[header] = value
    return record


@require_GET
def index(request: HttpRequest) -> HttpResponse:
    return render(request, "home/index.html")


def _schedule_directory(request: HttpRequest) -> Path | None:
    job_id = request.session.get("schedule_job_id")
    if not isinstance(job_id, str) or not re.fullmatch(r"[0-9a-f]{32}", job_id):
        return None
    directory = Path(settings.PDF_JOB_ROOT) / job_id
    return directory if directory.is_dir() else None


@require_GET
def schedule_page(request: HttpRequest) -> HttpResponse:
    return render(request, "home/schedule.html")


@require_POST
def preview_schedule_template(request: HttpRequest) -> JsonResponse:
    template_file = request.FILES.get("template")
    if template_file is None:
        return _json_error("Selecciona una plantilla Excel .xlsx para mostrar la vista previa.", 400)
    if Path(template_file.name).suffix.lower() != ".xlsx":
        return _json_error("La plantilla debe ser un archivo Excel .xlsx.", 400)
    if template_file.size > settings.MAX_PDF_UPLOAD_SIZE:
        return _json_error("La plantilla Excel supera el límite permitido de 20 MB.", 413)

    try:
        with tempfile.TemporaryDirectory(prefix="schedule_preview_") as temp_dir:
            template_path = Path(temp_dir) / "template.xlsx"
            with template_path.open("wb") as destination:
                for chunk in template_file.chunks():
                    destination.write(chunk)
            if not zipfile.is_zipfile(template_path):
                raise ValueError("La plantilla seleccionada no es un archivo Excel .xlsx válido.")
            with zipfile.ZipFile(template_path) as workbook_archive:
                if sum(entry.file_size for entry in workbook_archive.infolist()) > 100 * 1024 * 1024:
                    raise ValueError("El contenido descomprimido de la plantilla Excel supera el límite permitido.")
                for entry in workbook_archive.infolist():
                    if entry.filename.lower().endswith(".xml"):
                        xml_content = workbook_archive.read(entry)
                        if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)", xml_content, re.IGNORECASE):
                            raise ValueError("La plantilla Excel contiene declaraciones XML no admitidas.")
            structure = extract_xlsx_structure(template_path)
            if not structure["sheets"]:
                raise ValueError("La plantilla Excel no contiene hojas.")
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
        logger.warning("No se pudo preparar la vista previa de la plantilla: %s", exc)
        return _json_error(str(exc))

    return JsonResponse(
        {
            "filename": Path(template_file.name).name[:180],
            "sheets": structure["preview"],
        }
    )


@require_POST
def analyze_schedule(request: HttpRequest) -> JsonResponse:
    pdf_file = request.FILES.get("pdf")
    template_file = request.FILES.get("template")
    if pdf_file is None or template_file is None:
        return _json_error("Selecciona el PDF fuente y la plantilla Excel.", 400)
    if Path(pdf_file.name).suffix.lower() != ".pdf":
        return _json_error("El documento fuente debe ser un PDF.", 400)
    if Path(template_file.name).suffix.lower() != ".xlsx":
        return _json_error("La plantilla debe ser un archivo Excel .xlsx.", 400)
    if pdf_file.size > settings.MAX_PDF_UPLOAD_SIZE:
        return _json_error("El PDF supera el límite permitido de 20 MB.", 413)
    if template_file.size > settings.MAX_PDF_UPLOAD_SIZE:
        return _json_error("La plantilla Excel supera el límite permitido de 20 MB.", 413)

    previous_job = _schedule_directory(request)
    if previous_job is not None:
        _remove_job_directory(previous_job)
    job_id = uuid.uuid4().hex
    job_directory = Path(settings.PDF_JOB_ROOT) / job_id
    pdf_path = job_directory / "source.pdf"
    template_path = job_directory / "original.xlsx"
    try:
        job_directory.mkdir(parents=True, exist_ok=False)
        for uploaded, destination in (
            (pdf_file, pdf_path),
            (template_file, template_path),
        ):
            with destination.open("wb") as output:
                for chunk in uploaded.chunks():
                    output.write(chunk)
        with pdf_path.open("rb") as source:
            if source.read(len(PDF_SIGNATURE)) != PDF_SIGNATURE:
                raise ValueError("El archivo fuente no contiene un PDF válido.")
        if not zipfile.is_zipfile(template_path):
            raise ValueError("La plantilla seleccionada no es un archivo Excel .xlsx válido.")
        with zipfile.ZipFile(template_path) as workbook_archive:
            if sum(entry.file_size for entry in workbook_archive.infolist()) > 100 * 1024 * 1024:
                raise ValueError("El contenido descomprimido de la plantilla Excel supera el límite permitido.")
            for entry in workbook_archive.infolist():
                if entry.filename.lower().endswith(".xml"):
                    xml_content = workbook_archive.read(entry)
                    if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)", xml_content, re.IGNORECASE):
                        raise ValueError("La plantilla Excel contiene declaraciones XML no admitidas.")

        pages = extract_pages_from_pdf(pdf_path)
        pdf_text = "\n\n".join(
            f"[Página {number}]\n{text}"
            for number, text in enumerate(pages, start=1)
            if text.strip()
        )
        if not pdf_text.strip():
            raise ValueError("No se pudo extraer texto del PDF fuente.")
        structure = extract_xlsx_structure(template_path)
        if not structure["sheets"]:
            raise ValueError("La plantilla Excel no contiene hojas.")
        result = call_groq_schedule_analysis(
            build_schedule_prompt(pdf_text, structure)
        )
        raw_changes = result.get("proposed_changes", [])
        if not isinstance(raw_changes, list):
            raise ValueError("La IA devolvió propuestas de celdas con un formato inválido.")

        available_cells = {
            (cell["sheet_name"], cell["ref"])
            for cell in structure["empty_refs"]
        }
        proposals: list[dict[str, Any]] = []
        seen_cells: set[tuple[str, str]] = set()
        for change in raw_changes:
            if not isinstance(change, dict):
                continue
            sheet_name = change.get("sheet_name")
            ref = str(change.get("ref", "")).strip().upper()
            value = change.get("proposed_value")
            if not isinstance(sheet_name, str):
                continue
            key = (sheet_name, ref)
            if (
                key not in available_cells
                or key in seen_cells
                or not isinstance(value, (str, int, float))
                or not str(value).strip()
            ):
                continue
            raw_pages = change.get("source_pages", [])
            source_pages = [
                page for page in raw_pages
                if isinstance(page, int) and not isinstance(page, bool) and 1 <= page <= len(pages)
            ][:20] if isinstance(raw_pages, list) else []
            try:
                confidence = float(change.get("confidence", 0) or 0)
            except (TypeError, ValueError):
                confidence = 0.0
            seen_cells.add(key)
            proposals.append(
                {
                    "sheet_name": sheet_name,
                    "ref": ref,
                    "original_value": "",
                    "proposed_value": str(value).strip()[:2000],
                    "source_pages": source_pages,
                    "confidence": min(1.0, max(0.0, confidence)),
                    "reason": str(change.get("reason", "")).strip()[:500],
                }
            )

        (job_directory / "structure.json").write_text(
            json.dumps(structure, ensure_ascii=False),
            encoding="utf-8",
        )
        (job_directory / "schedule_analysis.json").write_text(
            json.dumps(result, ensure_ascii=False),
            encoding="utf-8",
        )
    except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as exc:
        logger.warning("No se pudo analizar el cronograma: %s", exc)
        if job_directory.exists():
            _remove_job_directory(job_directory)
        return _json_error(str(exc))

    request.session["schedule_job_id"] = job_id
    request.session["schedule_filename"] = Path(template_file.name).name[:180]
    return JsonResponse(
        {
            "filename": Path(template_file.name).name[:180],
            "proposals": proposals,
            "summary": str(result.get("summary", "")).strip()[:2000],
            "unmapped_items": result.get("unmapped_items", [])[:50]
            if isinstance(result.get("unmapped_items"), list)
            else [],
            "warnings": result.get("warnings", [])[:20]
            if isinstance(result.get("warnings"), list)
            else [],
            "sheets": structure["preview"],
        }
    )


@require_POST
def download_completed_schedule(request: HttpRequest) -> HttpResponse:
    job_directory = _schedule_directory(request)
    if job_directory is None:
        return _json_error("La sesión del cronograma venció. Vuelve a subir los dos archivos.", 400)
    try:
        body = json.loads(request.body.decode("utf-8"))
        raw_changes = body.get("changes") if isinstance(body, dict) else None
        if not isinstance(raw_changes, list):
            return _json_error("No se recibieron cambios aprobados válidos.", 400)
        structure = _read_json_file(job_directory / "structure.json")
        allowed_cells = {
            (cell["sheet_name"], cell["ref"])
            for cell in structure.get("empty_refs", [])
            if isinstance(cell, dict)
            and isinstance(cell.get("sheet_name"), str)
            and isinstance(cell.get("ref"), str)
        }
        approved: list[dict[str, Any]] = []
        for change in raw_changes[:500]:
            if not isinstance(change, dict):
                continue
            sheet_name = change.get("sheet_name")
            ref = str(change.get("ref", "")).strip().upper()
            value = change.get("proposed_value")
            if (
                isinstance(sheet_name, str)
                and (sheet_name, ref) in allowed_cells
                and isinstance(value, str)
                and value.strip()
            ):
                approved.append(
                    {
                        "sheet_name": sheet_name,
                        "ref": ref,
                        "proposed_value": value.strip()[:2000],
                    }
                )
        if not approved:
            return _json_error("Selecciona al menos una propuesta para aplicar al Excel.", 400)
        content = apply_changes_xlsx(job_directory / "original.xlsx", approved)
    except (OSError, RuntimeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning("No se pudo generar el cronograma completado: %s", exc)
        return _json_error(str(exc))

    response = HttpResponse(
        content,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    filename = request.session.get("schedule_filename", "cronograma.xlsx")
    safe_filename = Path(filename).stem[:150] + "_completado.xlsx"
    response["Content-Disposition"] = content_disposition_header(True, safe_filename)
    return response


@require_POST
def upload_document(request: HttpRequest) -> JsonResponse:
    uploaded_file = request.FILES.get("pdf")
    if uploaded_file is None:
        return _json_error("Selecciona un archivo PDF.", 400)
    if Path(uploaded_file.name).suffix.lower() != ".pdf":
        return _json_error("El archivo debe tener extensión .pdf.", 400)
    if uploaded_file.size > settings.MAX_PDF_UPLOAD_SIZE:
        return _json_error("El PDF supera el límite permitido de 20 MB.", 413)

    previous_job = _document_directory(request)
    if previous_job is not None:
        _remove_job_directory(previous_job)
    for session_key in ("pdf_job_id", "pdf_filename", "pdf_page_count", "pdf_analyzed"):
        request.session.pop(session_key, None)
    _remove_expired_jobs(Path(settings.PDF_JOB_ROOT))

    job_id = uuid.uuid4().hex
    job_directory = Path(settings.PDF_JOB_ROOT) / job_id
    pdf_path = job_directory / "original.pdf"
    try:
        job_directory.mkdir(parents=True, exist_ok=False)
        with pdf_path.open("wb") as destination:
            for chunk in uploaded_file.chunks():
                destination.write(chunk)
        with pdf_path.open("rb") as source:
            if source.read(len(PDF_SIGNATURE)) != PDF_SIGNATURE:
                raise ValueError("El archivo seleccionado no contiene un PDF válido.")

        pages = extract_pages_from_pdf(pdf_path)
        if len(pages) > settings.MAX_PDF_PAGES:
            raise ValueError(
                f"El documento tiene {len(pages)} páginas; el máximo permitido es "
                f"{settings.MAX_PDF_PAGES}."
            )
        extracted_chars = sum(len(page) for page in pages)
        if extracted_chars > settings.MAX_EXTRACTED_TEXT_CHARS:
            raise ValueError(
                "El texto extraído supera el límite permitido. Divide el documento en archivos más pequeños."
            )
        if not any(page.strip() for page in pages):
            raise ValueError("No se pudo extraer texto del PDF. Comprueba el documento o configura OCR.")
        (job_directory / "pages.json").write_text(
            json.dumps(pages, ensure_ascii=False),
            encoding="utf-8",
        )
        detected_tables = extract_pdf_tables(pdf_path)
        (job_directory / "detected_tables.json").write_text(
            json.dumps(detected_tables, ensure_ascii=False),
            encoding="utf-8",
        )
    except (OSError, RuntimeError, ValueError) as exc:
        logger.warning("No se pudo preparar el PDF: %s", exc)
        if job_directory.exists():
            _remove_job_directory(job_directory)
        return _json_error(str(exc))

    request.session["pdf_job_id"] = job_id
    request.session["pdf_filename"] = Path(uploaded_file.name).name[:180]
    request.session["pdf_page_count"] = len(pages)
    request.session.pop("pdf_analyzed", None)
    request.session.pop("last_extracted_record", None)
    return JsonResponse(
        {
            "filename": request.session["pdf_filename"],
            "page_count": len(pages),
            "chunk_count": chunk_count_for_pages(pages),
            "workflow_version": 2,
            "preview_url": reverse("home:preview_pdf"),
            "analyze_url": reverse("home:analyze_document"),
        }
    )


@require_POST
def analyze_document(request: HttpRequest) -> JsonResponse:
    job_directory = _document_directory(request)
    if job_directory is None:
        return _json_error("La sesión del documento venció. Sube el PDF nuevamente.", 400)

    try:
        body = json.loads(request.body or b"{}")
        chunk_index = body.get("chunk_index") if isinstance(body, dict) else None
        if not isinstance(chunk_index, int) or isinstance(chunk_index, bool):
            return _json_error("El número de fragmento solicitado no es válido.", 400)

        pages = _read_json_file(job_directory / "pages.json")
        if not isinstance(pages, list) or not all(isinstance(page, str) for page in pages):
            raise ValueError("El contenido extraído del PDF no tiene un formato válido.")
        total_chunks = chunk_count_for_pages(pages)
        if chunk_index < 0 or chunk_index >= total_chunks:
            return _json_error("El fragmento solicitado está fuera del documento.", 400)

        chunk_path = job_directory / f"analysis_chunk_{chunk_index:04d}.json"
        if chunk_path.is_file():
            chunk_analysis = _read_json_file(chunk_path)
        else:
            chunk_analysis = analyze_document_chunk(pages, chunk_index)
            temporary_path = chunk_path.with_suffix(".tmp")
            temporary_path.write_text(
                json.dumps(chunk_analysis, ensure_ascii=False),
                encoding="utf-8",
            )
            temporary_path.replace(chunk_path)

        completed_chunks = chunk_index + 1
        if completed_chunks < total_chunks:
            return JsonResponse(
                {
                    "done": False,
                    "completed_chunks": completed_chunks,
                    "total_chunks": total_chunks,
                    "next_chunk": completed_chunks,
                }
            )

        chunk_results = [
            _read_json_file(job_directory / f"analysis_chunk_{index:04d}.json")
            for index in range(total_chunks)
        ]
        if not all(isinstance(result, dict) for result in chunk_results):
            raise ValueError("Uno de los fragmentos analizados no tiene un formato válido.")
        analysis = merge_document_chunks(chunk_results, len(pages))
        detected_tables_path = job_directory / "detected_tables.json"
        if detected_tables_path.is_file():
            detected_tables = _read_json_file(detected_tables_path)
            if isinstance(detected_tables, list):
                analysis = add_detected_pdf_tables(analysis, detected_tables)
        (job_directory / "analysis.json").write_text(
            json.dumps(analysis, ensure_ascii=False),
            encoding="utf-8",
        )
    except GroqRateLimitError as exc:
        logger.info("Groq rate limit while analyzing PDF chunk %s.", chunk_index)
        return JsonResponse(
            {"error": str(exc), "retry_after": exc.retry_after},
            status=429,
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        logger.warning("No se pudo analizar el PDF: %s", exc)
        return _json_error(str(exc))

    request.session["pdf_analyzed"] = True
    return JsonResponse(
        {
            "done": True,
            "completed_chunks": completed_chunks,
            "total_chunks": total_chunks,
            "review_url": reverse("home:review_document"),
        }
    )


@require_GET
def review_document(request: HttpRequest) -> HttpResponse:
    job_directory = _document_directory(request)
    if job_directory is None or not request.session.get("pdf_analyzed"):
        return render(
            request,
            "home/index.html",
            {"error": "Sube y analiza un PDF antes de abrir la vista de revisión."},
            status=400,
        )
    try:
        pages = _read_json_file(job_directory / "pages.json")
        analysis = _read_json_file(job_directory / "analysis.json")
        if not isinstance(pages, list) or not isinstance(analysis, dict):
            raise ValueError("Los resultados guardados no son válidos. Vuelve a subir el PDF.")
    except ValueError as exc:
        return render(request, "home/index.html", {"error": str(exc)}, status=400)

    review_data = {
        "title": analysis.get("title", ""),
        "topic": analysis.get("topic", ""),
        "executive_summary": analysis.get("executive_summary", ""),
        "sections": analysis_to_sections(analysis),
        "original_analysis": analysis,
        "filename": request.session.get("pdf_filename", "documento.pdf"),
        "page_count": len(pages),
        "chunk_count": chunk_count_for_pages(pages),
        "pages": pages,
        "preview_url": reverse("home:preview_pdf"),
        "convert_url": reverse("home:convert_document"),
        "has_tables": bool(analysis.get("tables")),
    }
    return render(
        request,
        "home/review.html",
        {"review_data": review_data, "error": request.GET.get("error", "")},
    )


@require_GET
def preview_pdf(request: HttpRequest) -> HttpResponse:
    job_directory = _document_directory(request)
    if job_directory is None:
        return HttpResponseBadRequest("El PDF ya no está disponible. Sube el documento nuevamente.")
    pdf_path = job_directory / "original.pdf"
    if not pdf_path.is_file():
        return HttpResponseBadRequest("El PDF original ya no está disponible.")
    response = FileResponse(
        pdf_path.open("rb"),
        content_type="application/pdf",
        filename="documento.pdf",
    )
    response["Content-Disposition"] = 'inline; filename="documento.pdf"'
    response["Cache-Control"] = "private, no-store"
    return response


@require_POST
def convert_document(request: HttpRequest) -> HttpResponse:
    job_directory = _document_directory(request)
    if job_directory is None or not request.session.get("pdf_analyzed"):
        return HttpResponseBadRequest("Sube y analiza un PDF antes de convertirlo.")
    try:
        payload = json.loads(request.POST.get("payload", ""))
        pages = _read_json_file(job_directory / "pages.json")
        if not isinstance(pages, list) or not all(isinstance(page, str) for page in pages):
            raise ValueError("El contenido extraído del PDF no tiene un formato válido.")
        content, content_type, filename = create_export(
            payload,
            pages,
            job_directory / "original.pdf",
        )
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        logger.warning("No se pudo convertir el documento: %s", exc)
        return render(
            request,
            "home/review.html",
            {
                "review_data": _review_data_for_request(request, job_directory),
                "error": str(exc),
            },
            status=422,
        )

    response = HttpResponse(content, content_type=content_type)
    response["Content-Disposition"] = content_disposition_header(True, filename)
    return response


def _review_data_for_request(request: HttpRequest, job_directory: Path) -> dict[str, Any]:
    pages = _read_json_file(job_directory / "pages.json")
    analysis = _read_json_file(job_directory / "analysis.json")
    return {
        "title": analysis.get("title", ""),
        "topic": analysis.get("topic", ""),
        "executive_summary": analysis.get("executive_summary", ""),
        "sections": analysis_to_sections(analysis),
        "original_analysis": analysis,
        "filename": request.session.get("pdf_filename", "documento.pdf"),
        "page_count": len(pages),
        "pages": pages,
        "preview_url": reverse("home:preview_pdf"),
        "convert_url": reverse("home:convert_document"),
        "has_tables": bool(analysis.get("tables")),
    }


@require_POST
def extract_pdf(request: HttpRequest) -> HttpResponse:
    uploaded_file = request.FILES.get("pdf")
    if uploaded_file is None:
        return HttpResponseBadRequest("Selecciona un archivo PDF.")
    if Path(uploaded_file.name).suffix.lower() != ".pdf":
        return HttpResponseBadRequest("El archivo debe tener extensión .pdf.")
    if uploaded_file.size > settings.MAX_PDF_UPLOAD_SIZE:
        return HttpResponseBadRequest("El PDF supera el límite permitido de 20 MB.")

    try:
        with tempfile.TemporaryDirectory(prefix="pdf_excel_") as temp_dir:
            pdf_path = Path(temp_dir) / "upload.pdf"
            with pdf_path.open("wb") as destination:
                for chunk in uploaded_file.chunks():
                    destination.write(chunk)

            pages = extract_pages_from_pdf(pdf_path)
            summary = ask_llm_for_summary(pages)
            record = parse_extracted_record(summary, load_training_context()["headers"])

        request.session["last_extracted_record"] = record
        filled_count = sum(value not in (None, "") for value in record.values())
        return render(
            request,
            "home/result.html",
            {"record": record, "filled_count": filled_count},
        )
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        logger.warning("No se pudo procesar el PDF: %s", exc)
        return render(request, "home/index.html", {"error": str(exc)}, status=422)


@require_POST
def ai_chat(request: HttpRequest) -> JsonResponse:
    """Answer a user question using the extracted PDF pages as context."""
    job_directory = _document_directory(request)
    if job_directory is None or not request.session.get("pdf_analyzed"):
        return _json_error("La sesión del documento venció. Sube el PDF nuevamente.", 400)

    try:
        body = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return _json_error("El cuerpo de la solicitud no es JSON válido.", 400)

    question = body.get("question", "").strip()
    if not question:
        return _json_error("Escribe una pregunta.", 400)
    if len(question) > 2000:
        return _json_error("La pregunta es demasiado larga (máximo 2000 caracteres).", 400)

    history = body.get("history", [])
    if not isinstance(history, list):
        history = []
    # Limit history to last 10 exchanges to avoid huge prompts
    history = history[-20:]

    try:
        pages = _read_json_file(job_directory / "pages.json")
        analysis = _read_json_file(job_directory / "analysis.json")
        if not isinstance(pages, list) or not isinstance(analysis, dict):
            raise ValueError("Los datos del documento no son válidos.")
    except ValueError as exc:
        return _json_error(str(exc))

    # Build a compact context: include page numbers so the AI can cite them
    CONTEXT_CHAR_LIMIT = 14_000
    page_chunks = []
    total = 0
    for idx, text in enumerate(pages, start=1):
        snippet = text.strip()
        if not snippet:
            continue
        entry = f"[Página {idx}]\n{snippet}"
        if total + len(entry) > CONTEXT_CHAR_LIMIT:
            # Try to include a truncated version of this page
            remaining = CONTEXT_CHAR_LIMIT - total
            if remaining > 200:
                page_chunks.append(entry[:remaining] + "…")
            break
        page_chunks.append(entry)
        total += len(entry)

    doc_context = "\n\n".join(page_chunks)
    title = analysis.get("title", "documento")

    system_prompt = (
        "Eres un asistente inteligente de análisis documental. "
        "Tienes acceso al texto completo extraído de un PDF titulado: «{title}». "
        "Responde SIEMPRE en español. "
        "Cuando cites información del documento, indica entre paréntesis las páginas de origen, "
        "por ejemplo: (Página 3) o (Páginas 2-4). "
        "Si la respuesta requiere información que NO aparece en el documento, indícalo claramente "
        "con la etiqueta [Fuente externa] antes de esa parte. "
        "Nunca inventes citas, páginas ni datos que no estén en el texto proporcionado. "
        "Mantén las respuestas claras, estructuradas y útiles para el estudio o trabajo profesional."
    ).format(title=title)

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]

    # Add the document context as the first user turn
    messages.append({
        "role": "user",
        "content": (
            "A continuación está el texto extraído del documento que analizaremos juntos. "
            "Úsalo como fuente principal para responder mis preguntas:\n\n"
            f"{doc_context}"
        ),
    })
    messages.append({
        "role": "assistant",
        "content": (
            "Entendido. He leído el documento completo y estoy listo para responder "
            "tus preguntas basándome en su contenido. ¿En qué puedo ayudarte?"
        ),
    })

    # Append prior conversation turns
    for turn in history:
        role = turn.get("role", "")
        content = turn.get("content", "")
        if role in {"user", "assistant"} and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content.strip()[:3000]})

    # Current question
    messages.append({"role": "user", "content": question})

    api_key = settings.GROQ_API_KEY.strip()
    if not api_key:
        return _json_error("Falta GROQ_API_KEY. Configúrala en el archivo .env.", 500)

    payload = json.dumps(
        {
            "model": settings.GROQ_MODEL,
            "temperature": 0.3,
            "max_tokens": 2048,
            "messages": messages,
        },
        ensure_ascii=False,
    ).encode("utf-8")

    req = urllib.request.Request(
        settings.GROQ_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "groq-python/0.31.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=settings.GROQ_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        logger.warning("Groq ai_chat HTTP %s", exc.code)
        return _json_error(f"El servicio de IA respondió con el estado HTTP {exc.code}.", 502)
    except urllib.error.URLError as exc:
        logger.warning("Groq ai_chat URLError: %s", exc.reason)
        return _json_error("No se pudo conectar con el servicio de IA. Comprueba la conexión.", 502)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return _json_error("El servicio de IA devolvió una respuesta inválida.", 502)

    try:
        answer = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError):
        return _json_error("El servicio de IA no devolvió una respuesta válida.", 502)

    if not answer:
        return _json_error("El asistente devolvió una respuesta vacía.", 502)

    return JsonResponse({"answer": answer})


@require_GET
def download_excel(request: HttpRequest) -> HttpResponse:
    record = request.session.get("last_extracted_record")
    if not isinstance(record, dict):
        return HttpResponseBadRequest("Primero procesa un PDF para generar el Excel.")

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
    except ImportError as exc:
        raise RuntimeError("Falta openpyxl. Instala las dependencias de requirements.txt.") from exc

    headers = load_training_context()["headers"]
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Matriz de Acuerdos"
    worksheet.append(headers)
    worksheet.append([record.get(header, "") for header in headers])

    header_fill = PatternFill(fill_type="solid", fgColor="1F4E78")
    for cell in worksheet[1]:
        cell.font = Font(color="FFFFFF", bold=True)
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for cell in worksheet[2]:
        cell.alignment = Alignment(vertical="top", wrap_text=True)
    worksheet.freeze_panes = "A2"
    worksheet.auto_filter.ref = worksheet.dimensions
    worksheet.row_dimensions[1].height = 48
    for column in worksheet.columns:
        worksheet.column_dimensions[column[0].column_letter].width = min(
            max(len(str(column[0].value or "")) + 2, 14), 36
        )

    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    response = HttpResponse(
        output.getvalue(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    response["Content-Disposition"] = 'attachment; filename="acuerdo_extraido.xlsx"'
    return response
