import "./style.css";
import { bootUi } from "./ui";

try {
  bootUi();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown renderer error.";
  const root = document.body;
  root.innerHTML = `<div style="padding:16px;font:14px Segoe UI,sans-serif;color:#ddd;background:#222;height:100vh;">Renderer failed to initialize: ${message}</div>`;
  // Keep this console error so Electron terminal logging can surface it.
  // eslint-disable-next-line no-console
  console.error("Renderer failed to initialize", error);
}
