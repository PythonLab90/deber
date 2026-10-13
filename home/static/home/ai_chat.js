/**
 * ai_chat.js
 * AI Assistant panel logic for the review page.
 * Communicates with /ai-chat/ endpoint, allows users to ask questions about
 * the PDF and add AI responses as new sections in the document editor.
 */
(() => {
  /* ── DOM references ────────────────────────────────────── */
  const messagesContainer = document.querySelector("[data-chat-messages]");
  const chatInput = document.querySelector("[data-chat-input]");
  const chatSendButton = document.querySelector("[data-chat-send]");
  const chatStatus = document.querySelector("[data-chat-status]");

  if (!messagesContainer || !chatInput || !chatSendButton) return;

  const AI_CHAT_URL = window.AI_CHAT_URL || "/ai-chat/";
  const CSRF_TOKEN = window.CSRF_TOKEN || "";

  /* ── Conversation state ────────────────────────────────── */
  const conversationHistory = [];
  let isBusy = false;

  /* ── Tiny element helper ───────────────────────────────── */
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* ── Format plain text → simple HTML ──────────────────── */
  const formatAnswer = (text) => {
    // Escape HTML first
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return escaped
      // **bold**
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // Numbered list items at line start
      .replace(/^(\d+)\.\s+/gm, "<span class='list-num'>$1.</span> ")
      // Bullet items
      .replace(/^[-•]\s+/gm, "<span class='list-bullet'>•</span> ")
      // Source page citations → highlight
      .replace(/\(Páginas? [\d,\s-]+\)/g, (m) => `<cite class="chat-cite">${m}</cite>`)
      // External source tag
      .replace(/\[Fuente externa\]/g, "<mark class=\"chat-ext-source\">[Fuente externa]</mark>")
      // Line breaks
      .replace(/\n/g, "<br>");
  };

  /* ── Scroll to the bottom of the messages container ───── */
  const scrollDown = () => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  };

  /* ── Dismiss the welcome screen on first message ───────── */
  const dismissWelcome = () => {
    const welcome = messagesContainer.querySelector(".chat-welcome");
    if (welcome) welcome.remove();
  };

  /* ── Append a user bubble ──────────────────────────────── */
  const appendUserMessage = (text) => {
    dismissWelcome();
    const bubble = el("div", "chat-bubble chat-bubble--user");
    bubble.textContent = text;
    messagesContainer.append(bubble);
    scrollDown();
  };

  /* ── Append an AI answer bubble with action buttons ────── */
  const appendAIMessage = (answer) => {
    const wrapper = el("div", "chat-bubble chat-bubble--ai");

    const content = el("div", "chat-bubble-content");
    content.innerHTML = formatAnswer(answer);
    wrapper.append(content);

    // Action toolbar
    const toolbar = el("div", "chat-bubble-actions");

    // ── Add as new section ──────────────────────────────────
    const addNewBtn = el("button", "chat-action-btn chat-action-btn--primary", "＋ Agregar al documento");
    addNewBtn.type = "button";
    addNewBtn.title = "Insertar como nuevo apartado en el editor";
    addNewBtn.addEventListener("click", () => openAddToDocDialog(answer, wrapper));
    toolbar.append(addNewBtn);

    // ── Copy ────────────────────────────────────────────────
    const copyBtn = el("button", "chat-action-btn", "⎘ Copiar");
    copyBtn.type = "button";
    copyBtn.title = "Copiar respuesta al portapapeles";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(answer).then(() => {
        copyBtn.textContent = "✓ Copiado";
        setTimeout(() => { copyBtn.textContent = "⎘ Copiar"; }, 1800);
      });
    });
    toolbar.append(copyBtn);

    // ── Discard (hide) ───────────────────────────────────────
    const discardBtn = el("button", "chat-action-btn chat-action-btn--muted", "✕ Descartar");
    discardBtn.type = "button";
    discardBtn.title = "Eliminar esta respuesta de la conversación";
    discardBtn.addEventListener("click", () => {
      wrapper.style.transition = "opacity 0.3s";
      wrapper.style.opacity = "0";
      setTimeout(() => wrapper.remove(), 300);
    });
    toolbar.append(discardBtn);

    wrapper.append(toolbar);
    messagesContainer.append(wrapper);
    scrollDown();
  };

  /* ── Error bubble ──────────────────────────────────────── */
  const appendErrorMessage = (message) => {
    const bubble = el("div", "chat-bubble chat-bubble--error");
    bubble.innerHTML = `<strong>Error:</strong> ${message}`;
    messagesContainer.append(bubble);
    scrollDown();
  };

  /* ── "Add to document" dialog ──────────────────────────── */
  const openAddToDocDialog = (answer, wrapper) => {
    // Remove any previous dialog
    document.querySelector(".chat-add-dialog")?.remove();

    const dialog = el("div", "chat-add-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "chat-dialog-title");

    dialog.innerHTML = `
      <div class="chat-add-dialog-inner">
        <h3 id="chat-dialog-title" class="chat-add-dialog-title">Agregar respuesta al documento</h3>

        <label class="chat-add-label" for="chat-add-section-title">Título del apartado</label>
        <input
          id="chat-add-section-title"
          class="text-field chat-add-input"
          type="text"
          maxlength="300"
          placeholder="Ej. Puntos importantes, Explicación adicional…"
          value="Respuesta del asistente"
        >

        <label class="chat-add-label" for="chat-add-content">Contenido (editable antes de agregar)</label>
        <textarea
          id="chat-add-content"
          class="text-field chat-add-textarea"
          rows="7"
          maxlength="12000"
        ></textarea>

        <div class="chat-add-actions">
          <button class="primary-button" id="chat-add-confirm" type="button">Agregar al documento</button>
          <button class="text-button" id="chat-add-cancel" type="button">Cancelar</button>
        </div>
      </div>
    `;

    dialog.querySelector("#chat-add-content").value = answer;
    document.body.append(dialog);

    // Focus first field
    const titleInput = dialog.querySelector("#chat-add-section-title");
    titleInput.focus();
    titleInput.select();

    // Confirm
    dialog.querySelector("#chat-add-confirm").addEventListener("click", () => {
      const title = dialog.querySelector("#chat-add-section-title").value.trim() || "Respuesta del asistente";
      const content = dialog.querySelector("#chat-add-content").value.trim();
      if (!content) {
        dialog.querySelector("#chat-add-content").focus();
        return;
      }
      addSectionToEditor(title, content);
      dialog.remove();

      // Visual feedback on the bubble
      const badge = el("span", "chat-bubble-added-badge", "✓ Agregado al documento");
      wrapper.prepend(badge);
    });

    // Cancel
    dialog.querySelector("#chat-add-cancel").addEventListener("click", () => dialog.remove());

    // Close on backdrop click
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.remove(); });

    // Close on Escape
    const onEsc = (e) => { if (e.key === "Escape") { dialog.remove(); document.removeEventListener("keydown", onEsc); } };
    document.addEventListener("keydown", onEsc);
  };

  /* ── Insert a new custom section into the review editor ── */
  const addSectionToEditor = (title, content) => {
    // Access the shared state exposed by review.js
    if (!window.__reviewState) {
      console.warn("ai_chat.js: window.__reviewState not found. Section not added.");
      return;
    }
    const state = window.__reviewState;
    const sequence = state.sections.filter((s) => s.key.startsWith("custom_")).length + 1;
    state.sections.push({
      key: `custom_${sequence}_${Date.now()}`,
      title,
      included: true,
      items: [{ label: "", value: content, source_pages: [] }],
    });
    // Trigger re-render via the shared render functions
    if (typeof window.__reviewRenderEditor === "function") window.__reviewRenderEditor();
    if (typeof window.__reviewUpdatePreview === "function") window.__reviewUpdatePreview();

    // Scroll the editor card into view
    const editorCard = document.querySelector(".editor-card");
    if (editorCard) editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* ── Send question to the backend ─────────────────────── */
  const sendQuestion = async (question) => {
    if (isBusy || !question.trim()) return;
    isBusy = true;

    appendUserMessage(question);
    chatInput.value = "";
    chatInput.style.height = "";

    // Show typing indicator
    const typing = el("div", "chat-bubble chat-bubble--ai chat-typing", "");
    typing.innerHTML = "<span></span><span></span><span></span>";
    messagesContainer.append(typing);
    scrollDown();

    if (chatStatus) chatStatus.textContent = "El asistente está pensando…";
    if (chatSendButton) chatSendButton.disabled = true;
    chatInput.disabled = true;

    try {
      const response = await fetch(AI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": CSRF_TOKEN,
        },
        body: JSON.stringify({
          question,
          history: conversationHistory.slice(-20),
        }),
      });

      typing.remove();

      if (!response.ok) {
        let errMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          errMsg = errData.error || errMsg;
        } catch { /* ignore */ }
        appendErrorMessage(errMsg);
      } else {
        const data = await response.json();
        const answer = (data.answer || "").trim();
        if (!answer) {
          appendErrorMessage("El asistente devolvió una respuesta vacía.");
        } else {
          // Store in history
          conversationHistory.push({ role: "user", content: question });
          conversationHistory.push({ role: "assistant", content: answer });
          appendAIMessage(answer);
        }
      }
    } catch (err) {
      typing.remove();
      appendErrorMessage("No se pudo conectar con el asistente. Comprueba la conexión.");
      console.error("ai_chat fetch error:", err);
    } finally {
      isBusy = false;
      if (chatStatus) chatStatus.textContent = "";
      if (chatSendButton) chatSendButton.disabled = false;
      chatInput.disabled = false;
      chatInput.focus();
    }
  };

  /* ── Event bindings ────────────────────────────────────── */

  // Send button click
  chatSendButton.addEventListener("click", () => sendQuestion(chatInput.value.trim()));

  // Enter key (without Shift) submits; Shift+Enter adds a new line
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion(chatInput.value.trim());
    }
  });

  // Auto-grow textarea
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;
  });

  // Quick suggestion chips
  document.querySelectorAll("[data-suggestion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      sendQuestion(btn.textContent.trim());
    });
  });
})();
