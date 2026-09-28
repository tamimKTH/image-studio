import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs separately (uvicorn); STUDIO_API points the proxy at it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": process.env.STUDIO_API ?? "http://127.0.0.1:4747" } },
});
