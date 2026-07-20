# Live Plugin Theme Updates

The host will provide initial theme through the workspace iframe URL and notify theme changes with a minimal `postMessage` payload. Plugin SDK helpers consume this appearance-only convention so bundled plugins update without reloading, while the channel remains separate from business communication.
