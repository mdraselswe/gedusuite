/**
 * Is a session cookie older than the account's "valid after" marker?
 *
 * `issuedAt` is the JWT's iat in seconds; `validAfter` is when the password was
 * last reset. A second of slack covers the iat being floored to whole seconds.
 * Cookies without an iat (should not exist) are left alone rather than locking
 * somebody out on a technicality.
 */
export function sessionIsVoid(
  issuedAt: number | undefined,
  validAfter: Date | null | undefined,
): boolean {
  if (!validAfter || issuedAt === undefined) return false;
  return issuedAt * 1000 < validAfter.getTime() - 1000;
}
