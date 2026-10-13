(() => {
  const dataElement = document.getElementById("review-data");
  const page = document.querySelector("[data-review-page]");
  const editor = document.querySelector("[data-section-editor]");
  const preview = document.querySelector("[data-final-preview]");
  const convertForm = document.querySelector("[data-conversion-form]");
  const payloadInput = document.querySelector("[data-conversion-payload]");

  if (!dataElement || !page || !editor || !preview || !convertForm || !payloadInput) {
    return;
  }

  let initialData;
  try {
    initialData = JSON.parse(dataElement.textContent ?? "");
  } catch {
    return;
  }

  const state = {
    title: initialData.title ?? "",
    topic: initialData.topic ?? "",
    executive_summary: initialData.executive_summary ?? "",
    sections: structuredClone(initialData.sections ?? []),
    mode: "intelligent",
    detail: "medium",
    format: "docx",
  };

  const titleInput = document.querySelector("[data-edit-title]");
  const topicInput = document.querySelector("[data-edit-topic]");
  const summaryInput = document.querySelector("[data-edit-summary]");
  const iframe = document.querySelector("[data-pdf-viewer]");
  const pageInput = document.querySelector("[data-page-input]");
  const searchInput = document.querySelector("[data-source-search]");
  const searchResults = document.querySelector("[data-search-results]");
  const downloadButton = document.querySelector("[data-confirm-conversion]");
  const conversionNote = document.querySelector("[data-conversion-note]");
  const tableHelp = document.querySelector("[data-table-help]");
  let currentPage = 1;
  let zoom = 100;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const makeSourceNote = (pages) => {
    if (!Array.isArray(pages) || pages.length === 0) {
      return "";
    }
    return pages.map((number) => `p. ${number}`).join(", ");
  };

  const parseTable = (value) => {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return null;
    }
    return {
      headers: lines[0].split("|").map((cell) => cell.trim()),
      rows: lines.slice(1).map((line) => line.split("|").map((cell) => cell.trim())),
    };
  };

  const createItemEditor = (section, item, itemIndex) => {
    const itemCard = element("div", "section-item");
    const itemHeader = element("div", "section-item-header");
    itemHeader.append(element("span", "item-index", `Elemento ${itemIndex + 1}`));
    const removeItem = element("button", "quiet-icon-button", "×");
    removeItem.type = "button";
    removeItem.setAttribute("aria-label", "Eliminar elemento");
    removeItem.addEventListener("click", () => {
      section.items.splice(itemIndex, 1);
      renderEditor();
      updatePreview();
    });
    itemHeader.append(removeItem);
    itemCard.append(itemHeader);

    const label = element("label", "editor-label", section.key === "tables" ? "Título y encabezados/filas de tabla" : "Subtítulo o punto");
    const headingInput = element("input", "text-field item-label-field");
    headingInput.type = "text";
    headingInput.maxLength = 1000;
    headingInput.value = item.label ?? "";
    headingInput.placeholder = "Ej. Fecha de vigencia";
    headingInput.addEventListener("input", () => {
      item.label = headingInput.value;
      updatePreview();
    });
    label.append(headingInput);
    itemCard.append(label);

    const valueLabel = element("label", "editor-label", section.key === "tables" ? "Datos · una fila por línea, celdas separadas por |" : "Contenido");
    const valueInput = element("textarea", "text-field item-value-field");
    valueInput.rows = section.key === "tables" ? 4 : 3;
    valueInput.maxLength = 12000;
    valueInput.value = item.value ?? "";
    valueInput.addEventListener("input", () => {
      item.value = valueInput.value;
      updatePreview();
    });
    valueLabel.append(valueInput);
    itemCard.append(valueLabel);

    if (Array.isArray(item.source_pages) && item.source_pages.length) {
      const citation = element("button", "source-citation", `Ver origen: ${makeSourceNote(item.source_pages)}`);
      citation.type = "button";
      citation.addEventListener("click", () => setCurrentPage(item.source_pages[0]));
      itemCard.append(citation);
    }
    return itemCard;
  };

  const renderEditor = () => {
    editor.replaceChildren();
    state.sections.forEach((section, sectionIndex) => {
      const card = element("article", "editable-section");
      const header = element("div", "editable-section-header");

      const includedLabel = element("label", "include-section");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = section.included !== false;
      checkbox.setAttribute("aria-label", `Incluir ${section.title}`);
      checkbox.addEventListener("change", () => {
        section.included = checkbox.checked;
        updatePreview();
      });
      includedLabel.append(checkbox, element("span", "", "Incluir"));
      header.append(includedLabel);

      const actions = element("div", "section-actions");
      const up = element("button", "quiet-icon-button", "↑");
      up.type = "button";
      up.setAttribute("aria-label", "Subir sección");
      up.disabled = sectionIndex === 0;
      up.addEventListener("click", () => moveSection(sectionIndex, -1));
      const down = element("button", "quiet-icon-button", "↓");
      down.type = "button";
      down.setAttribute("aria-label", "Bajar sección");
      down.disabled = sectionIndex === state.sections.length - 1;
      down.addEventListener("click", () => moveSection(sectionIndex, 1));
      actions.append(up, down);

      const deleteSection = element("button", "quiet-icon-button danger-icon", "×");
      deleteSection.type = "button";
      deleteSection.setAttribute("aria-label", "Eliminar sección");
      deleteSection.addEventListener("click", () => {
        state.sections.splice(sectionIndex, 1);
        renderEditor();
        updatePreview();
      });
      actions.append(deleteSection);

      const heading = element("div", "editable-heading");
      const titleInput = element("input", "text-field section-title-field");
      titleInput.type = "text";
      titleInput.maxLength = 300;
      titleInput.value = section.title ?? "";
      titleInput.setAttribute("aria-label", "Título de sección");
      titleInput.addEventListener("input", () => {
        section.title = titleInput.value;
        updatePreview();
      });
      heading.append(titleInput);
      if (actions.childElementCount) {
        heading.append(actions);
      }
      header.append(heading);
      card.append(header);

      const items = element("div", "section-items");
      (section.items ?? []).forEach((item, itemIndex) => {
        items.append(createItemEditor(section, item, itemIndex));
      });
      const addItem = element("button", "add-item-button", "+ Añadir punto");
      addItem.type = "button";
      addItem.addEventListener("click", () => {
        section.items ??= [];
        section.items.push({ label: "", value: "", source_pages: [] });
        renderEditor();
        updatePreview();
      });
      items.append(addItem);
      card.append(items);
      editor.append(card);
    });
  };

  function moveSection(index, offset) {
    const target = index + offset;
    if (target < 0 || target >= state.sections.length) {
      return;
    }
    [state.sections[index], state.sections[target]] = [state.sections[target], state.sections[index]];
    renderEditor();
    updatePreview();
  }

  const activeSections = () =>
    state.sections
      .filter((section) => section.included !== false)
      .map((section) => ({
        ...section,
        items: section.key === "executive_summary"
          ? [{ label: "", value: state.executive_summary }]
          : state.detail === "brief"
            ? section.items.slice(0, 4)
            : state.detail === "medium"
              ? section.items.slice(0, 10)
              : section.items,
      }))
      .filter((section) => section.items.length > 0);

  const sectionHasTableData = () =>
    activeSections().some((section) =>
      section.key === "tables" &&
      section.items.some((item) => {
        const lines = (item.value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        return lines.length >= 2 &&
          lines[0].split("|").some((cell) => cell.trim()) &&
          lines.slice(1).some((line) => line.split("|").some((cell) => cell.trim()));
      }),
    );

  const renderPreview = () => {
    preview.replaceChildren();
    const documentPreview = element("article", "preview-document");
    documentPreview.append(element("span", "preview-document-label", "VISTA PREVIA"));
    documentPreview.append(element("h3", "preview-document-title", state.title || "Documento sin título"));
    if (state.topic) {
      const topic = element("p", "preview-topic");
      topic.append(element("strong", "", "Tema principal: "), document.createTextNode(state.topic));
      documentPreview.append(topic);
    }

    if (state.mode === "complete") {
      documentPreview.append(element("h4", "preview-section-title", "Documento completo"));
      const allPages = Array.isArray(initialData.pages) ? initialData.pages : [];
      const fullText = allPages
        .map((text, index) => `Página ${index + 1}\n${text}`)
        .join("\n\n");
      const details = element("details", "complete-preview-details");
      const summary = element(
        "summary",
        "",
        `Vista del texto extraído · ${initialData.page_count} páginas`,
      );
      details.append(summary);
      const sourceText = element("pre", "complete-preview-text");
      sourceText.textContent = fullText.slice(0, 12000);
      if (fullText.length > 12000) {
        details.append(sourceText, element("p", "preview-truncation", "La vista se limita aquí a 12 000 caracteres; la conversión completa incluirá todo el texto extraído."));
      } else {
        details.append(sourceText);
      }
      documentPreview.append(details);
    } else {
      for (const section of activeSections()) {
        documentPreview.append(element("h4", "preview-section-title", section.title));
        for (const item of section.items) {
          const itemNode = element("div", "preview-item");
          if (item.label) {
            itemNode.append(element("strong", "preview-item-label", item.label));
          }
          if (section.key === "tables") {
            const tableData = parseTable(item.value);
            if (tableData) {
              const tableWrapper = element("div", "preview-table-wrap");
              const table = element("table", "preview-table");
              const header = element("thead");
              const headerRow = element("tr");
              for (const heading of tableData.headers) {
                headerRow.append(element("th", "", heading));
              }
              header.append(headerRow);
              const body = element("tbody");
              for (const row of tableData.rows) {
                const tableRow = element("tr");
                row.forEach((value) => tableRow.append(element("td", "", value)));
                body.append(tableRow);
              }
              table.append(header, body);
              tableWrapper.append(table);
              itemNode.append(tableWrapper);
            } else {
              itemNode.append(element("p", "preview-item-value", item.value));
            }
          } else {
            itemNode.append(element("p", "preview-item-value", item.value));
          }
          const citation = makeSourceNote(item.source_pages);
          if (citation) {
            itemNode.append(element("span", "preview-citation", `Fuente: ${citation}`));
          }
          documentPreview.append(itemNode);
        }
      }
      if (!activeSections().length) {
        documentPreview.append(element("p", "preview-empty", "Activa al menos una sección para incluir contenido."));
      }
    }
    preview.append(documentPreview);

    let selectedFormat =
      document.querySelector("[data-format-choice]:checked")?.value ?? "docx";
    const xlsxRadio = document.querySelector('[data-format-choice][value="xlsx"]');
    if (selectedFormat === "xlsx" && !sectionHasTableData()) {
      const docxRadio = document.querySelector('[data-format-choice][value="docx"]');
      if (docxRadio) {
        docxRadio.checked = true;
        selectedFormat = "docx";
        state.format = "docx";
      }
    }
    const mode = document.querySelector("[data-mode-choice]:checked")?.value ?? "intelligent";
    if (conversionNote) {
      if (mode === "complete" && selectedFormat === "pdf") {
        conversionNote.textContent = "El PDF original se descargará sin modificar.";
      } else if (mode === "complete") {
        conversionNote.textContent = "Se incluirá el texto extraído de todas las páginas. Imágenes, enlaces y diseño original no se reproducen en estos formatos.";
      } else if (selectedFormat === "xlsx") {
        conversionNote.textContent = "Se crearán hojas editables con las tablas seleccionadas. Las celdas se separan por | en el editor.";
      } else if (selectedFormat === "pdf") {
        conversionNote.textContent = "Se generará un PDF nuevo con las secciones incluidas en esta vista previa.";
      } else {
        conversionNote.textContent = "Solo las secciones seleccionadas se incluirán en el archivo final.";
      }
    }
    if (xlsxRadio) {
      xlsxRadio.disabled = !sectionHasTableData();
      xlsxRadio.closest(".format-choice")?.classList.toggle("is-unavailable", !sectionHasTableData());
    }
    if (tableHelp) {
      tableHelp.hidden = sectionHasTableData();
      tableHelp.textContent = sectionHasTableData()
        ? ""
        : "No se encontraron tablas exportables. Si el PDF contiene una tabla, usa «Agregar tabla» para organizarla y habilitar Excel.";
    }
  };

  function updatePreview() {
    state.title = titleInput.value;
    state.topic = topicInput.value;
    state.executive_summary = summaryInput.value;
    state.mode = document.querySelector("[data-mode-choice]:checked")?.value ?? "intelligent";
    state.detail = document.querySelector("[data-detail-choice]:checked")?.value ?? "medium";
    state.format = document.querySelector("[data-format-choice]:checked")?.value ?? "docx";
    renderPreview();
    payloadInput.value = JSON.stringify(state);
  }

  const setCurrentPage = (pageNumber) => {
    const maxPage = Math.max(1, Number(initialData.page_count) || 1);
    currentPage = Math.min(maxPage, Math.max(1, Number(pageNumber) || 1));
    if (pageInput) {
      pageInput.value = String(currentPage);
    }
    if (iframe) {
      iframe.src = `${initialData.preview_url}#page=${currentPage}&zoom=${zoom}`;
    }
  };

  const setSourceName = () => {
    const sourceName = document.querySelector("[data-source-name]");
    if (sourceName) {
      sourceName.textContent = initialData.filename ?? "documento.pdf";
      sourceName.title = initialData.filename ?? "documento.pdf";
    }
  };

  titleInput.value = state.title;
  topicInput.value = state.topic;
  summaryInput.value = state.executive_summary;
  setSourceName();
  renderEditor();
  updatePreview();

  for (const input of [titleInput, topicInput, summaryInput]) {
    input.addEventListener("input", updatePreview);
  }
  for (const input of document.querySelectorAll("[data-mode-choice], [data-detail-choice], [data-format-choice]")) {
    input.addEventListener("change", updatePreview);
  }

  document.querySelector("[data-add-section]")?.addEventListener("click", () => {
    let sequence = 1;
    while (state.sections.some((section) => section.key === `custom_${sequence}`)) {
      sequence += 1;
    }
    state.sections.push({
      key: `custom_${sequence}`,
      title: "Nueva sección",
      included: true,
      items: [{ label: "", value: "", source_pages: [] }],
    });
    renderEditor();
    updatePreview();
  });

  document.querySelector("[data-add-table]")?.addEventListener("click", () => {
    let section = state.sections.find((item) => item.key === "tables");
    if (!section) {
      section = {
        key: "tables",
        title: "Tablas",
        included: true,
        items: [],
      };
      state.sections.push(section);
    } else {
      section.included = true;
    }
    section.items.push({ label: "Nueva tabla", value: "", source_pages: [] });
    renderEditor();
    updatePreview();
    editor.querySelector(".item-value-field:last-child")?.focus();
  });

  document.querySelector("[data-restore-analysis]")?.addEventListener("click", () => {
    state.title = initialData.title ?? "";
    state.topic = initialData.topic ?? "";
    state.executive_summary = initialData.executive_summary ?? "";
    state.sections = structuredClone(initialData.sections ?? []);
    titleInput.value = state.title;
    topicInput.value = state.topic;
    summaryInput.value = state.executive_summary;
    renderEditor();
    updatePreview();
  });

  document.querySelector("[data-page-previous]")?.addEventListener("click", () => setCurrentPage(currentPage - 1));
  document.querySelector("[data-page-next]")?.addEventListener("click", () => setCurrentPage(currentPage + 1));
  pageInput?.addEventListener("change", () => setCurrentPage(pageInput.value));

  const zoomValue = document.querySelector("[data-zoom-value]");
  const updateZoom = (amount) => {
    zoom = Math.min(200, Math.max(50, zoom + amount));
    if (zoomValue) {
      zoomValue.textContent = `${zoom}%`;
    }
    setCurrentPage(currentPage);
  };
  document.querySelector("[data-zoom-in]")?.addEventListener("click", () => updateZoom(20));
  document.querySelector("[data-zoom-out]")?.addEventListener("click", () => updateZoom(-20));

  searchInput?.addEventListener("input", () => {
    searchResults.replaceChildren();
    const query = searchInput.value.trim().toLocaleLowerCase();
    if (query.length < 2) {
      return;
    }
    const matches = [];
    (initialData.pages ?? []).forEach((text, index) => {
      const lowered = text.toLocaleLowerCase();
      let start = 0;
      let found = lowered.indexOf(query);
      while (found !== -1 && matches.length < 20) {
        const snippetStart = Math.max(0, found - 65);
        const snippetEnd = Math.min(text.length, found + query.length + 90);
        matches.push({ page: index + 1, snippet: text.slice(snippetStart, snippetEnd).replace(/\s+/g, " ") });
        start = found + query.length;
        found = lowered.indexOf(query, start);
      }
    });
    if (!matches.length) {
      searchResults.append(element("p", "search-empty", "No se encontraron coincidencias."));
      return;
    }
    for (const match of matches) {
      const result = element("button", "search-result");
      result.type = "button";
      result.append(element("strong", "", `Página ${match.page}`), element("span", "", match.snippet));
      result.addEventListener("click", () => setCurrentPage(match.page));
      searchResults.append(result);
    }
  });

  convertForm.addEventListener("submit", (event) => {
    if (!state.title.trim()) {
      event.preventDefault();
      titleInput.focus();
      titleInput.setCustomValidity("Escribe un título antes de convertir.");
      titleInput.reportValidity();
      titleInput.addEventListener("input", () => titleInput.setCustomValidity(""), { once: true });
      return;
    }
    if (state.mode === "intelligent" && !activeSections().length) {
      event.preventDefault();
      window.alert("Incluye al menos una sección para convertir el análisis.");
      return;
    }
    if (state.format === "xlsx" && !sectionHasTableData()) {
      event.preventDefault();
      window.alert("Incluye una tabla con encabezados y filas para generar el Excel.");
      return;
    }
    if (!window.confirm(`¿Confirmas la conversión a ${state.format.toUpperCase()}?`)) {
      event.preventDefault();
      return;
    }
    updatePreview();
    payloadInput.value = JSON.stringify(state);
    if (downloadButton) {
      downloadButton.disabled = true;
      downloadButton.lastChild.textContent = " Generando archivo…";
    }
  });

  /* ── Expose internals for ai_chat.js ───────────────────── */
  window.__reviewState = state;
  window.__reviewRenderEditor = renderEditor;
  window.__reviewUpdatePreview = updatePreview;
})();
