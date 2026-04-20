import crypto from 'crypto';
import { withDatabase } from '../core/database.service.js';
import { loadConfig } from '../editor/config.js';

const SESSION_COOKIE_NAME = 'vibeedit_session';
const SESSION_TTL_DAYS = 30;
const ADMIN_BOOTSTRAP_EMAIL = 'zjyuiop321@gmail.com';
let cachedAuthSecret = '';

function getAuthSecret() {
  if (cachedAuthSecret) {
    return cachedAuthSecret;
  }
  const config = loadConfig();
  const secret = String(
    process.env.AUTOEDIT_AUTH_SECRET
    || config.auth_secret
    || ''
  ).trim();

  if (!secret) {
    throw new Error('Missing auth secret. Set AUTOEDIT_AUTH_SECRET or auth_secret in config before starting VibeEdit.');
  }

  cachedAuthSecret = secret;
  return cachedAuthSecret;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function hashWithSha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function encodePasswordHash({ salt, hash }) {
  return `scrypt$${salt}$${hash}`;
}

function decodePasswordHash(passwordHash = '') {
  const [scheme, salt, hash] = String(passwordHash || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) {
    throw new Error('Unsupported password hash format');
  }
  return { salt, hash };
}

function hashPassword(password = '') {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return encodePasswordHash({ salt, hash });
}

function verifyPassword(password = '', passwordHash = '') {
  const { salt, hash } = decodePasswordHash(passwordHash);
  const derived = crypto.scryptSync(String(password || ''), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function generateSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function parseCookies(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((accumulator, entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) return accumulator;
      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      accumulator[key] = decodeURIComponent(value);
      return accumulator;
    }, {});
}

export function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie || '');
  return String(cookies[SESSION_COOKIE_NAME] || '').trim();
}

function buildCookieString(name, value, {
  expires = null,
  maxAge = null,
  httpOnly = true,
  sameSite = 'Lax',
  secure = false,
  path = '/'
} = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (expires) parts.push(`Expires=${expires.toUTCString()}`);
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

function requestWantsSecureCookie(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').trim().toLowerCase();
  return forwardedProto === 'https' || process.env.NODE_ENV === 'production';
}

function mapUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    created_at: user.createdAt,
    updated_at: user.updatedAt
  };
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export function getAdminBootstrapEmail() {
  return ADMIN_BOOTSTRAP_EMAIL;
}

export function setAuthCookie(res, token, req) {
  const expiresAt = new Date(Date.now() + (SESSION_TTL_DAYS * 24 * 60 * 60 * 1000));
  res.append('Set-Cookie', buildCookieString(SESSION_COOKIE_NAME, token, {
    expires: expiresAt,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    secure: requestWantsSecureCookie(req)
  }));
}

export function clearAuthCookie(res, req) {
  res.append('Set-Cookie', buildCookieString(SESSION_COOKIE_NAME, '', {
    expires: new Date(0),
    maxAge: 0,
    secure: requestWantsSecureCookie(req)
  }));
}

export async function getSessionUserFromRequest(req) {
  const rawToken = getSessionTokenFromRequest(req);
  if (!rawToken) return null;

  const tokenHash = hashWithSha256(rawToken);
  return withDatabase(async (db) => {
    const authSession = await db.authSession.findFirst({
      where: {
        tokenHash,
        expiresAt: {
          gt: new Date()
        }
      },
      include: {
        user: true
      }
    });

    if (!authSession?.user) return null;
    return mapUser(authSession.user);
  });
}

async function claimOrphanedResourcesForUser(userId) {
  return withDatabase(async (db) => {
    await db.project.updateMany({
      where: { ownerId: null },
      data: { ownerId: userId }
    });
    await db.asset.updateMany({
      where: { ownerId: null },
      data: { ownerId: userId }
    });
  });
}

export async function registerUser({ email = '', password = '' } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');

  if (!normalizedEmail) {
    throw new Error('邮箱不能为空');
  }
  if (normalizedPassword.length < 6) {
    throw new Error('密码至少需要 6 位');
  }

  return withDatabase(async (db) => {
    const existing = await db.user.findUnique({
      where: { email: normalizedEmail }
    });
    if (existing) {
      throw new Error('这个邮箱已经注册过了');
    }

    const userCount = await db.user.count();
    const shouldBootstrapAdmin = userCount === 0;
    if (shouldBootstrapAdmin && normalizedEmail !== ADMIN_BOOTSTRAP_EMAIL) {
      throw new Error(`首个管理员账号必须使用 ${ADMIN_BOOTSTRAP_EMAIL}`);
    }

    const created = await db.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: hashPassword(normalizedPassword),
        role: shouldBootstrapAdmin ? 'admin' : 'user'
      }
    });

    if (shouldBootstrapAdmin) {
      await claimOrphanedResourcesForUser(created.id);
    }

    return mapUser(created);
  });
}

