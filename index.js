const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { requireAdminKey } = require('./adminAuth');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.disable('x-powered-by');
// Set ALLOWED_ORIGINS="https://yourshop.com,https://www.yourshop.com" in production.
// (Admin routes are protected by the secret key anyway; this just stops random sites calling the public routes from a browser.)
const origins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '1mb' }));
app.use('/admin', requireAdminKey);

/* ------------------------------- helpers ------------------------------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
const needDb = (req, res, next) => (products ? next() : res.status(503).json({ error: 'Database not connected yet' }));
const objectId = (value, label = 'id') => {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) bad(`Invalid ${label}.`);
  return new ObjectId(value);
};

const SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const isUrl = (s) => typeof s === 'string' && s.length <= 2048 && /^https?:\/\/\S+$/i.test(s.trim());
const str = (v, label, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) bad(`${label} is required.`); return ''; }
  if (typeof v !== 'string') bad(`${label} must be text.`);
  const s = v.trim();
  if (required && !s) bad(`${label} is required.`);
  if (s.length > max) bad(`${label} must be ${max} characters or fewer.`);
  return s;
};
const num = (v, label, { min = 0, max = 10_000_000, int = false } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) bad(`${label} must be a valid number${int ? ' (whole)' : ''} between ${min} and ${max}.`);
  return n;
};

function pricedImages(items, label, max = 8) {
  if (!Array.isArray(items)) bad(`${label} must be an array.`);
  if (items.length > max) bad(`${label}: at most ${max} options.`);
  return items.map((item, i) => {
    const legacy = typeof item === 'string';
    const image = legacy ? item : item?.image;
    if (!isUrl(image)) bad(`${label} option ${i + 1} must have a valid image URL.`);
    const raw = legacy ? 0 : item?.price;
    if (raw === undefined || raw === null || raw === '') bad(`${label} option ${i + 1} needs a price.`);
    return { image: image.trim(), price: num(raw, `${label} option ${i + 1} price`, { max: 1_000_000 }) };
  });
}

// ONE validator for create + update (they used to be copy-pasted)
function validateProduct(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('A valid product body is required.');
  const title = str(body.title, 'Title', 200, { required: true });
  const category = str(body.category, 'Category', 80, { required: true });
  const price = num(body.price, 'Price', { max: 1_000_000 });
  const stock = num(body.stock ?? 0, 'Stock', { max: 1_000_000, int: true });

  if (!Array.isArray(body.size) || body.size.length === 0 || body.size.some((s) => !SIZES.includes(s))) bad(`Select at least one valid size (${SIZES.join(', ')}).`);
  const size = [...new Set(body.size)];

  const discount = Boolean(body.discount);
  const beforePrice = discount ? num(body.beforePrice, 'Before price', { max: 1_000_000 }) : 0;
  if (discount && beforePrice <= price) bad('Before price must be greater than the selling price.');

  const imagesLink = body.imagesLink;
  if (!Array.isArray(imagesLink) || imagesLink.length === 0 || imagesLink.length > 15 || !imagesLink.every(isUrl)) bad('Add 1-15 valid product images.');

  const patch = Boolean(body.patch);
  const font = Boolean(body.font);
  const patchsImg = patch ? pricedImages(body.patchsImg ?? [], 'Patch', 4) : [];
  const fontsImg = font ? pricedImages(body.fontsImg ?? [], 'Font', 4) : [];
  if (patch && !patchsImg.length) bad('Patch is enabled but no patch options were provided.');
  if (font && !fontsImg.length) bad('Font is enabled but no font options were provided.');

  return {
    title, desc: str(body.desc, 'Description', 5000), price, discount, beforePrice,
    discountPercent: discount ? Math.round(((beforePrice - price) / beforePrice) * 100) : 0,
    size, patch, font, featured: Boolean(body.featured), stock,
    team: str(body.team, 'Team', 80), seassion: str(body.seassion, 'Season', 20), category,
    imagesLink: imagesLink.map((s) => s.trim()), patchsImg, fontsImg,
  };
}

/* ------------------------------- database ------------------------------- */

const client = new MongoClient(process.env.MONGODB_URL, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});
let products;
let testimonials;

async function connectDB() {
  await client.connect();
  const database = client.db('nique_sports');
  products = database.collection('products');
  testimonials = database.collection('testimonials');
  console.log('MongoDB connected');
}
connectDB().catch((err) => console.error('Mongo connection failed:', err));

/* ------------------------------- public routes ------------------------------- */

app.get('/', (req, res) => res.send('Hello World!'));
app.get('/hi', (req, res) => res.send('hi'));

