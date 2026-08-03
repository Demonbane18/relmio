export function prepareOAuthPopup(loginWindow) {
  if (!loginWindow) {
    return false;
  }

  try {
    const popupDocument = loginWindow.document;
    const heading = popupDocument.createElement("h1");
    const detail = popupDocument.createElement("p");
    heading.textContent = "Preparing ChatGPT sign-in…";
    detail.textContent = "Relmio is creating a fresh sign-in link.";
    popupDocument.title = "Preparing ChatGPT sign-in";
    popupDocument.body.replaceChildren(heading, detail);
    return true;
  } catch {
    return false;
  }
}
