export function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function envBoundedInteger(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  return boundedInteger(process.env[name], fallback, min, max);
}

export function envIntegerOrThrow(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}