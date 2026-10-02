import assert from "node:assert/strict";
import test from "node:test";
import { trappedFocusIndex } from "../app/components/dialogFocus.ts";

test("Tab and Shift+Tab wrap inside the sign-in dialog and pull outside focus back in", () => {
  // Six controls: the browser moves focus between them unaided.
  assert.equal(trappedFocusIndex(2, 6, false), null);
  assert.equal(trappedFocusIndex(2, 6, true), null);
  // The ends wrap instead of leaving for the page behind the dialog.
  assert.equal(trappedFocusIndex(5, 6, false), 0);
  assert.equal(trappedFocusIndex(0, 6, true), 5);
  // Focus outside the dialog (for example on the body) comes back in.
  assert.equal(trappedFocusIndex(-1, 6, false), 0);
  assert.equal(trappedFocusIndex(-1, 6, true), 5);
  assert.equal(trappedFocusIndex(-1, 0, false), null);
});
