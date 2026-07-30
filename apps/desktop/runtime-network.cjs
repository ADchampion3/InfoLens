function firstHttpProxy(proxyRules) {
  for (const rule of String(proxyRules ?? "").split(";")) {
    const match = rule.trim().match(/^(?:PROXY|HTTPS?|HTTP)\s+([^\s]+)$/i);
    if (match) return match[1];
  }
  return undefined;
}

function runtimeProxyEnvironment(environment, proxyRules) {
  const inherited = environment.HTTPS_PROXY ?? environment.https_proxy
    ?? environment.HTTP_PROXY ?? environment.http_proxy;
  if (inherited) return { NODE_USE_ENV_PROXY: "1" };

  const authority = firstHttpProxy(proxyRules);
  if (!authority) return {};
  const proxy = /^[a-z]+:\/\//i.test(authority) ? authority : `http://${authority}`;
  return { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
}

module.exports = { firstHttpProxy, runtimeProxyEnvironment };
