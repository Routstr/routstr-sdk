/**
 * Routstr SDK - Framework-agnostic SDK for Routstr API interactions
 *
 * This SDK provides a clean separation between business logic and UI,
 * making it easier to test, reuse, and maintain.
 */

// Core types and errors
export * from "./core";

// Discovery module (model and mint discovery)
export {
  type DiscoveryAdapter,
  ModelManager,
  type ModelManagerConfig,
  MintDiscovery,
} from "./discovery";

// Wallet interfaces
export * from "./wallet";

// Client classes (available after Phase 3)
export * from "./client";

// Utilities
export * from "./utils";

// Storage (default adapters + drivers)
export * from "./storage";
