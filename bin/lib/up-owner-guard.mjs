import { hostname as osHostname } from "node:os";

export function assertUpOwnerAllowed(env = process.env) {
  const required = normalizeOwner(env.BUTLER_UP_OWNER_REQUIRED);
  if (!required) {
    return;
  }

  const actual = resolveActualOwner(env);
  if (actual === required) {
    return;
  }

  throw new Error(
    `butler up blocked: required owner '${required}' but got '${actual ?? "unset"}'. ` +
      "Start via the configured service launcher."
  );
}

function resolveActualOwner(env) {
  const explicit = normalizeOwner(env.BUTLER_UP_OWNER);
  if (explicit) {
    return explicit;
  }

  const fromEnvHostname = normalizeOwner(env.HOSTNAME);
  if (fromEnvHostname) {
    return fromEnvHostname;
  }

  return normalizeOwner(osHostname());
}

function normalizeOwner(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
