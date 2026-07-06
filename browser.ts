// Explicit browser-safe entrypoint.
// This intentionally re-exports the default SDK surface, which contains no
// static or dynamic imports of Node/Bun SQLite modules.
export * from "./index";
