(() => {
  const form = document.querySelector("[data-upload-form]");
  const input = document.querySelector("[data-file-input]");
  const dropzone = document.querySelector("[data-dropzone]");
  const fileName = document.querySelector("[data-file-name]");
  const fileInfo = document.querySelector("[data-file-info]");
  const fileStatus = document.querySelector("[data-file-status]");
  const fileSize = document.querySelector("[data-file-size]");
  const pageCount = document.querySelector("[data-page-count]");
  const button = form?.querySelector("button[type='submit']");
  const buttonLabel = form?.querySelector("[data-button-label]");
  const steps = document.querySelector(".steps");
  const progressPanel = document.querySelector("[data-progress-panel]");
  const progressTitle = document.querySelector("[data-progress-title]");
  const progressDetail = document.querySelector("[data-progress-detail]");
  const progressPercent = document.querySelector("[data-upload-percent]");
  const clientError = document.querySelector("[data-client-error]");
  const clientErrorMessage = document.querySelector("[data-client-error-message]");

  if (
    !form ||
    !input ||
    !dropzone ||
    !fileName ||
    !fileInfo ||
    !fileStatus ||
    !fileSize ||
    !pageCount ||
    !button ||
    !buttonLabel ||
    !steps ||
    !progressPanel ||
    !progressTitle ||
    !progressDetail ||
    !progressPercent ||
    !clientError ||
    !clientErrorMessage
  ) {
    return;
  }

  const defaultFileLabel = "Arrastra tu archivo aquí";
  const maxBytes = 20 * 1024 * 1024;
  let uploadedDocument = null;
  let nextChunk = 0;

  const setStage = (stage) => {
    steps.dataset.stage = String(stage);
    for (const step of steps.querySelectorAll(".step")) {
      step.classList.toggle("is-complete", Number(step.dataset.step) < stage);
      step.classList.toggle("is-current", Number(step.dataset.step) === stage);
    }
  };

  const showSelectedFile = () => {
    const file = input.files?.[0];
    if (!file) {
      fileName.textContent = defaultFileLabel;
      dropzone.classList.remove("has-file");
      dropzone.removeAttribute("data-invalid");
      fileInfo.hidden = true;
      return;
    }

    fileName.textContent = file.name;
    dropzone.classList.add("has-file");
    dropzone.removeAttribute("data-invalid");
    fileInfo.hidden = false;
    fileStatus.textContent = "Archivo seleccionado";
    fileStatus.closest(".metadata-status")?.classList.remove("is-error");
    fileSize.textContent = formatBytes(file.size);
    pageCount.textContent = "páginas pendientes";
  };

  const formatBytes = (bytes) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  const showError = (message) => {
    clientErrorMessage.textContent = message;
    clientError.hidden = false;
    progressPanel.hidden = true;
    button.disabled = false;
    buttonLabel.textContent = uploadedDocument ? "Reintentar análisis" : "Intentar de nuevo";
    if (input.files?.length) {
      fileStatus.textContent = uploadedDocument ? "PDF cargado" : "No se pudo validar";
      fileStatus.closest(".metadata-status")?.classList.toggle("is-error", !uploadedDocument);
      pageCount.textContent = uploadedDocument
        ? `${uploadedDocument.page_count} ${uploadedDocument.page_count === 1 ? "página" : "páginas"}`
        : "páginas no disponibles";
    }
  };

  const csrfToken = () => form.querySelector("[name=csrfmiddlewaretoken]")?.value ?? "";

  const sendUpload = (formData) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", form.dataset.uploadUrl);
      xhr.setRequestHeader("X-CSRFToken", csrfToken());
      xhr.responseType = "text";
      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) {
          return;
        }
        const percentage = Math.min(100, Math.round((event.loaded / event.total) * 100));
        progressPercent.textContent = `${percentage}%`;
        progressTitle.textContent = "Subiendo documento…";
        progressDetail.textContent = "El PDF se transfiere de forma segura.";
      });
      xhr.addEventListener("load", () => {
        let response = null;
        try {
          response = JSON.parse(xhr.responseText);
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            reject(error);
            return;
          }
          response = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && response) {
          resolve(response);
          return;
        }
        const message = response?.error
          ?? (xhr.status === 413
            ? "El servidor rechazó el archivo por su tamaño. El PDF debe pesar menos de 20 MB."
            : xhr.status === 502 || xhr.status === 503 || xhr.status === 504
              ? "El servidor de Render no pudo terminar de procesar el PDF. Prueba con un archivo más pequeño o vuelve a intentarlo."
              : xhr.status >= 500
                ? `El servidor tuvo un error al procesar el PDF (HTTP ${xhr.status}). Revisa los registros de Render.`
                : xhr.status === 400
                  ? "El servidor rechazó la subida. Verifica que el PDF sea válido y no supere 20 MB."
                  : `No se pudo preparar el PDF (HTTP ${xhr.status || "sin respuesta"}). Inténtalo de nuevo.`);
        reject(new Error(message));
      });
      xhr.addEventListener("error", () =>
        reject(new Error("No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.")),
      );
      xhr.addEventListener("abort", () => reject(new Error("La subida del documento fue cancelada.")));
      xhr.send(formData);
    });

  input.addEventListener("change", () => {
    uploadedDocument = null;
    nextChunk = 0;
    clientError.hidden = true;
    showSelectedFile();
  });

  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  }

  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  }

  dropzone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer?.files ?? [];
    if (!file) {
      return;
    }

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    uploadedDocument = null;
    nextChunk = 0;
    clientError.hidden = true;
    showSelectedFile();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clientError.hidden = true;
    const file = input.files?.[0];
    if (!file) {
      showError("Selecciona un archivo PDF para continuar.");
      return;
    }
    const validMimeTypes = ["", "application/pdf", "application/x-pdf", "application/octet-stream"];
    if (!file.name.toLowerCase().endsWith(".pdf") || !validMimeTypes.includes(file.type)) {
      showError("El archivo seleccionado no parece ser un PDF válido.");
      return;
    }
    if (file.size > maxBytes) {
      showError("El PDF supera el límite permitido de 20 MB.");
      return;
    }

    button.disabled = true;
    buttonLabel.textContent = "Preparando…";
    progressPanel.hidden = false;
    progressPercent.textContent = "";
    progressTitle.textContent = "Extrayendo contenido del PDF…";
    progressDetail.textContent = "Estamos verificando el archivo y leyendo sus páginas.";
    setStage(1);

    try {
      if (!uploadedDocument) {
        uploadedDocument = await sendUpload(new FormData(form));
        fileStatus.textContent = "PDF validado";
        fileStatus.closest(".metadata-status")?.classList.remove("is-error");
        fileSize.textContent = formatBytes(file.size);
        pageCount.textContent = `${uploadedDocument.page_count} ${uploadedDocument.page_count === 1 ? "página" : "páginas"}`;
      }
      progressTitle.textContent = "Analizando el documento…";
      setStage(2);
      const totalChunks = Number(uploadedDocument.chunk_count);
      if (!Number.isInteger(totalChunks) || totalChunks < 1) {
        throw new Error(
          "El servidor está desactualizado y no informó cómo analizar el documento. Detén runserver, vuelve a iniciarlo con `python manage.py runserver` y recarga esta página con Ctrl+F5.",
        );
      }

      while (nextChunk < totalChunks) {
        const currentChunk = nextChunk + 1;
        let analysis;
        let rateLimitRetries = 0;
        while (true) {
          progressDetail.textContent = `Analizando fragmento ${currentChunk} de ${totalChunks}. Esta página seguirá respondiendo.`;
          progressPercent.textContent = `${Math.round((nextChunk / totalChunks) * 100)}%`;
          const response = await fetch(uploadedDocument.analyze_url ?? form.dataset.analyzeUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRFToken": csrfToken(),
            },
            body: JSON.stringify({ chunk_index: nextChunk }),
          });
          analysis = await response.json();
          if (response.status === 429 && rateLimitRetries < 3) {
            rateLimitRetries += 1;
            const waitSeconds = Math.min(
              300,
              Math.max(1, Number(analysis.retry_after) || 15 * rateLimitRetries),
            );
            for (let remaining = waitSeconds; remaining > 0; remaining -= 1) {
              progressTitle.textContent = "Límite temporal de Groq alcanzado";
              progressDetail.textContent =
                `Reintentando el mismo fragmento en ${remaining} s ` +
                `(intento ${rateLimitRetries} de 3). No necesitas volver a subir el PDF.`;
              await new Promise((resolve) => window.setTimeout(resolve, 1000));
            }
            continue;
          }
          if (!response.ok) {
            throw new Error(analysis.error ?? "No se pudo analizar el documento. Inténtalo de nuevo.");
          }
          break;
        }
        if (analysis.total_chunks !== totalChunks) {
          throw new Error("El servidor informó un total de fragmentos inconsistente. Inténtalo de nuevo.");
        }
        if (analysis.done) {
          if (analysis.completed_chunks !== totalChunks || !analysis.review_url) {
            throw new Error("El análisis terminó, pero el servidor no confirmó todos los resultados.");
          }
          nextChunk = totalChunks;
          progressPercent.textContent = "100%";
          progressTitle.textContent = "Análisis completado";
          progressDetail.textContent = "Abriendo la pantalla de revisión.";
          setStage(3);
          window.location.assign(analysis.review_url);
          return;
        }
        const next = Number(analysis.next_chunk);
        if (analysis.completed_chunks !== currentChunk || next !== currentChunk) {
          throw new Error("El servidor no confirmó el fragmento analizado. Puedes reintentar sin volver a subir el PDF.");
        }
        nextChunk = next;
        progressPercent.textContent = `${Math.round((analysis.completed_chunks / totalChunks) * 100)}%`;
      }
      throw new Error(
        "El servidor finalizó los fragmentos, pero no confirmó la vista previa. Puedes reintentar sin volver a subir el PDF.",
      );
    } catch (error) {
      showError(error instanceof Error ? error.message : "Ocurrió un error inesperado.");
    }
  });
})();
