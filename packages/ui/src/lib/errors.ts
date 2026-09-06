/**
 * Error-to-copy mapping shared by every surface that shows a failure to the
 * user. Raw `error.message` leaks implementation detail ("TypeError: Failed
 * to fetch", "[object Object]"); this keeps server-provided messages, which
 * are written for users, and translates the technical ones.
 */

const NETWORK_RE = /failed to fetch|network ?error|fetch failed|load failed|ECONNREFUSED|ERR_CONNECTION/i;
const ABORT_RE = /\baborted?\b|abort ?error/i;

export const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";

export function toFriendlyMessage(
  error: unknown,
  fallback: string = DEFAULT_ERROR_MESSAGE,
): string {
  // Anything message-shaped counts (DOMException is not an Error everywhere).
  const raw =
    typeof error === "string"
      ? error
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : "";
  if (!raw || raw === "[object Object]") return fallback;
  if (NETWORK_RE.test(raw)) {
    return "Could not reach the server. Check that it is running and try again.";
  }
  if (ABORT_RE.test(raw)) return "The request was cancelled.";
  // Drop a leaked error-class prefix; the message itself is usually usable.
  const cleaned = raw.replace(/^(?:[A-Z][a-zA-Z]*Error|Error):\s*/, "").trim();
  return cleaned || fallback;
}

/**
 * Extract structured debug information from an error for developer-facing
 * display. Returns a string suitable for a "Debug info" panel or tooltip.
 */
export function toDebugDetails(error: unknown): string {
  if (!error) return "No error details available.";

  const parts: string[] = [];

  // ApiClientError has status + detail
  const apiErr = error as { status?: number; detail?: string; message?: string };
  if (apiErr.status) {
    parts.push(`HTTP ${apiErr.status}`);
  }
  if (apiErr.detail) {
    parts.push(`Detail: ${apiErr.detail}`);
  }
  if (apiErr.message && apiErr.message !== apiErr.detail) {
    parts.push(`Message: ${apiErr.message}`);
  }

  // Extract SQL/traceback info if present
  const raw = apiErr.message || String(error);
  const sqlMatch = raw.match(/\[SQL:.*?\]/);
  if (sqlMatch) {
    parts.push(`SQL: ${sqlMatch[0]}`);
  }
  const fkMatch = raw.match(/FOREIGN KEY constraint failed/i);
  if (fkMatch) {
    parts.push("Cause: FOREIGN KEY constraint — parent row has dependent children.");
  }

  if (parts.length === 0) {
    parts.push(raw.slice(0, 500));
  }

  return parts.join("\n");
}
