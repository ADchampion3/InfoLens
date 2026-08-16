import { randomUUID } from "node:crypto";

export function developmentLaunchConfig({ rendererPort, runtimePort }) {
  const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
  const applicationSessionId = `dev-${randomUUID()}`;
  return {
    runtimeOrigin,
    viteEnvironment: {
      INFOLENS_RUNTIME_ORIGIN: runtimeOrigin,
      INFOLENS_APPLICATION_SESSION_ID: applicationSessionId,
      VITE_INFOLENS_RUNTIME_TOKEN: applicationSessionId,
    },
    electronEnvironment: {
      INFOLENS_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
      INFOLENS_RUNTIME_PORT: String(runtimePort),
      INFOLENS_APPLICATION_SESSION_ID: applicationSessionId,
    },
  };
}
