import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

// Content-Security-Policy for the editor SPA. Kept deliberately in sync with the
// `Content-Security-Policy` header in editor/vercel.json (the Vercel-served copy
// of the app) — change both together. Notes on the loosened directives:
//   style-src 'unsafe-inline' — CodeMirror and the SPA inject inline <style>.
//   img-src https:/data:/blob: — post covers can be any https image, previews
//     load /uploads (self) and raw.githubusercontent.com images, pastes are data:.
// script-src stays 'self': the Vite build emits no inline scripts (the
// modulepreload polyfill is disabled in vite.config.ts).
const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: ["'self'"],
  fontSrc: ["'self'", 'data:'],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  frameSrc: ["'none'"],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
};

// nosniff, HSTS, frameguard (DENY), referrer-policy, hidePoweredBy, COOP/CORP…
export const securityHeaders = helmet({
  contentSecurityPolicy: { useDefaults: true, directives: cspDirectives },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' }, // never framed — matches editor/vercel.json
  referrerPolicy: { policy: 'no-referrer' },
  // COEP would block the cross-origin images (post covers) we don't control.
  crossOriginEmbedderPolicy: false,
});

function makeAuthLimiter(limit) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    // only failed attempts count — a legitimate login shouldn't spend the budget
    // for the next real user sitting behind the same NAT / proxy IP.
    skipSuccessfulRequests: true,
    message: { error: 'too many attempts — try again in a few minutes' },
  });
}

// Throttle credential guessing against the single admin account. Overridable via
// env so the smoke suite can drive the 429 path deterministically.
export const loginLimiter = makeAuthLimiter(Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10);
export const setupLimiter = makeAuthLimiter(Number(process.env.SETUP_RATE_LIMIT_MAX) || 10);
