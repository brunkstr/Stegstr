/**
 * Desktop (Tauri) platform: lazy-load Tauri APIs so web build never loads them.
 */

let cached: Promise<{
  invoke: typeof import("@tauri-apps/api/core").invoke;
  openDialog: typeof import("@tauri-apps/plugin-dialog").open;
  saveDialog: typeof import("@tauri-apps/plugin-dialog").save;
  getCurrentWindow: typeof import("@tauri-apps/api/window").getCurrentWindow;
}> | null = null;

export async function getTauri(): Promise<{
  invoke: typeof import("@tauri-apps/api/core").invoke;
  openDialog: typeof import("@tauri-apps/plugin-dialog").open;
  saveDialog: typeof import("@tauri-apps/plugin-dialog").save;
  getCurrentWindow: typeof import("@tauri-apps/api/window").getCurrentWindow;
}> {
  if (!cached) {
    cached = (async () => {
      const core = await import("@tauri-apps/api/core");
      const dialog = await import("@tauri-apps/plugin-dialog");
      const win = await import("@tauri-apps/api/window");
      return {
        invoke: core.invoke,
        openDialog: dialog.open,
        saveDialog: dialog.save,
        getCurrentWindow: win.getCurrentWindow,
      };
    })();
  }
  return cached;
}