export async function loginUser({ email = '', password = '' } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = String(password || '');
  if (!normalizedEmail || !normalizedPassword) {
    throw new Error('邮箱和密码不能为空');
  }

  return withDatabase(async (db) => {
    const user = await db.user.findUnique({
      where: { email: normalizedEmail }
    });
    if (!user || !verifyPassword(normalizedPassword, user.passwordHash)) {
      throw new Error('邮箱或密码不正确');
    }
    return mapUser(user);
  });
}

export async function createSessionForUser(userId) {
  const rawToken = generateSessionToken();
  const expiresAt = new Date(Date.now() + (SESSION_TTL_DAYS * 24 * 60 * 60 * 1000));

  await withDatabase((db) => db.authSession.create({
    data: {
      userId,
      tokenHash: hashWithSha256(rawToken),
      expiresAt
    }
  }));

  return rawToken;
}

export async function logoutRequest(req) {
  const rawToken = getSessionTokenFromRequest(req);
  if (!rawToken) return;

  const tokenHash = hashWithSha256(rawToken);
  await withDatabase((db) => db.authSession.deleteMany({
    where: { tokenHash }
  }));
}

export async function changeUserPassword({
  userId = '',
  currentPassword = '',
  nextPassword = '',
  preserveSessionToken = ''
} = {}) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('用户不存在');
  }
  if (String(nextPassword || '').length < 6) {
    throw new Error('新密码至少需要 6 位');
  }

  return withDatabase(async (db) => {
    const user = await db.user.findUnique({
      where: { id: normalizedUserId }
    });
    if (!user) {
      throw new Error('用户不存在');
    }
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      throw new Error('当前密码不正确');
    }

    const preservedTokenHash = preserveSessionToken ? hashWithSha256(preserveSessionToken) : '';

    await db.$transaction([
      db.user.update({
        where: { id: normalizedUserId },
        data: {
          passwordHash: hashPassword(nextPassword)
        }
      }),
      db.authSession.deleteMany({
        where: {
          userId: normalizedUserId,
          ...(preservedTokenHash
            ? {
                tokenHash: {
                  not: preservedTokenHash
                }
              }
            : {})
        }
      })
    ]);

    const updated = await db.user.findUnique({
      where: { id: normalizedUserId }
    });
    return mapUser(updated);
  });
}

export async function listUsersForAdmin() {
  return withDatabase(async (db) => {
    const now = new Date();
    const users = await db.user.findMany({
      include: {
        _count: {
          select: {
            projects: true,
            assets: true
          }
        }
      },
      orderBy: [
        { role: 'asc' },
        { createdAt: 'asc' }
      ]
    });

    const activeSessionCounts = await Promise.all(users.map((user) => db.authSession.count({
      where: {
        userId: user.id,
        expiresAt: {
          gt: now
        }
      }
    })));

    return users.map((user, index) => ({
      ...mapUser(user),
      project_count: Number(user._count?.projects || 0),
      asset_count: Number(user._count?.assets || 0),
      active_session_count: Number(activeSessionCounts[index] || 0)
    }));
  });
}

export async function getOwnedProjectById(projectId, ownerId) {
  return withDatabase((db) => db.project.findFirst({
    where: {
      id: projectId,
      ownerId
    }
  }));
}

export async function getOwnedAssetById(assetId, ownerId) {
  return withDatabase((db) => db.asset.findFirst({
    where: {
      id: assetId,
      ownerId
    }
  }));
}

export function createSignedAssetSourceToken(assetId, ttlSeconds = 3600) {
  const payload = {
    assetId: String(assetId || '').trim(),
    exp: Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds || 3600))
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', getAuthSecret())
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySignedAssetSourceToken(assetId, token = '') {
  const value = String(token || '').trim();
  if (!value.includes('.')) return false;

  const [encodedPayload, providedSignature] = value.split('.', 2);
  const expectedSignature = crypto
    .createHmac('sha256', getAuthSecret())
    .update(encodedPayload)
    .digest('base64url');

  const providedBuffer = Buffer.from(providedSignature || '');
  const expectedBuffer = Buffer.from(expectedSignature || '');
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return false;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (String(payload.assetId || '') !== String(assetId || '')) return false;
    if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}