app.get('/featured-products', needDb, wrap(async (req, res) => {
  const data = await products.aggregate([
    { $match: { featured: true } },
    { $project: { title: 1, imageLink: { $arrayElemAt: ['$imagesLink', 0] } } },
  ]).toArray();
  res.status(200).json({ data });
}));

app.get('/products/:id', needDb, wrap(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ data: null });
  const product = await products.findOne({ _id: new ObjectId(req.params.id) });
  if (!product) return res.status(404).json({ data: null });
  return res.status(200).json({ data: product });
}));

app.get('/testimonials', wrap(async (req, res) => {
  if (!testimonials) return res.status(503).json({ error: 'Database not connected' });
  const data = await testimonials.find({}).sort({ createdAt: -1 }).limit(20).toArray();
  res.status(200).json({ data });
}));

app.get('/products', needDb, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
  const data = await products.find({}).skip(skip).limit(limit).toArray();
  res.status(200).json({ data });
}));

/* ------------------------------- admin: products ------------------------------- */

app.post('/admin/products', needDb, wrap(async (req, res) => {
  const doc = { ...validateProduct(req.body), createdAt: new Date() };
  const result = await products.insertOne(doc);
  res.status(201).json({ data: { _id: result.insertedId, ...doc } });
}));

app.put('/admin/products/:id', needDb, wrap(async (req, res) => {
  const _id = objectId(req.params.id, 'product id');
  const doc = { ...validateProduct(req.body), updatedAt: new Date() };
  const result = await products.updateOne({ _id }, { $set: doc });
  if (result.matchedCount === 0) throw new HttpError(404, 'Product not found.');
  res.status(200).json({ data: { _id, ...doc } });
}));

app.delete('/admin/products/:id', needDb, wrap(async (req, res) => {
  const result = await products.deleteOne({ _id: objectId(req.params.id, 'product id') });
  if (result.deletedCount === 0) throw new HttpError(404, 'Product not found.');
  res.status(200).json({ data: { _id: req.params.id } });
}));

app.get('/admin/feature-count', needDb, wrap(async (req, res) => {
  res.status(200).json({ data: await products.countDocuments({ featured: true }) });
}));

// Dashboard "Running low" card (orders moved to the sheet, stock stays here)
app.get('/admin/low-stock', needDb, wrap(async (req, res) => {
  const threshold = Math.min(Math.max(parseInt(req.query.threshold, 10) || 5, 0), 1000);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 50);
  const filter = { stock: { $lte: threshold } };
  const [items, total] = await Promise.all([
    products.find(filter, { projection: { title: 1, stock: 1, imagesLink: { $slice: 1 } } }).sort({ stock: 1, title: 1 }).limit(limit).toArray(),
    products.countDocuments(filter),
  ]);
  res.status(200).json({
    data: { threshold, total, items: items.map((p) => ({ id: String(p._id), title: p.title ?? 'Untitled product', stock: Number(p.stock) || 0, image: p.imagesLink?.[0] ?? null })) },
  });
}));

/* ------------------------------- admin: stock (called by the website checkout) ------------------------------- */

function stockLines(body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) bad('items must be a list of 1-50 lines.');
  const totals = new Map();
  for (const it of items) {
    const id = objectId(it?.productId, 'productId').toHexString();
    const q = Number(it?.quantity);
    if (!Number.isInteger(q) || q < 1 || q > 100) bad('quantity must be a whole number between 1 and 100.');
    totals.set(id, (totals.get(id) ?? 0) + q);
  }
  return totals;
}

// All-or-nothing: either every line has enough stock and is decremented, or nothing changes.
app.post('/admin/stock/decrement', needDb, wrap(async (req, res) => {
  const totals = stockLines(req.body);
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const [id, qty] of totals) {
        const r = await products.updateOne({ _id: new ObjectId(id), stock: { $gte: qty } }, { $inc: { stock: -qty } }, { session });
        if (r.matchedCount !== 1) throw new HttpError(409, 'An item in your cart no longer has enough stock. Please review your cart.');
      }
    });
  } finally {
    await session.endSession();
  }
  res.status(200).json({ data: { ok: true } });
}));

// Used only to undo a decrement when saving the order fails.
app.post('/admin/stock/restock', needDb, wrap(async (req, res) => {
  const totals = stockLines(req.body);
  await products.bulkWrite([...totals].map(([id, qty]) => ({ updateOne: { filter: { _id: new ObjectId(id) }, update: { $inc: { stock: qty } } } })));
  res.status(200).json({ data: { ok: true } });
}));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
