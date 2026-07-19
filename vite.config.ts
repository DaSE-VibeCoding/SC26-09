import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
        },
      },
    },
  },
  server: {
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
