# Licensing and redistribution

The generator and bundled runtime/template code are licensed under Apache-2.0; see the repository LICENSE. Generated SDK packages include that license for the copied runtime code. Providers and consumers can inspect, modify, fork and redistribute it under those terms, retaining required notices.

An API definition, provider examples, trademarks, package identity and custom code do not automatically become Apache-2.0 merely because this generator processes them. Their owners retain their rights. Providers must choose accurate package-level license metadata and include any additional required notices for their material. The `license` configuration field does not replace or remove the runtime license.

Generated Node packages use Node built-ins and have no third-party npm runtime dependencies. Their npm metadata declares `@types/node` for TypeScript compilation; its separately installed package and dependencies retain their own licenses. Generated PHP packages use the PHP runtime, JSON and cURL extensions and have no third-party Composer runtime dependencies. Optional SQLite inbox examples use the platform's SQLite bindings. Those platforms/extensions and their distributions retain their own licenses.

The generator pins TypeScript and Node type declarations for compilation/validation and markdown-it for rendering distribution documentation in package-lock.json. Development formatting tools are dev dependencies. Their licenses apply to their own distributions; they are not copied into generated SDKs. Inspect dependency package licenses before redistributing a modified tool distribution.
