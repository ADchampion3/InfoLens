import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtimeOrigin = process.env.INFOLENS_RUNTIME_ORIGIN;

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
    ...(runtimeOrigin ? {
      proxy: {
        "/runtime-info.json": {
          target: runtimeOrigin,
          changeOrigin: true,
          rewrite: () => "/runtime/info",
        },
      },
    } : {}),
  },
});
