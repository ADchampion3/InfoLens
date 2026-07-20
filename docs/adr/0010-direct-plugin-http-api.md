# Direct Plugin HTTP API

Each plugin workspace will call its own backend through a plugin-local loopback HTTP API. The host starts the backend and supplies its address to the iframe, but does not proxy or interpret business requests; this keeps collection, persistence, and UI behavior owned by the plugin without reproducing TractIt's host RPC router.
