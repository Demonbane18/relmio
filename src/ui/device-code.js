function selectCode(code) {
  code.focus({ preventScroll: true });
  const document = code.ownerDocument;
  const selection = document?.getSelection?.();
  if (!selection || !document.createRange) return false;
  const range = document.createRange();
  range.selectNodeContents(code);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

// Codes stay in their existing DOM view. Only a trusted user click writes to
// the clipboard; rendering, polling and synthetic clicks never copy anything.
export function createDeviceCodeControls({ code, button, feedback }) {
  let revision = 0;
  let copying = false;

  function render(value) {
    if (code.textContent !== value) {
      revision += 1;
      code.textContent = value;
      feedback.textContent = "";
      copying = false;
    }
    button.disabled = !value || copying;
  }

  button.addEventListener("click", async (event) => {
    if (!event.isTrusted || button.disabled || !code.textContent) return;
    const value = code.textContent;
    const current = revision;
    copying = true;
    button.disabled = true;
    feedback.textContent = "";
    try {
      const clipboard = code.ownerDocument?.defaultView?.navigator?.clipboard;
      if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await clipboard.writeText(value);
      if (current === revision) feedback.textContent = "Code copied.";
    } catch {
      if (current === revision) {
        let selected = false;
        try { selected = selectCode(code); } catch { /* Manual selection remains available. */ }
        feedback.textContent = selected
          ? "Clipboard unavailable. The code is selected; copy it manually."
          : "Clipboard unavailable. Select the code, then copy it manually.";
      }
    } finally {
      if (current === revision) {
        copying = false;
        button.disabled = !code.textContent;
      }
    }
  });

  render(code.textContent);
  return { render };
}
