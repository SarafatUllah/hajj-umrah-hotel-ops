/** Escapes LIKE/ILIKE metacharacters so a client-supplied `q` (e.g. `%`) is matched LITERALLY, never as a wildcard. */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
