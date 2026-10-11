import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDeviceCodeControls } from "../src/ui/device-code.js";
import { startIsolatedWizard } from "./helpers/siwc-wizard.js";

function harness(writeText, { selectionAvailable = true } = {}) {
  const copied = [];
  const selected = [];
  const events = {};
  let assignments = 0;
  let text = "";
  const code = {
    get textContent() { return text; },
    set textContent(value) { assignments++; text = value; },
    focus() { selected.push("focus"); },
    ownerDocument: {
      defaultView: { navigator: { clipboard: writeText === null ? null : {
        writeText: async (value) => { copied.push(value); await writeText?.(value); },
      } } },
      getSelection: () => selectionAvailable ? {
        removeAllRanges() {}, addRange() { selected.push("range"); },
      } : null,
      createRange: () => ({ selectNodeContents(element) { assert.equal(element, code); } }),
    },
  };
  const button = { disabled: true, addEventListener: (name, handler) => { events[name] = handler; } };
  const feedback = { textContent: "" };
  const controls = createDeviceCodeControls({ code, button, feedback });
  return { code, button, feedback, copied, selected, controls, assignments: () => assignments,
    click: (isTrusted = true) => events.click({ isTrusted }) };
}

test("rendering and synthetic clicks never copy; a user click copies the exact dummy code", async () => {
  const ui = harness();
  ui.controls.render("ABCD-1234");
  assert.deepEqual(ui.copied, []);
  await ui.click(false);
  assert.deepEqual(ui.copied, []);
  await ui.click();
  assert.deepEqual(ui.copied, ["ABCD-1234"]);
  assert.equal(ui.feedback.textContent, "Code copied.");
  assert.equal(ui.feedback.textContent.includes("ABCD"), false);
});

test("unchanged polls preserve the code node's selection and copy feedback", async () => {
  const ui = harness();
  ui.controls.render("ABCD-1234");
  await ui.click();
  const before = ui.assignments();
  ui.controls.render("ABCD-1234");
  assert.equal(ui.assignments(), before);
  assert.equal(ui.feedback.textContent, "Code copied.");
});

test("clipboard refusal or absence selects the code for a manual user copy", async (t) => {
  for (const writeText of [null, async () => { throw new Error("Denied"); }]) {
    await t.test(writeText ? "refused" : "unavailable", async () => {
      const ui = harness(writeText);
      ui.controls.render("ABCD-1234");
      await ui.click();
      assert.deepEqual(ui.selected, ["focus", "range"]);
      assert.equal(ui.feedback.textContent, "Clipboard unavailable. The code is selected; copy it manually.");
      assert.equal(ui.button.disabled, false);
    });
  }
});

test("missing selection support keeps a plain manual-copy recovery", async () => {
  const ui = harness(null, { selectionAvailable: false });
  ui.controls.render("ABCD-1234");
  await ui.click();
  assert.equal(ui.feedback.textContent, "Clipboard unavailable. Select the code, then copy it manually.");
});

test("a code cleared or changed during a pending copy cannot receive stale feedback", async (t) => {
  for (const next of ["", "WXYZ-5678"]) {
    await t.test(next ? "changed" : "cleared", async () => {
      let finish;
      const ui = harness(() => new Promise((resolve) => { finish = resolve; }));
      ui.controls.render("ABCD-1234");
      const pending = ui.click();
      assert.equal(ui.button.disabled, true);
      await ui.click();
      assert.equal(ui.copied.length, 1, "duplicate clicks do not copy");
      ui.controls.render(next);
      finish();
      await pending;
      assert.equal(ui.feedback.textContent, "");
      assert.equal(ui.button.disabled, !next);
    });
  }
});

test("local markup exposes keyboard, selectable code and polite feedback", async () => {
  const html = await readFile(new URL("../src/ui/local.html", import.meta.url), "utf8");
  assert.match(html, /<code id="installed-images-code"[^>]*tabindex="0"[^>]*translate="no"/u);
  assert.match(html, /<button id="installed-images-copy"[^>]*type="button"[^>]*aria-label="Copy sign-in code"/u);
  assert.match(html, /id="installed-images-copy-status"[^>]*role="status"[^>]*aria-live="polite"/u);
});

test("the wizard serves the exact device-code module imported by the local page", async (t) => {
  const wizard = await startIsolatedWizard({ sessionToken: "fixture-device-code-session-12345678901234567890" });
  t.after(() => wizard.close());
  const response = await fetch(`${wizard.origin}/device-code.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await response.text(), await readFile(new URL("../src/ui/device-code.js", import.meta.url), "utf8"));
});
