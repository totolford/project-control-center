import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and no browser auto-open.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] } },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome110", sourcemap: false, outDir: "dist" },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
