import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const TOKEN_EXPIRY = '7d';
const SCRYPT_KEY_LENGTH = 64;

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`scrypt:${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

export function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [, salt, hashHex] = (storedHash || '').split(':');
    if (!salt || !hashHex) return resolve(false);
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error) return reject(error);
      const stored = Buffer.from(hashHex, 'hex');
      resolve(stored.length === derivedKey.length && crypto.timingSafeEqual(stored, derivedKey));
    });
  });
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error('JWT_SECRET is required');
  return secret;
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, getJwtSecret(), { expiresIn: TOKEN_EXPIRY });
}

// Synchronous by design - requireAuth is registered via app.use(), which asyncRoute's
// promise-forwarding wrapper does NOT cover (see server.js's asyncRoute comment). jwt.verify()'s
// no-callback form throws synchronously, which Express already forwards correctly on its own.
export function verifyToken(token) {
  return jwt.verify(token, getJwtSecret());
}
