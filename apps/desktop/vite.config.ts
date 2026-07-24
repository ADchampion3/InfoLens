import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: directory,
  plugins: [react()],
  base: "./",
  build: {
    outDir: path.resolve(directory, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
  },
});
