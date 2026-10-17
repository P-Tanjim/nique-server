'use strict';

/**
 * Admin dashboard + finance API for the Nique Sports backend.
 *
 * Wire-up (see the instructions in the chat for exact placement in index.js):
 *   const { requireAdminKey, createAdminDashboardRouter } = require('./adminDashboard');
 *   app.use('/admin', requireAdminKey);                      // BEFORE every /admin route
 *   app.use('/admin', createAdminDashboardRouter(() => ({ products, orders, financeTx, financeSettings })));
 *
 * Every route here is mounted under /admin, so it is protected by requireAdminKey.
 */

const express = require('express');
const { ObjectId } = require('mongodb');
const { createHash, timingSafeEqual } = require('node:crypto');

const TIME_ZONE = 'Asia/Dhaka'; // Bangladesh has no DST, so +06:00 all year
const ACCOUNTS = ['Cash', 'Bank', 'bKash', 'Nagad'];
const ACCOUNT_KEY = { Cash: 'cash', Bank: 'bank', bKash: 'bkash', Nagad: 'nagad' };
const TX_TYPES = ['money_in', 'expense', 'transfer'];
const LOW_STOCK_THRESHOLD = 5;
const CHART_RANGES = [7, 14, 30];
const MAX_AMOUNT = 100_000_000;
const MAX_EXPENSE_ROWS = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Admin key gate                                                      */
/* ------------------------------------------------------------------ */

// The Next.js server sends this header on every admin call, after it has
// verified the signed-in user is an admin. The browser never sees the key.
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected || expected.length < 24) {
    console.error('ADMIN_API_KEY is missing or shorter than 24 characters. Refusing all /admin requests.');
    return res.status(503).json({ error: 'Admin API is not configured.' });
  }

  const provided = req.get('x-admin-key');
  if (typeof provided !== 'string' || provided.length === 0) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const labelFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const todayInDhaka = () => dayFormatter.format(new Date());

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDay(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function dateOrToday(value) {
  if (value === undefined || value === null || value === '') return todayInDhaka();
  if (!isIsoDate(value)) throw new HttpError(400, 'Enter a valid date.');
  return value;
}

function optionalDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (!isIsoDate(value)) throw new HttpError(400, `${label} is not a valid date.`);
  return value;
}

function text(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return trimmed;
}

function accountName(value, label) {
  if (typeof value !== 'string' || !ACCOUNTS.includes(value)) {
    throw new HttpError(400, `Choose a valid ${label} account.`);
  }
  return value;
}

