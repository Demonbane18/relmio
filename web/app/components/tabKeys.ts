/** The tab a key moves to in a horizontal tablist, or null when the key does
    not navigate tabs. The arrow keys wrap around; Home and End jump to the ends. */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
