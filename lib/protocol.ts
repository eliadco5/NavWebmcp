/**
 * The NavWebMcp wire protocol contract. Hand-maintained semver.
 *
 * NavWebMcp layers progressive tool disclosure, RBAC, and composite operations on
 * top of the W3C WebMCP draft. AgentBridge is this repo's implementation of it.
 *
 * Not the app version (package.json), not the capability hash (lib/capabilities.ts).
 * Versions the observable protocol surface only: the capability manifest shape, the
 * always-on meta-op signatures (8 navigation ops + 4 ui_* ops since 1.3.0), the UI
 * component kinds, the Result envelope, and the error-code vocabulary.
 * Adding, removing, or changing a business operation is NOT a protocol change — that
 * only moves the capability hash.
 *
 * Bump rules and history: CHANGELOG.md.
 */
export const PROTOCOL_NAME = "NavWebMcp";
export const PROTOCOL_VERSION = "2.6.0";
