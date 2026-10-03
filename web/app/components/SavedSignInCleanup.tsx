"use client";

import { useState } from "react";

// Storage names the retired hosted sign-in (@openai-oauth/web 2.0.0) used.
const databaseName = "openai-oauth";
const pendingLoginKey = "openai-oauth:pending-login";

/** Deletes the old hosted chat sign-in from this browser and announces the
    result politely. It cannot revoke anything at OpenAI. */
export function SavedSignInCleanup() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  function remove() {
    try {
      window.sessionStorage.removeItem(pendingLoginKey);
    } catch {
      // Blocked storage means nothing was saved there.
    }
    if (typeof indexedDB === "undefined") {
      setMessage("This browser has no saved sign-in to remove.");
      return;
    }

    setBusy(true);
    setMessage("Removing the saved sign-in…");
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => {
      setBusy(false);
      setMessage("Saved sign-in removed from this browser.");
    };
    request.onerror = () => {
      setBusy(false);
      setMessage("Could not remove it. Clear this site's data in your browser settings.");
    };
    // Another open tab of this site still holds the database; deletion
    // finishes, and onsuccess fires, once that tab closes.
    request.onblocked = () => {
      setMessage("Close other tabs of this site to finish removing it.");
    };
  }

  return (
    <>
      <button className="rm-button rm-button--danger" type="button" aria-busy={busy || undefined} onClick={remove}>
        Remove saved sign-in from this browser
      </button>
      <p className="rm-small" role="status" aria-live="polite">
        {message}
      </p>
    </>
  );
}
