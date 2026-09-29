import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs separately (uvicorn); STUDIO_API points the proxy at it.
// changeOrigin stays false: the API refuses changes whose Origin differs from the Host it receives.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.STUDIO_API ?? "http://127.0.0.1:4747", changeOrigin: false } },
  },
});
