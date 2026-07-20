# Iframe Query Runtime Configuration

The host will pass `pluginId` and `apiBaseUrl` to a plugin workspace through iframe URL query parameters, and reload the iframe after a backend restart. This gives a workspace the configuration needed to call its own API without building a separate host-plugin RPC channel for startup metadata.
