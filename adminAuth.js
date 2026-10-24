'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

// Every /admin route needs the shared secret that ONLY the Next.js server knows
// (the browser never sees it). Next.js checks the signed-in role first, then sends this header.
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected || expected.length < 24) {
    console.error('ADMIN_API_KEY is missing or shorter than 24 characters. Refusing all /admin requests.');
    return res.status(503).json({ error: 'Admin API is not configured.' });
  }
  const provided = req.get('x-admin-key');
  if (typeof provided !== 'string' || !provided) return res.status(401).json({ error: 'Unauthorized' });

  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

module.exports = { requireAdminKey };
