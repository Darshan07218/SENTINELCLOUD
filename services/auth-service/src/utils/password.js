import bcrypt from "bcryptjs";

// bcryptjs (pure JS) instead of bcrypt (native addon) is a deliberate
// choice here: it avoids needing python3/make/g++ in the slim Alpine
// runtime image just to compile a native module.
//
// Phase 12: the cost factor can be raised via BCRYPT_SALT_ROUNDS but
// never lowered below 12 (≈ 250 ms per hash on a laptop core) — a typo
// or a copied "4 for faster tests" value must not weaken production.
export const MIN_SALT_ROUNDS = 12;
const SALT_ROUNDS = Math.max(MIN_SALT_ROUNDS, Number(process.env.BCRYPT_SALT_ROUNDS) || MIN_SALT_ROUNDS);

export async function hashPassword(plainTextPassword) {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function verifyPassword(plainTextPassword, passwordHash) {
  return bcrypt.compare(plainTextPassword, passwordHash);
}

// A real bcrypt hash of a random value, computed once at startup. Login
// compares against it when the email doesn't exist, so "no such user"
// takes as long as "wrong password" and response time can't be used to
// find out which emails are registered.
let dummyHashPromise = null;
export function burnPasswordCheck(plainTextPassword) {
  dummyHashPromise ||= bcrypt.hash(`dummy-${Math.random()}-${Date.now()}`, SALT_ROUNDS);
  return dummyHashPromise.then((hash) => bcrypt.compare(plainTextPassword, hash)).then(() => false);
}
