import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const API_KEY = process.env.SHOPIFY_API_KEY || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SHOP = (process.env.SHOP_DOMAIN || '').toLowerCase();
const NO_AUTH = process.env.DEV_NO_AUTH === '1';

export const COOKIE = 'rp_auth';

function cookieValue() {
  return crypto.createHmac('sha256', PASSWORD + API_SECRET).update('dashboard').digest('hex');
}

export function checkPassword(pw) {
  if (!PASSWORD || typeof pw !== 'string') return false;
  const a = Buffer.from(pw);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function loginCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE}=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Session token issued by App Bridge when the dashboard runs inside the Shopify admin.
function verifyShopifyToken(token) {
  if (!API_SECRET || !API_KEY || !token) return false;
  try {
    const p = jwt.verify(token, API_SECRET, { algorithms: ['HS256'], audience: API_KEY, clockTolerance: 10 });
    const shop = new URL(p.dest).hostname.toLowerCase();
    return !SHOP || shop === SHOP;
  } catch {
    return false;
  }
}

export function isAuthorized(req, tokenFromQuery) {
  if (NO_AUTH) return true;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : tokenFromQuery;
  if (verifyShopifyToken(bearer)) return true;
  const c = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(PASSWORD && c && c === cookieValue());
}

export function requireAuth(req, res, next) {
  if (isAuthorized(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export const authConfig = { apiKey: API_KEY, hasPassword: Boolean(PASSWORD), shop: SHOP, noAuth: NO_AUTH };
