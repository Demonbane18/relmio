import { bindWizardNavigation } from "./session.js";

// Shared behavior for the wizard top bar described in DESIGN.md. Every wizard
// page renders the same markup and calls initWizardTopbar once it has its
// session. Theme radios are handled separately by theme.js.

function formatStars(stars) {
  return new Intl.NumberFormat("en", {
    notation: stars >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(stars);
}

export function renderRepositoryMeta(root, meta) {
  const stars = Number.isSafeInteger(meta?.stars) && meta.stars >= 0 ? meta.stars : null;
  const version = typeof meta?.version === "string" ? meta.version : null;
  for (const output of root.querySelectorAll("[data-rm-repo-stars]")) {
    output.textContent = stars === null ? "?" : formatStars(stars);
  }
  for (const link of root.querySelectorAll("[data-rm-repo-link]")) {
    const label = [
      version ? `Open Relmio version ${version} on GitHub.` : "Open Relmio on GitHub.",
      stars === null ? "GitHub star count is unavailable." : `${stars} GitHub stars.`,
      "Opens in a new tab.",
    ];
    link.setAttribute("aria-label", label.join(" "));
  }
}

function enhanceMenu(menu, browserDocument) {
  const summary = menu.querySelector(":scope > summary");
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    menu.open = false;
    summary?.focus();
  });
  menu.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a")) menu.open = false;
  });
  browserDocument.addEventListener("click", (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) {
      menu.open = false;
    }
  });
}

/**
 * Wire the shared top bar.
 * - Links marked data-wizard-route="/path" keep the private session.
 * - While isBusy() returns true, route links do nothing, so an operation is
 *   never abandoned mid-write.
 * - The compact <details class="rm-menu"> closes on Escape, outside clicks and
 *   link activation.
 * - When loadProjectMeta is given, the GitHub chip shows stars and version.
 */
export function initWizardTopbar({
  session,
  isBusy = () => false,
  loadProjectMeta,
  root = document,
} = {}) {
  for (const link of root.querySelectorAll("[data-wizard-route]")) {
    link.addEventListener("click", (event) => {
      if (isBusy()) event.preventDefault();
    });
    bindWizardNavigation(link, link.getAttribute("data-wizard-route"), session);
  }

  for (const menu of root.querySelectorAll("details.rm-menu")) {
    enhanceMenu(menu, root.ownerDocument ?? root);
  }

  if (typeof loadProjectMeta === "function") {
    Promise.resolve()
      .then(loadProjectMeta)
      .then((meta) => renderRepositoryMeta(root, meta))
      .catch(() => {});
  }
}
