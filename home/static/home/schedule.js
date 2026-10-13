(() => {
  const page = document.querySelector("[data-schedule-page]");
  const form = document.querySelector("[data-schedule-form]");
  if (!page || !form) return;

  const pdfInput = form.querySelector("[data-schedule-pdf]");
  const templateInput = form.querySelector("[data-schedule-template]");
  const analyzeButton = form.querySelector("[data-schedule-analyze]");
  const status = document.querySelector("[data-schedule-status]");
  const errorPanel = document.querySelector("[data-schedule-error]");
  const errorText = document.querySelector("[data-schedule-error-text]");
  const review = document.querySelector("[data-schedule-review]");
  const changesPanel = document.querySelector("[data-schedule-changes]");
  const notes = document.querySelector("[data-schedule-notes]");
  const downloadButton = document.querySelector("[data-schedule-download]");
  const csrfToken = form.querySelector("[name=csrfmiddlewaretoken]")?.value ?? "";
  const templatePreview = document.querySelector("[data-template-preview]");
  const previewFilename = document.querySelector("[data-preview-filename]");
  const previewDescription = document.querySelector("[data-template-preview-description]");
  const sheetPicker = document.querySelector("[data-sheet-picker]");
  const previewSheetSelect = document.querySelector("[data-preview-sheet]");
  const templateGrid = document.querySelector("[data-template-grid]");
  let proposals = [];
  let previewSheets = [];
  let previewRequest = 0;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const normalizeErrorMessage = (message) => {
    return String(message ?? "")
      .replace(/\*\*/g, "")
      .replace(/#+\s*/g, "")
      .replace(/\r?\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  const showError = (message) => {
    errorText.textContent = normalizeErrorMessage(message);
    errorPanel.hidden = false;
  };

  const columnName = (number) => {
    let name = "";
    while (number > 0) {
      number -= 1;
      name = String.fromCharCode(65 + (number % 26)) + name;
      number = Math.floor(number / 26);
    }
    return name;
  };

  const renderTemplatePreview = () => {
    const selectedSheet = previewSheets.find(
      (sheet) => sheet.name === previewSheetSelect.value,
    ) ?? previewSheets[0];
    if (!selectedSheet) return;

    const table = element("table", "schedule-template-grid");
    const columnCount = Math.max(0, ...selectedSheet.rows.map((row) => row.length));
    const head = element("thead");
    const headingRow = element("tr");
    headingRow.append(element("th", "schedule-grid-row-number", ""));
    for (let column = 1; column <= columnCount; column += 1) {
      headingRow.append(element("th", "", columnName(column)));
    }
    head.append(headingRow);
    table.append(head);

    const body = element("tbody");
    const proposedCells = new Map(
      proposals
        .filter((proposal) => proposal.sheet_name === selectedSheet.name)
        .map((proposal) => [proposal.ref, proposal.proposed_value ?? ""]),
    );
    for (const [rowIndex, row] of selectedSheet.rows.entries()) {
      const tableRow = element("tr");
      tableRow.append(element("th", "schedule-grid-row-number", String(rowIndex + 1)));
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cell = row[columnIndex];
        const ref = cell?.ref ?? `${columnName(columnIndex + 1)}${rowIndex + 1}`;
        const hasProposal = proposedCells.has(ref);
        const value = hasProposal ? proposedCells.get(ref) : cell?.value ?? "";
        const tableCell = element(
          "td",
          [
            value ? "" : "schedule-grid-empty",
            hasProposal ? "schedule-grid-target" : "",
          ].filter(Boolean).join(" "),
          value || "",
        );
        if (hasProposal) tableCell.title = "Propuesta extraída del PDF";
        tableRow.append(tableCell);
      }
      body.append(tableRow);
    }
    table.append(body);
    templateGrid.replaceChildren(table);
  };

  const setTemplatePreview = (data) => {
    const currentSheet = previewSheetSelect.value;
    previewSheets = Array.isArray(data.sheets) ? data.sheets : [];
    previewFilename.textContent = data.filename ?? "";
    previewSheetSelect.replaceChildren();
    for (const sheet of previewSheets) {
      const option = element("option", "", sheet.name);
      option.value = sheet.name;
      previewSheetSelect.append(option);
    }
    if (previewSheets.some((sheet) => sheet.name === currentSheet)) {
      previewSheetSelect.value = currentSheet;
    }
    sheetPicker.hidden = previewSheets.length < 2;
    templatePreview.hidden = previewSheets.length === 0;
    renderTemplatePreview();
  };

  const renderProposals = (data) => {
    proposals = Array.isArray(data.proposals) ? data.proposals : [];
    if (Array.isArray(data.sheets)) setTemplatePreview(data);
    previewDescription.textContent = proposals.length
      ? "Las celdas resaltadas muestran lo que se propone colocar usando la información del PDF."
      : "No se encontraron celdas para completar. La plantilla original permanece intacta.";
    renderTemplatePreview();
    changesPanel.replaceChildren();
    notes.replaceChildren();
    document.querySelector("[data-template-name]").textContent = data.filename ?? "";
    document.querySelector("[data-schedule-summary]").textContent = data.summary ?? "";
    document.querySelector("[data-change-count]").textContent =
      `${proposals.length} ${proposals.length === 1 ? "cambio" : "cambios"}`;

    if (!proposals.length) {
      changesPanel.append(
        element("p", "schedule-empty", "No se encontraron propuestas válidas para celdas vacías de esta plantilla. No se modificó el Excel."),
      );
    }
    proposals.forEach((proposal, index) => {
      const card = element("article", "schedule-change-card");
      const header = element("div", "schedule-change-meta");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.approveChange = String(index);
      const title = element("strong", "", `${proposal.sheet_name} · ${proposal.ref}`);
      header.append(checkbox, title);
      if (proposal.source_pages?.length) {
        header.append(element("span", "", `Fuente: pág. ${proposal.source_pages.join(", ")}`));
      }
      card.append(header);
      const reason = element("p", "schedule-change-reason", proposal.reason ?? "");
      if (reason.textContent) card.append(reason);
      const valueLabel = element("label", "schedule-value-label", "Valor propuesto");
      const value = element("textarea", "text-field schedule-value");
      value.rows = 2;
      value.maxLength = 2000;
      value.value = proposal.proposed_value ?? "";
      value.dataset.proposedValue = String(index);
      valueLabel.append(value);
      card.append(valueLabel);
      changesPanel.append(card);
    });

    for (const warning of data.warnings ?? []) {
      if (typeof warning === "string" && warning.trim()) {
        notes.append(element("p", "schedule-warning", warning));
      }
    }
    for (const item of data.unmapped_items ?? []) {
      if (item && typeof item.text === "string") {
        notes.append(
          element("p", "schedule-unmapped", `${item.text}${item.reason ? ` — ${item.reason}` : ""}`),
        );
      }
    }
    review.hidden = false;
    downloadButton.disabled = proposals.length === 0;
  };

  previewSheetSelect.addEventListener("change", renderTemplatePreview);

  templateInput.addEventListener("change", async () => {
    const requestId = ++previewRequest;
    const template = templateInput.files?.[0];
    proposals = [];
    previewSheets = [];
    templatePreview.hidden = true;
    review.hidden = true;
    errorPanel.hidden = true;
    if (!template) return;
    if (!template.name.toLowerCase().endsWith(".xlsx") || template.size > 20 * 1024 * 1024) {
      showError("La plantilla debe ser Excel .xlsx y no superar 20 MB.");
      return;
    }

    status.textContent = "Preparando vista previa de la plantilla…";
    try {
      const formData = new FormData();
      formData.append("template", template);
      const response = await fetch(page.dataset.previewUrl, {
        method: "POST",
        headers: { "X-CSRFToken": csrfToken },
        body: formData,
      });
      const result = await response.json();
      if (requestId !== previewRequest) return;
      if (!response.ok) throw new Error(result.error ?? "No se pudo leer la plantilla Excel.");
      setTemplatePreview(result);
      status.textContent = "Vista previa lista. Selecciona el PDF para preparar sugerencias.";
    } catch (error) {
      if (requestId !== previewRequest) return;
      showError(error instanceof Error ? error.message : "No se pudo mostrar la plantilla.");
      status.textContent = "";
    }
  });

  pdfInput.addEventListener("change", () => {
    proposals = [];
    review.hidden = true;
    previewDescription.textContent =
      "Revisa la plantilla original. Las sugerencias del PDF se marcarán aquí después del análisis.";
    renderTemplatePreview();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorPanel.hidden = true;
    review.hidden = true;
    const pdf = pdfInput.files?.[0];
    const template = templateInput.files?.[0];
    if (!pdf || !template) {
      showError("Selecciona el PDF fuente y la plantilla Excel para continuar.");
      return;
    }
    if (!pdf.name.toLowerCase().endsWith(".pdf") || pdf.size > 20 * 1024 * 1024) {
      showError("El documento debe ser PDF y no superar 20 MB.");
      return;
    }
    if (!template.name.toLowerCase().endsWith(".xlsx") || template.size > 20 * 1024 * 1024) {
      showError("La plantilla debe ser Excel .xlsx y no superar 20 MB.");
      return;
    }

    analyzeButton.disabled = true;
    status.textContent = "Leyendo la plantilla y analizando el PDF…";
    try {
      const response = await fetch(page.dataset.analyzeUrl, {
        method: "POST",
        headers: { "X-CSRFToken": csrfToken },
        body: new FormData(form),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "No se pudo analizar los archivos.");
      renderProposals(result);
      status.textContent = "Vista previa lista. El archivo original sigue intacto.";
    } catch (error) {
      showError(error instanceof Error ? error.message : "Ocurrió un error inesperado.");
      status.textContent = "";
    } finally {
      analyzeButton.disabled = false;
    }
  });

  downloadButton.addEventListener("click", async () => {
    const changes = proposals.flatMap((proposal, index) => {
      const approved = document.querySelector(`[data-approve-change="${index}"]`)?.checked;
      const value = document.querySelector(`[data-proposed-value="${index}"]`)?.value?.trim();
      return approved && value
        ? [{ sheet_name: proposal.sheet_name, ref: proposal.ref, proposed_value: value }]
        : [];
    });
    if (!changes.length) {
      showError("Selecciona al menos un cambio aprobado y con contenido.");
      return;
    }
    if (!window.confirm(`¿Aplicar ${changes.length} cambio(s) a una copia de la plantilla y descargar el Excel?`)) {
      return;
    }

    downloadButton.disabled = true;
    status.textContent = "Generando la copia del Excel…";
    errorPanel.hidden = true;
    try {
      const response = await fetch(page.dataset.downloadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrfToken,
        },
        body: JSON.stringify({ changes }),
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error ?? "No se pudo generar el Excel.");
      }
      const file = await response.blob();
      const objectUrl = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `${(templateInput.files?.[0]?.name ?? "cronograma.xlsx").replace(/\.xlsx$/i, "")}_completado.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      status.textContent = "Descarga lista. La plantilla original no se modificó.";
    } catch (error) {
      showError(error instanceof Error ? error.message : "Ocurrió un error inesperado.");
      status.textContent = "";
    } finally {
      downloadButton.disabled = false;
    }
  });
})();
