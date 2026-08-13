export function developmentLaunchConfig({ rendererPort, runtimePort }) {
  const runtimeOrigin = `http://127.0.0.1:${runtimePort}`;
  return {
    runtimeOrigin,
    viteEnvironment: {
      INFOLENS_RUNTIME_ORIGIN: runtimeOrigin,
    },
    electronEnvironment: {
      INFOLENS_RENDERER_URL: `http://127.0.0.1:${rendererPort}`,
      INFOLENS_RUNTIME_PORT: String(runtimePort),
    },
  };
}
