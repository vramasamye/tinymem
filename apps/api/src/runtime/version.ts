/**
 * The single version string for CLI + API responses.
 *
 * Mirrors `package.json` and is kept honest by `version.test.ts`, which reads both files and fails
 * if they drift — cheaper and more reliable than wiring a JSON import through the build.
 */
export const ONEMEMORY_VERSION = '0.1.0';
