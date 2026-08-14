import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Connect, Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runtimeOrigin = process.env.INFOLENS_RUNTIME_ORIGIN;
const runtimeInfoProxy = runtimeOrigin ? {
  "/runtime-info.json": {
    target: runtimeOrigin,
    changeOrigin: true,
    rewrite: () => "/runtime/info",
  },
} : undefined;

function missingRuntimeOriginMiddleware(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
  if (req.url?.split("?", 1)[0] !== "/runtime-info.json") {
    next();
    return;
  }
  res.statusCode = 503;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({
    code: "RUNTIME_ORIGIN_NOT_CONFIGURED",
    error: "Plugin Runtime origin is not configured.",
  }));
}

function runtimeInfoEndpoint(): Plugin {
  return {
    name: "infolens-runtime-info-endpoint",
    configureServer(server) {
      if (!runtimeOrigin) server.middlewares.use(missingRuntimeOriginMiddleware);
    },
    configurePreviewServer(server) {
      if (!runtimeOrigin) server.middlewares.use(missingRuntimeOriginMiddleware);
    },
  };
}

export default defineConfig({
  root: directory,
  plugins: [react(), runtimeInfoEndpoint()],
  base: "./",
  build: {
    outDir: path.resolve(directory, "dist"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    ...(runtimeInfoProxy ? { proxy: runtimeInfoProxy } : {}),
  },
  preview: runtimeInfoProxy ? { proxy: runtimeInfoProxy } : {},
});
