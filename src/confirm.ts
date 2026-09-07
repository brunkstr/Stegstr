/**
 * confirmDialog — a confirmation that actually waits for the answer.
 *
 * In a browser, window.confirm blocks and returns a boolean. Inside the Tauri
 * webview the dialog plugin replaces window.confirm with an ASYNC function that
 * returns a Promise, so `if (!window.confirm(msg)) return;` never blocks: a
 * Promise is truthy, the code proceeds while the dialog is still open, and
 * Cancel has no effect. That is the inherited "Cancel still converts the
 * identity" bug. Awaiting the result works in both environments.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  const result: unknown = window.confirm(message);
  return Boolean(await Promise.resolve(result));
}
