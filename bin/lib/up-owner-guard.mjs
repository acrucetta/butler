export function assertUpOwnerAllowed(env = process.env) {
  const required = normalizeOwner(env.BUTLER_UP_OWNER_REQUIRED);
  if (!required) {
    return;
  }

  const actual = normalizeOwner(env.BUTLER_UP_OWNER);
  if (actual === required) {
    return;
  }

  throw new Error(
    `butler up blocked: required owner '${required}' but got '${actual ?? "unset"}'. ` +
      "Start via the configured service launcher."
  );
}

function normalizeOwner(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
