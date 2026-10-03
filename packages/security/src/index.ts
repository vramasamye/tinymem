/**
 * `@onememory/security` — the security core (ADR-0007): secret detection & redaction at the
 * ingest boundary, path exclusions for credential files, and the 100%-local privacy gate.
 *
 * Callers:
 * - adapters translate runtime activity -> `OnememoryEvent`, then call `isEventPathExcluded`
 *   (drop the whole event when the path is excluded) and `redactEvent` before ingest.
 * - the ingest stage calls `redactEvent` even for trusted sources (adapters are never
 *   assumed to send clean transcripts — redaction runs on the engine side of every boundary).
 * - local-profile tests (and the M13 daemon) call `installNetworkGuard`.
 */

// Marker (§7 redaction invariant)
export {
  REDACTION_MARKER_PREFIX,
  REDACTION_MARKER_SUFFIX,
  redactionMarker,
  isRedactionMarker,
} from './marker';

// Pattern catalog + configuration
export {
  PATTERN_GROUPS,
  PATTERN_GROUP_IDS,
  ExtraPatternSchema,
  RedactorConfigSchema,
  RedactorConfigError,
  compileDetector,
  type Detector,
  type ExtraPattern,
  type KindSource,
  type PatternGroup,
  type PatternGroupId,
  type SecretPattern,
  type RedactorConfig,
  type ExtraPatternInput,
  type ConfigIssue,
} from './patterns';

// Redactor port implementation (core's `Redactor` / `SecretRedactor`)
export { createRedactor, redactValue, scanString, walkValue } from './redactor';

// Ingest integration helper
export { redactEvent, RedactEventError, type RedactedEvent } from './redact-event';

// Path exclusion policy
export {
  DEFAULT_EXCLUDED_GLOBS,
  DEFAULT_PATH_EXCLUSION_POLICY,
  createPathExclusionPolicy,
  isPathExcluded,
  isEventPathExcluded,
  PathExclusionConfigError,
  type PathExclusionPolicy,
  type PathExclusionPolicyConfig,
} from './exclusions';

// Privacy network gate
export {
  installNetworkGuard,
  NetworkGuardError,
  type NetworkGuard,
  type NetworkGuardOptions,
  type NetworkAttempt,
} from './network-guard';
