export const INITIAL_CHAT_TESTER_FEEDBACK = Object.freeze({
  phase: "Ready",
  receivedText: false,
  turnStatus: "waiting",
});

export function nextChatTesterFeedback(current, event) {
  if (event.type === "send") {
    return { phase: "Sending", receivedText: false, turnStatus: "waiting" };
  }
  if (event.type === "accepted") {
    return { ...current, phase: "Connecting" };
  }
  if (event.type === "progress") {
    if (current.receivedText) return { ...current };
    const waiting = current.phase === "Waiting" || event.upstreamPhase === "working";
    return { ...current, phase: waiting ? "Waiting" : "Connecting" };
  }
  if (event.type === "delta") {
    if (event.text.length === 0) return { ...current };
    return { phase: "Streaming", receivedText: true, turnStatus: "streaming" };
  }
  if (event.type === "complete") {
    return { ...current, phase: "Complete", turnStatus: "complete" };
  }
  if (event.type === "failed") {
    return {
      ...current,
      phase: "Failed",
      turnStatus: current.receivedText ? "incomplete" : "failed",
    };
  }
  if (event.type === "stopping") {
    return { ...current, phase: "Stopping", turnStatus: "stopped" };
  }
  if (event.type === "stopped") {
    return { ...current, phase: "Stopped", turnStatus: "stopped" };
  }
  return { ...current };
}
