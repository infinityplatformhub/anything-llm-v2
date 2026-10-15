// Restore same-page private context when the agent's socket has expired.
// Thought bubbles and transport/status events are not conversation messages.
export function conversationHistoryForAgent(history, currentMessage) {
  if (currentMessage.trim() === "/reset") return [];
  const messages = history
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim() &&
        !message.pending &&
        (!message.type || message.type === "textResponse")
    )
    .map(({ role, content }) => ({ role, content }));
  const last = messages[messages.length - 1];
  // The opening prompt is already sent separately and started by the server.
  if (last?.role === "user" && last.content === currentMessage) messages.pop();
  return messages.slice(-40);
}
