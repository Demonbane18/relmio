/** The control that Tab or Shift+Tab must move to so focus stays inside a
    modal dialog, or null when the browser's own move already stays inside.
    `current` is -1 when focus is outside the dialog. */
export function trappedFocusIndex(current: number, count: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (backwards) return current <= 0 ? count - 1 : null;
  return current === -1 || current === count - 1 ? 0 : null;
}

/** Keyboard support for the sign-in extension dialog that @openai-oauth/react
    renders without any: focus moves to its first button, Tab stays inside,
    Escape presses its own Cancel, and focus returns to the trigger when the
    returned cleanup runs. Its new-tab links also announce the new tab. */
export function holdDialogFocus(dialog: HTMLElement, trigger: HTMLElement) {
  const buttons = dialog.querySelectorAll("button");
  // The library renders "Continue to …" first and "Cancel" last.
  const cancel = buttons[buttons.length - 1];

  for (const link of dialog.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
    // Text nodes only: the "open source" link adds a decorative arrow.
    const label = Array.from(link.childNodes, (node) =>
      node.nodeType === Node.TEXT_NODE ? node.textContent : "",
    ).join("").trim();
    link.setAttribute("aria-label", `${label} (opens in a new tab)`);
    link.relList.add("noopener");
    if (!link.querySelector('[aria-hidden="true"]')) {
      const icon = document.createElement("span");
      icon.className = "rm-icon rm-icon--external rm-icon--xs";
      icon.setAttribute("aria-hidden", "true");
      link.append(icon);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel?.click();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)"));
    if (controls.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const next = trappedFocusIndex(
      controls.indexOf(document.activeElement as HTMLElement),
      controls.length,
      event.shiftKey,
    );
    if (next === null) return;
    event.preventDefault();
    controls[next].focus();
  }

  if (buttons.length === 0) dialog.tabIndex = -1;
  (buttons[0] ?? dialog).focus();
  document.addEventListener("keydown", onKeyDown);
  return () => {
    document.removeEventListener("keydown", onKeyDown);
    trigger.focus();
  };
}
