# Plugin-Provided OpenCLI Adapters

Infolens Plugin Contract Version 2 allows a trusted plugin package to include ordinary, portable OpenCLI Adapters. A package must contain ready-to-run JavaScript and all non-OpenCLI runtime dependencies in that output. Installation never runs package scripts, compiles source, or fetches dependencies.

The Plugin Runtime validates the Adapter's `opencli-plugin.json`, hashes its content, probes its actual registration through the bundled OpenCLI runtime, and rejects unsupported hooks, undeclared commands, strategy mismatches, and command collisions. Successful content is copied into an immutable managed Store outside OpenCLI's `node_modules`. The same Adapter ID and version may be reused only when its hash matches; different versions coexist.

Each Infolens plugin receives a Scope Lock with exact Adapter versions, hashes, paths, and commands. OpenCLI is launched with user-global discovery disabled and with only those exact Adapter paths. The Runtime continues to expose only `opencli.run(commandKey, args, signal)` to plugin backends and obtains concurrency permits per validated command invocation.

Development scopes use links to Adapter source files. Installed scopes use immutable Store content. Product Hunt is the first bundled plugin to exercise this path and no longer requires patching its upstream OpenCLI Adapter in `node_modules`.

The bundled OpenCLI 1.8.6 distribution temporarily receives a version-checked build patch for exact plugin paths and machine-readable registration reports. The intended long-term interface is an upstream OpenCLI release; Infolens does not maintain a fork.
