import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const lifetimeSeconds = 12 * 60 * 60;
export const loginRequired = Boolean(process.env.PI_TAB_USERS);
const users = [];
for (const entry of (process.env.PI_TAB_USERS || '').split(',').filter(Boolean)) {
  const boundary = entry.indexOf(':');
  const id = entry.slice(0, boundary);
  const password = entry.slice(boundary + 1);
  if (boundary < 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !password || users.some(user => user.id === id)) {
    throw new Error('PI_TAB_USERS must contain unique username:password pairs; usernames use letters, digits, _ or -');
  }
  const salt = randomBytes(16);
  users.push({ id, name: id, salt, hash: await derive(password, salt, 64) });
}
let secret;
if (loginRequired) {
  try {
    secret = await readFile('.session-secret');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try {
      await writeFile('.session-secret', randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (creationError) {
      if (creationError.code !== 'EEXIST') throw creationError;
    }
    secret = await readFile('.session-secret');
  }
  if (secret.length !== 32) throw new Error('Invalid session signing secret length');
}
const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
const publicUser = user => ({ id: user.id, name: user.name });

export async function authenticate(id, password) {
  const user = users.find(user => user.id === id);
  const reference = user || users[0];
  if (!reference) return undefined;
  const candidate = await derive(typeof password === 'string' ? password : '', reference.salt, 64);
  const matches = timingSafeEqual(candidate, reference.hash);
  return user && matches ? publicUser(user) : undefined;
}

// Logged-out session ids until their expiry. In memory only: a server restart forgets revocations.
const revoked = new Map();

function verifiedClaims(request) {
  const token = (request.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith('pi_session='))?.slice('pi_session='.length);
  if (!token) return undefined;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return undefined;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= Date.now()) return undefined;
    if (typeof claims.jti !== 'string' || revoked.has(claims.jti)) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

export function sessionUser(request) {
  if (!loginRequired) return { id: 'local', name: 'You' };
  const claims = verifiedClaims(request);
  const user = claims && users.find(user => user.id === claims.sub);
  return user ? publicUser(user) : undefined;
}

export function revokeSession(request) {
  const claims = verifiedClaims(request);
  if (!claims) return;
  const now = Date.now();
  for (const [id, exp] of revoked) if (exp <= now) revoked.delete(id);
  revoked.set(claims.jti, claims.exp);
}

export function sessionCookie(user, origin) {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure}`;
  if (!user) return `pi_session=; Max-Age=0; ${attributes}`;
  const payload = Buffer.from(JSON.stringify({ sub: user.id, jti: randomUUID(), exp: Date.now() + lifetimeSeconds * 1000 })).toString('base64url');
  return `pi_session=${payload}.${sign(payload)}; Max-Age=${lifetimeSeconds}; ${attributes}`;
}