function positiveAmount(value, label = 'Amount') {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a number.`);
  }
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) {
    throw new HttpError(400, `${label} must be greater than 0.`);
  }
  return money(n);
}

function objectBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'A valid request body is required.');
  }
  return body;
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function dateMatch(from, to) {
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return { date: range };
}

function readDateRange(query) {
  const from = optionalDate(query.from, 'From date');
  const to = optionalDate(query.to, 'To date');
  if (from && to && from > to) throw new HttpError(400, 'From date must be on or before To date.');
  return { from, to };
}

function serializeTx(t) {
  return {
    id: String(t._id),
    date: t.date,
    type: t.type,
    from: t.from || '',
    to: t.to || '',
    amount: t.amount,
    reference: t.reference || '',
    note: t.note || '',
    createdAt: t.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Balance maths (pure, so it can be tested without a database)        */
/* ------------------------------------------------------------------ */

function normalizeOpening(opening = {}) {
  return {
    cash: money(opening?.cash || 0),
    bank: money(opening?.bank || 0),
    bkash: money(opening?.bkash || 0),
    nagad: money(opening?.nagad || 0),
  };
}

// groups: [{ _id: { type, from, to }, amount }]
function computeBalances(opening, groups) {
  const b = normalizeOpening(opening);
  const add = (name, delta) => {
    const key = ACCOUNT_KEY[name];
    if (key) b[key] += delta;
  };

  for (const group of groups) {
    const { type, from, to } = group._id;
    const amount = Number(group.amount) || 0;
    if (type === 'money_in') add(to, amount);
    else if (type === 'expense') add(from, -amount);
    else if (type === 'transfer') {
      add(from, -amount);
      add(to, amount);
    }
  }

  const rounded = {
    cash: money(b.cash),
    bank: money(b.bank),
    bkash: money(b.bkash),
    nagad: money(b.nagad),
  };
  return { ...rounded, total: money(rounded.cash + rounded.bank + rounded.bkash + rounded.nagad) };
}

async function loadBalances({ financeTx, financeSettings }) {
  const [settings, groups] = await Promise.all([
    financeSettings.findOne({ _id: 'main' }),
    financeTx
      .aggregate([
        { $group: { _id: { type: '$type', from: '$from', to: '$to' }, amount: { $sum: '$amount' } } },
      ])
      .toArray(),
  ]);

  return {
    opening: normalizeOpening(settings?.openingBalances),
    balances: computeBalances(settings?.openingBalances, groups),
  };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

function createAdminDashboardRouter(getCollections) {
  const router = express.Router();

  // Resolves the collections lazily (they only exist once MongoDB has connected).
  const needs = (...names) => (req, res, next) => {
    const collections = getCollections() ?? {};
    if (names.some((name) => !collections[name])) {
      return res.status(503).json({ error: 'Database not connected yet' });
    }
    req.db = collections;
    return next();
  };

  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(`${req.method} ${req.originalUrl} failed:`, err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  };

  /* ---------------- Dashboard overview ---------------- */

  router.get(
    '/dashboard/overview',
    needs('orders', 'products', 'financeTx', 'financeSettings'),
    handle(async (req, res) => {
      const { orders, products } = req.db;

      const requested = Number(req.query.range);
      const days = CHART_RANGES.includes(requested) ? requested : 14;
      const today = todayInDhaka();
      const startDay = shiftDay(today, -(days - 1));
      const start = new Date(`${startDay}T00:00:00+06:00`);

      const [daily, byStatus, pendingNow, recent, lowStock, lowStockTotal, finance] = await Promise.all([
        orders
          .aggregate([
            { $match: { createdAt: { $gte: start } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIME_ZONE } },
                orders: { $sum: 1 },
                revenue: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 0, '$total'] } },
              },
            },
          ])
          .toArray(),
        orders
          .aggregate([
            { $match: { createdAt: { $gte: start } } },
            { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$total' } } },
          ])
          .toArray(),
        orders.countDocuments({ status: 'pending' }),
        orders
          .aggregate([
            { $sort: { createdAt: -1 } },
            { $limit: 6 },
            {
              $project: {
                orderId: 1,
                status: 1,
                total: 1,
                createdAt: 1,
                customerName: '$customer.name',
                itemCount: { $sum: '$items.quantity' },
              },
            },
          ])
          .toArray(),
        products
          .find(
            { stock: { $lte: LOW_STOCK_THRESHOLD } },
            { projection: { title: 1, stock: 1, imagesLink: { $slice: 1 } } }
          )
          .sort({ stock: 1, title: 1 })
          .limit(6)
          .toArray(),
        products.countDocuments({ stock: { $lte: LOW_STOCK_THRESHOLD } }),
        loadBalances(req.db),
      ]);

      // One bar per day, including days with no orders.
      const dailyMap = new Map(daily.map((row) => [row._id, row]));
      const chart = [];
      for (let i = 0; i < days; i += 1) {
        const day = shiftDay(startDay, i);
        const row = dailyMap.get(day);
        chart.push({
          date: day,
          label: labelFormatter.format(new Date(`${day}T12:00:00Z`)),
          orders: row?.orders ?? 0,
          revenue: money(row?.revenue ?? 0),
        });
      }

      const statusRow = (status) => byStatus.find((row) => row._id === status);

      res.status(200).json({
        data: {
          range: { days, from: startDay, to: today },
          stats: {
            orders: byStatus.reduce((sum, row) => sum + row.count, 0),
            pending: pendingNow,
            delivered: statusRow('delivered')?.count ?? 0,
            deliveredRevenue: money(statusRow('delivered')?.total ?? 0),
            balance: finance.balances.total,
          },
          chart,
          recentOrders: recent.map((o) => ({
            id: String(o._id),
            orderId: o.orderId ?? '',
            customer: o.customerName ?? '',
            total: o.total ?? 0,
            status: o.status ?? 'pending',
            createdAt: o.createdAt,
            itemCount: o.itemCount ?? 0,
          })),
          lowStock: {
            threshold: LOW_STOCK_THRESHOLD,
            total: lowStockTotal,
            items: lowStock.map((p) => ({
              id: String(p._id),
              title: p.title ?? 'Untitled product',
              stock: Number(p.stock) || 0,
              image: p.imagesLink?.[0] ?? null,
            })),
          },
        },
      });
    })
  );

  /* ---------------- Finance: read ---------------- */

  router.get(
    '/finance/summary',
    needs('financeTx', 'financeSettings'),
    handle(async (req, res) => {
      const { financeTx } = req.db;
      const { from, to } = readDateRange(req.query);

      const [{ balances, opening }, periodGroups] = await Promise.all([
        loadBalances(req.db),
        financeTx
          .aggregate([{ $match: dateMatch(from, to) }, { $group: { _id: '$type', amount: { $sum: '$amount' } } }])
          .toArray(),
      ]);

      const sumOf = (type) => money(periodGroups.find((g) => g._id === type)?.amount ?? 0);
      const moneyIn = sumOf('money_in');
      const expense = sumOf('expense');

      res.status(200).json({
        data: {
          balances,
          opening,
          period: { from, to, moneyIn, expense, transfers: sumOf('transfer'), net: money(moneyIn - expense) },
        },
      });
    })
  );

  router.get(
    '/finance/transactions',
    needs('financeTx'),
    handle(async (req, res) => {
      const { financeTx } = req.db;
      const { from, to } = readDateRange(req.query);
      const filter = dateMatch(from, to);

      if (req.query.type !== undefined && req.query.type !== '') {
        if (!TX_TYPES.includes(req.query.type)) throw new HttpError(400, 'Unknown transaction type.');
        filter.type = req.query.type;
      }

      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
      if (q) {
        const pattern = new RegExp(escapeRegex(q), 'i');
        filter.$or = [{ note: pattern }, { reference: pattern }, { from: pattern }, { to: pattern }];
      }

      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
      const rows = await financeTx.find(filter).sort({ date: -1, createdAt: -1 }).limit(limit).toArray();

      res.status(200).json({ data: rows.map(serializeTx) });
    })
  );

  /* ---------------- Finance: write ---------------- */

  router.post(
    '/finance/money-in',
    needs('financeTx'),
    handle(async (req, res) => {
      const body = objectBody(req.body);
      const doc = {
        type: 'money_in',
        date: dateOrToday(body.date),
        from: '',
        to: accountName(body.account, 'deposit'),
        amount: positiveAmount(body.amount),
        reference: text(body.reference, 'Reference', 100),
        note: text(body.note, 'Note', 300),
        createdAt: new Date(),
      };
      const result = await req.db.financeTx.insertOne(doc);
      res.status(201).json({ data: serializeTx({ _id: result.insertedId, ...doc }) });
    })
  );

  router.post(
    '/finance/expenses',
    needs('financeTx'),
    handle(async (req, res) => {
      const body = objectBody(req.body);
      const date = dateOrToday(body.date);

      if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > MAX_EXPENSE_ROWS) {
        throw new HttpError(400, `Add between 1 and ${MAX_EXPENSE_ROWS} expenses.`);
      }

      const now = new Date();
      const docs = [];
      for (const [index, row] of body.rows.entries()) {
        const position = index + 1;
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new HttpError(400, `Expense ${position} is invalid.`);
        }

        const name = text(row.name, `Expense ${position} description`, 200);
        const amountIsBlank =
          row.amount === undefined || row.amount === null || String(row.amount).trim() === '' || Number(row.amount) === 0;
        if (!name && amountIsBlank) continue; // untouched row

        if (!name) throw new HttpError(400, `Expense ${position} needs a description.`);
        docs.push({
          type: 'expense',
          date,
          from: accountName(row.paidFrom, `expense ${position} paid-from`),
          to: '',
          amount: positiveAmount(row.amount, `Expense ${position} amount`),
          reference: '',
          note: name,
          createdAt: now,
        });
      }

      if (docs.length === 0) throw new HttpError(400, 'Add at least one expense.');
      await req.db.financeTx.insertMany(docs);
      res.status(201).json({ data: { count: docs.length } });
    })
  );

  router.post(
    '/finance/transfer',
    needs('financeTx'),
    handle(async (req, res) => {
      const body = objectBody(req.body);
      const from = accountName(body.from, 'source');
      const to = accountName(body.to, 'destination');
      if (from === to) throw new HttpError(400, 'Choose two different accounts.');

      const doc = {
        type: 'transfer',
        date: dateOrToday(body.date),
        from,
        to,
        amount: positiveAmount(body.amount),
        reference: '',
        note: text(body.note, 'Note', 300),
        createdAt: new Date(),
      };
      const result = await req.db.financeTx.insertOne(doc);
      res.status(201).json({ data: serializeTx({ _id: result.insertedId, ...doc }) });
    })
  );

  router.put(
    '/finance/opening-balances',
    needs('financeSettings'),
    handle(async (req, res) => {
      const body = objectBody(req.body);
      const opening = {};

      for (const key of Object.values(ACCOUNT_KEY)) {
        const raw = body[key];
        if (raw !== undefined && raw !== null && raw !== '' && typeof raw !== 'number' && typeof raw !== 'string') {
          throw new HttpError(400, `Opening ${key} balance must be a number.`);
        }
        const n = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) {
          throw new HttpError(400, `Opening ${key} balance must be between 0 and ${MAX_AMOUNT}.`);
        }
        opening[key] = money(n);
      }

      await req.db.financeSettings.updateOne(
        { _id: 'main' },
        { $set: { openingBalances: opening, updatedAt: new Date() } },
        { upsert: true }
      );
      res.status(200).json({ data: { opening } });
    })
  );

  router.delete(
    '/finance/transactions/:id',
    needs('financeTx'),
    handle(async (req, res) => {
      if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new HttpError(400, 'Invalid entry id.');
      const result = await req.db.financeTx.deleteOne({ _id: new ObjectId(req.params.id) });
      if (result.deletedCount === 0) throw new HttpError(404, 'Entry not found.');
      res.status(200).json({ data: { id: req.params.id } });
    })
  );

  return router;
}

module.exports = {
  requireAdminKey,
  createAdminDashboardRouter,
  // exported for tests only
  _internals: { computeBalances, isIsoDate, shiftDay, positiveAmount, escapeRegex },
};