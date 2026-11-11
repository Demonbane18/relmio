export function formatAuthUpdatedAt(
  value,
  { locale, timeZone } = {},
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

// A short local date and time for people, or "" when the value is not a date.
// Show it inside <time datetime="ISO"> so the exact instant stays in the page.
export function formatLocalDateTime(value) {
  const date = new Date(value ?? NaN);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
