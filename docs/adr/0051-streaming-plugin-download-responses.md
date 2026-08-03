# Streaming Plugin Download Responses

Plugin Routes may return a Thin Plugin SDK `downloadableResponse(filename, body)` value in addition to ordinary JSON values. Plugin Runtime validates a conservative JSON filename, applies fixed download and security headers, and writes the iterable or async-iterable body with backpressure.

This extension keeps Plugin Contract Version 2. A Plugin that returns downloadable responses declares minimum Host version 0.2.0 so an older Runtime rejects the package instead of serializing the transport value as ordinary JSON.

The response convention standardizes transport only. The Thin Plugin SDK does not define source records, history retention, export persistence, scheduling, or Workspace presentation. Each Plugin continues to own its independent Plugin Store and creates its own versioned export envelope content from a consistent store transaction.

Plugin Runtime never applies diagnostic redaction to exported business data. A Plugin is responsible for including intended source fields and excluding settings, logs, authentication material, caches, Adapter internals, dependency state, and SQLite details.
