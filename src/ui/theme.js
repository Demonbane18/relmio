const colorModes = new Set(["system", "light", "dark"]);
const storageKey = "relmio-color-mode";

function applyMode(mode) {
  if (mode === "light" || mode === "dark") {
    document.documentElement.dataset.theme = mode;
  } else {
    delete document.documentElement.dataset.theme;
  }

  document
    .querySelectorAll('input[name="color-theme"]')
    .forEach((input) => {
      input.checked = input.value === mode;
    });
}

let initialMode = "system";

try {
  const savedMode = window.localStorage.getItem(storageKey);
  if (colorModes.has(savedMode)) {
    initialMode = savedMode;
  }
} catch {
  // System mode remains available when browser storage is unavailable.
}

applyMode(initialMode);

document
  .querySelectorAll('input[name="color-theme"]')
  .forEach((input) => {
    input.addEventListener("change", () => {
      if (!input.checked || !colorModes.has(input.value)) return;

      applyMode(input.value);
      try {
        window.localStorage.setItem(storageKey, input.value);
      } catch {
        // The selection still applies for this page view.
      }
    });
  });

window.addEventListener("storage", (event) => {
  if (event.key === storageKey) {
    applyMode(colorModes.has(event.newValue) ? event.newValue : "system");
  }
});
