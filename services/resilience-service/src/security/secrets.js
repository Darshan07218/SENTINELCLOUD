/**
 * Phase 12: startup checks for secrets read from the environment.
 *
 * Every secret (JWT keys, database and broker passwords, tokens) comes
 * from environment variables that Docker Compose fills from `.env` and
 * Kubernetes fills from the `sentinelcloud-secrets` Secret. Nothing has a
 * fallback value in code: a missing, short or placeholder secret stops
 * the service at startup with a message saying how to fix it, instead of
 * silently running with a guessable credential.
 *
 * Generate real values with scripts/generate-secrets.sh (or .ps1).
 * Canonical copy: shared/node-security/secrets.js (copied into each
 * Node service by scripts/sync-shared-security.sh).
 */

// Values copied from example files or typed as "temporary" defaults.
const PLACEHOLDER_PATTERNS = [
  /change[_-]?me/i,
  /placeholder/i,
  /dev[_-]?only/i,
  /dev[_-]?password/i,
  /_dev(_|$)/i, // e.g. the old example "sentinel_grafana_dev"
  /^(password|secret|admin|guest|test|sentinel|postgres)$/i,
];

export class SecretConfigError extends Error {}

export function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

/**
 * Returns the secret, or throws SecretConfigError if it is missing,
 * shorter than `minLength`, or still a placeholder.
 */
export function requireSecret(name, { minLength = 32, env = process.env } = {}) {
  const value = env[name];
  const hint = "Generate secrets with scripts/generate-secrets.sh — see SECURITY.md.";
  if (value === undefined || value === "") {
    throw new SecretConfigError(`${name} is not set. ${hint}`);
  }
  if (value.length < minLength) {
    throw new SecretConfigError(`${name} is too short (${value.length} chars, need at least ${minLength}). ${hint}`);
  }
  if (isPlaceholder(value)) {
    throw new SecretConfigError(`${name} still holds a placeholder/example value. ${hint}`);
  }
  return value;
}

/** Non-secret but mandatory settings (e.g. a database user name). */
export function requireEnv(name, { env = process.env } = {}) {
  const value = env[name];
  if (value === undefined || value === "") throw new SecretConfigError(`${name} is not set.`);
  return value;
}
