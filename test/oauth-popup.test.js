import assert from "node:assert/strict";
import test from "node:test";

import { prepareOAuthPopup } from "../src/ui/oauth-popup.js";

test("OAuth popup shows a preparing state before its remote navigation", () => {
  const elements = [];
  const body = {
    replaceChildren(...children) {
      elements.splice(0, elements.length, ...children);
    },
  };
  const popupDocument = {
    title: "",
    body,
    createElement(tagName) {
      return { tagName, textContent: "" };
    },
  };

  assert.equal(prepareOAuthPopup({ document: popupDocument }), true);
  assert.equal(popupDocument.title, "Preparing ChatGPT sign-in");
  assert.deepEqual(elements, [
    { tagName: "h1", textContent: "Preparing ChatGPT sign-in…" },
    {
      tagName: "p",
      textContent: "Relmio is creating a fresh sign-in link.",
    },
  ]);
});

test("OAuth popup preparation tolerates blocked or unavailable windows", () => {
  assert.equal(prepareOAuthPopup(null), false);
  assert.equal(
    prepareOAuthPopup({
      get document() {
        throw new Error("window is unavailable");
      },
    }),
    false,
  );
});
