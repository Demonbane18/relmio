import assert from "node:assert/strict";
import test from "node:test";
import { prepareSiwcBrowser } from "../src/ui/siwc-controls.js";

const attemptId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
function fixture() {
  const calls = [];
  const popup = { opener: {}, closed: false, close() { calls.push("close"); },
    location: { replace(value) { calls.push(["navigate", value]); } } };
  const browser = { open(...args) { calls.push(["open", ...args]); return popup; } };
  return { calls, popup, browser };
}

test("sign-in reserves a same-browser tab synchronously, severs opener and sends no wizard capability", () => {
  const f = fixture();
  const launch = prepareSiwcBrowser(f.browser);
  assert.deepEqual(f.calls, [["open", "about:blank", "_blank"]]);
  assert.equal(f.popup.opener, null);
  assert.equal(launch.launchMode, "same-browser");
  launch.launch({ launchMode: "same-browser", attemptId });
  launch.closeUnused();
  assert.deepEqual(f.calls[1], ["navigate", `/__relmio/oauth/launch/${attemptId}`]);
  assert.equal(f.calls.includes("close"), false);
});

test("blocked or unavailable pop-ups use the system browser without another attempt", () => {
  for (const browser of [undefined, { open() { return null; } }, { open() { throw new Error("blocked"); } }]) {
    const launch = prepareSiwcBrowser(browser);
    assert.equal(launch.launchMode, "system-browser");
    launch.launch({ launchMode: "system-browser", attemptId });
    launch.closeUnused();
  }
});

test("failed start or existing pending flow closes only the unused tab", () => {
  const f = fixture();
  const launch = prepareSiwcBrowser(f.browser);
  launch.closeUnused();
  assert.equal(f.calls.includes("close"), true);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "navigate"), false);
});

test("closed tab and untrusted launch results never navigate", () => {
  for (const result of [{ launchMode: "popup", attemptId },
    { launchMode: "same-browser", attemptId: "https://evil.example" },
    { launchMode: "same-browser", attemptId: `${attemptId}?session=private` }]) {
    const f = fixture();
    assert.throws(() => prepareSiwcBrowser(f.browser).launch(result), /unavailable/u);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  const launch = prepareSiwcBrowser(f.browser);
  f.popup.closed = true;
  assert.throws(() => launch.launch({ launchMode: "same-browser", attemptId }), /unavailable/u);
});
