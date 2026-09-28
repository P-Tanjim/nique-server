const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { randomBytes } = require('node:crypto');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URL;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let products; // filled in once connected
let testimonials;
let orders;

async function connectDB() {
  await client.connect();
  const database = client.db('nique_sports');
  products = database.collection("products");
  testimonials = database.collection("testimonials")
  orders = database.collection('orders');
  await orders.createIndex({ orderId: 1 }, { unique: true });
  console.log("MongoDB connected");
}
connectDB().catch((err) => console.error("Mongo connection failed:", err));

// Routes are always registered, no matter what happens above
app.get('/', (req, res) => res.send('Hello World!'));
app.get('/hi', (req, res) => res.send('hi'));

app.get('/featured-products', async (req, res) => {
  if (!products) return res.status(503).json({ error: 'Database not connected yet' });

  try {
    const result = await products.aggregate([
      {
        $match: {
          featured: true
        }
      },
      {
        $project: {
          title: 1,
          imageLink: { $arrayElemAt: ['$imagesLink', 0] }
        }
      }
    ]).toArray();
    res.status(200).json({ data: result });
  }
  catch (err) {
    res.status(500).json({ message: "Something Went Wrong." })
  }

});

app.get('/products/:id', async (req, res) => {
  try {
    const product = await products.findOne({ _id: new ObjectId(req.params.id) });
    if (!product) return res.status(404).json({ data: null });
    res.status(200).json({ data: product });
  } catch (err) {
    res.status(400).json({ data: null });
  }
});

app.get('/testimonials', async (req, res) => {
  if (!client) return res.status(503).json({ error: 'Database not connected' });

  try {
    // Fetch top 20 latest reviews
    const result = await testimonials
      .find({})
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    res.status(200).json({ data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.get('/products', async (req, res) => {
  if (!products) return res.status(503).json({ error: 'Database not connected yet' });

  try {
    const limit = parseInt(req.query.limit)
    const skip = parseInt(req.query.skip) || 0;
    const result = await products.find({}).skip(skip).limit(limit).toArray()

      res.status(200).json({ data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }

})

// --- NEW: used by the dashboard's "Add product" page -----------------------
// PLACEHOLDER — no admin/auth check yet. Before this ships, gate it behind
// whatever session/isAdmin check you use elsewhere, or anyone who finds
// this URL can insert products.
app.post('/admin/products', async (req, res) => {
  if (!products) {
    return res.status(503).json({ error: 'Database not connected yet' });
  }

  try {
    const {
      title,
      desc,
      price,
      size = [],
      patch = false,
      font = false,
      featured = false,
      discount = false,
      beforePrice,
      stock,
      team,
      seassion,
      category,
      imagesLink = [],
      patchsImg = [],
      fontsImg = [],
    } = req.body ?? {};

    if (!title?.trim() || price === undefined || price === null || !category?.trim()) {
      return res.status(400).json({ error: 'title, price and category are required.' });
    }

    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Price must be a valid non-negative number.' });
    }

    if (!Array.isArray(size) || size.length === 0) {
      return res.status(400).json({ error: 'At least one size must be selected.' });
    }

    const isDiscount = Boolean(discount);
    const beforePriceNum = isDiscount ? Number(beforePrice) : 0;

    if (isDiscount && (!Number.isFinite(beforePriceNum) || beforePriceNum <= priceNum)) {
      return res.status(400).json({
        error: 'Before price must be a valid amount greater than the selling price.',
      });
    }

    if (
      !Array.isArray(imagesLink) ||
      imagesLink.length === 0 ||
      imagesLink.some((image) => typeof image !== 'string' || !image.trim())
    ) {
      return res.status(400).json({ error: 'At least one valid product image is required.' });
    }

    function normalizePricedImages(items, label) {
      if (!Array.isArray(items)) {
        return { error: `${label} must be an array.` };
      }

      const normalized = [];

      for (const [index, item] of items.entries()) {
        const isLegacyUrl = typeof item === 'string';
        const image = isLegacyUrl ? item : item?.image;
        const rawPrice = isLegacyUrl ? 0 : item?.price;
        const optionPrice = Number(rawPrice);

        if (typeof image !== 'string' || !image.trim()) {
          return { error: `${label} option ${index + 1} must include an image URL.` };
        }

        if (
          rawPrice === undefined ||
          rawPrice === null ||
          rawPrice === '' ||
          !Number.isFinite(optionPrice) ||
          optionPrice < 0
        ) {
          return { error: `${label} option ${index + 1} must have a valid non-negative price.` };
        }

        normalized.push({ image: image.trim(), price: optionPrice });
      }

      return { value: normalized };
    }

    const patchOptions = patch
      ? normalizePricedImages(patchsImg, 'Patch')
      : { value: [] };

    if (patchOptions.error) {
      return res.status(400).json({ error: patchOptions.error });
    }
    if (patch && patchOptions.value.length === 0) {
      return res.status(400).json({ error: 'Patch is enabled but no patch options were provided.' });
    }

    const fontOptions = font
      ? normalizePricedImages(fontsImg, 'Font')
      : { value: [] };

    if (fontOptions.error) {
      return res.status(400).json({ error: fontOptions.error });
    }
    if (font && fontOptions.value.length === 0) {
      return res.status(400).json({ error: 'Font is enabled but no font options were provided.' });
    }

    const doc = {
      title: title.trim(),
      desc: desc ?? '',
      price: priceNum,
      discount: isDiscount,
      beforePrice: beforePriceNum,
      discountPercent: isDiscount
        ? Math.round(((beforePriceNum - priceNum) / beforePriceNum) * 100)
        : 0,
      size,
      patch: Boolean(patch),
      font: Boolean(font),
      featured: Boolean(featured),
      stock: Number(stock) || 0,
      team: team ?? '',
      seassion: seassion ?? '',
      category: category.trim(),
      imagesLink,
      patchsImg: patchOptions.value,
      fontsImg: fontOptions.value,
      createdAt: new Date(),
    };
    
    const result = await products.insertOne(doc);
    return res.status(201).json({ data: { _id: result.insertedId, ...doc } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong while creating the product.' });
  }
});

app.get('/admin/feature-count', async (req, res) => {
  if (!products) return res.status(503).json({ error: 'Database not connected yet' });

  try {
    const result = await products.countDocuments({featured: true})

    res.status(200).json({ data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
})

app.put('/admin/products/:id', async (req, res) => {
  if (!products) {
    return res.status(503).json({ error: 'Database not connected yet' });
  }

  let productId;
  try {
    productId = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid product id.' });
  }

  try {
    const {
      title,
      desc = '',
      price,
      size = [],
      patch = false,
      font = false,
      featured = false,
      discount = false,
      beforePrice,
      stock = 0,
      team = '',
      seassion = '',
      category,
      imagesLink = [],
      patchsImg = [],
      fontsImg = [],
    } = req.body ?? {};

    if (!title?.trim() || price === undefined || price === null || !category?.trim()) {
      return res.status(400).json({ error: 'title, price and category are required.' });
    }

    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: 'Price must be a valid non-negative number.' });
    }

    const stockNum = Number(stock);
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({ error: 'Stock must be a valid non-negative number.' });
    }

    if (!Array.isArray(size) || size.length === 0) {
      return res.status(400).json({ error: 'At least one size must be selected.' });
    }

    const isDiscount = Boolean(discount);
    const beforePriceNum = isDiscount ? Number(beforePrice) : 0;

    if (isDiscount && (!Number.isFinite(beforePriceNum) || beforePriceNum <= priceNum)) {
      return res.status(400).json({
        error: 'Before price must be greater than the selling price.',
      });
    }

    if (
      !Array.isArray(imagesLink) ||
      imagesLink.length === 0 ||
      imagesLink.some((image) => typeof image !== 'string' || !image.trim())
    ) {
      return res.status(400).json({ error: 'At least one valid product image is required.' });
    }

    function normalizePricedImages(items, label) {
      if (!Array.isArray(items)) {
        return { error: `${label} must be an array.` };
      }

      const normalized = [];

      for (const [index, item] of items.entries()) {
        const isLegacyUrl = typeof item === 'string';
        const image = isLegacyUrl ? item : item?.image;
        const rawPrice = isLegacyUrl ? 0 : item?.price;
        const optionPrice = Number(rawPrice);

        if (typeof image !== 'string' || !image.trim()) {
          return { error: `${label} option ${index + 1} must include an image URL.` };
        }

        if (
          rawPrice === undefined ||
          rawPrice === null ||
          rawPrice === '' ||
          !Number.isFinite(optionPrice) ||
          optionPrice < 0
        ) {
          return { error: `${label} option ${index + 1} must have a valid non-negative price.` };
        }

        normalized.push({ image: image.trim(), price: optionPrice });
      }

      return { value: normalized };
    }

    const patchOptions = patch
      ? normalizePricedImages(patchsImg, 'Patch')
      : { value: [] };

    if (patchOptions.error) {
      return res.status(400).json({ error: patchOptions.error });
    }
    if (patch && patchOptions.value.length === 0) {
      return res.status(400).json({ error: 'Patch is enabled but no patch options were provided.' });
    }

    const fontOptions = font
      ? normalizePricedImages(fontsImg, 'Font')
      : { value: [] };

    if (fontOptions.error) {
      return res.status(400).json({ error: fontOptions.error });
    }
    if (font && fontOptions.value.length === 0) {
      return res.status(400).json({ error: 'Font is enabled but no font options were provided.' });
    }

    const updatedProduct = {
      title: title.trim(),
      desc,
      price: priceNum,
      discount: isDiscount,
      beforePrice: beforePriceNum,
      discountPercent: isDiscount
        ? Math.round(((beforePriceNum - priceNum) / beforePriceNum) * 100)
        : 0,
      size,
      patch: Boolean(patch),
      font: Boolean(font),
      featured: Boolean(featured),
      stock: stockNum,
      team,
      seassion,
      category: category.trim(),
      imagesLink,
      patchsImg: patchOptions.value,
      fontsImg: fontOptions.value,
      updatedAt: new Date(),
    };

    const result = await products.updateOne(
      { _id: productId },
      { $set: updatedProduct }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    return res.status(200).json({
      data: { _id: productId, ...updatedProduct },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong while updating the product.' });
  }
});

app.delete('/admin/products/:id', async (req, res) => {
  if (!products) {
    return res.status(503).json({ error: 'Database not connected yet' });
  }

  let productId;
  try {
    productId = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid product id.' });
  }

  try {
    const result = await products.deleteOne({ _id: productId });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    return res.status(200).json({ data: { _id: req.params.id } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong while deleting the product.' });
  }
});

const DELIVERY_FEES = Object.freeze({
  'inside-dhaka': 70,
  'outside-dhaka': 120,
});
const MAX_ORDER_LINES = 30;
const MAX_QUANTITY_PER_LINE = 20;
const MAX_PATCHES_PER_LINE = 4;
const orderRateBuckets = new Map();

class OrderRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requiredText(value, label, maxLength, minLength = 1) {
  if (typeof value !== 'string') {
    throw new OrderRequestError(400, `${label} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new OrderRequestError(400, `${label} must be between ${minLength} and ${maxLength} characters.`);
  }
  return normalized;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, label, maxLength, 0);
}

function limitOrderRequests(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const windowMs = 10 * 60 * 1000;
  const maxRequests = 8;
  let bucket = orderRateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    orderRateBuckets.set(key, bucket);
  }
  bucket.count += 1;

  if (bucket.count > maxRequests) {
    res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many order attempts. Please try again shortly.' });
  }
  return next();
}

function findPricedOption(options, image, label) {
  if (!Array.isArray(options)) {
    throw new OrderRequestError(409, `${label} options are no longer available.`);
  }
  const found = options.find((entry) => (typeof entry === 'string' ? entry : entry?.image) === image);
  if (!found) throw new OrderRequestError(400, `The selected ${label.toLowerCase()} is invalid.`);

  const price = typeof found === 'string' ? 0 : Number(found.price);
  if (!Number.isFinite(price) || price < 0) {
    throw new OrderRequestError(409, `The selected ${label.toLowerCase()} has an invalid price.`);
  }
  return { image, price };
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

app.post('/orders', limitOrderRequests, async (req, res) => {
  if (!products || !orders) {
    return res.status(503).json({ error: 'Order service is not ready.' });
  }

  let session;
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OrderRequestError(400, 'A valid order body is required.');
    }

    const customerInput = body.customer;
    if (!customerInput || typeof customerInput !== 'object' || Array.isArray(customerInput)) {
      throw new OrderRequestError(400, 'Customer details are required.');
    }

    const customer = {
      name: requiredText(customerInput.name, 'Name', 100),
      address: requiredText(customerInput.address, 'Address', 500, 5),
      phone: requiredText(customerInput.phone, 'Phone number', 11),
      phone2: optionalText(customerInput.phone2, 'Alternate phone number', 11),
      note: optionalText(customerInput.note, 'Order note', 1000),
    };
    if (!/^01[3-9]\d{8}$/.test(customer.phone)) {
      throw new OrderRequestError(400, 'Enter a valid 11-digit phone number.');
    }
    if (customer.phone2 && !/^01[3-9]\d{8}$/.test(customer.phone2)) {
      throw new OrderRequestError(400, 'Enter a valid alternate phone number.');
    }

    const deliveryArea = body.deliveryArea;
    if (!Object.hasOwn(DELIVERY_FEES, deliveryArea)) {
      throw new OrderRequestError(400, 'Choose a valid delivery area.');
    }

    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ORDER_LINES) {
      throw new OrderRequestError(400, `An order must contain between 1 and ${MAX_ORDER_LINES} items.`);
    }

    const requestedItems = body.items.map((input, index) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new OrderRequestError(400, `Item ${index + 1} is invalid.`);
      }
      if (typeof input.productId !== 'string' || !/^[a-f\d]{24}$/i.test(input.productId)) {
        throw new OrderRequestError(400, `Item ${index + 1} has an invalid product ID.`);
      }
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_QUANTITY_PER_LINE) {
        throw new OrderRequestError(400, `Item ${index + 1} quantity must be between 1 and ${MAX_QUANTITY_PER_LINE}.`);
      }

      const size = requiredText(input.size, `Item ${index + 1} size`, 12);
      const customization = input.customization ?? {};
      if (typeof customization !== 'object' || Array.isArray(customization)) {
        throw new OrderRequestError(400, `Item ${index + 1} customization is invalid.`);
      }

      const customName = optionalText(customization.name, `Item ${index + 1} name`, 14).toUpperCase();
      const customNumber = optionalText(customization.number, `Item ${index + 1} number`, 2);
      if (customNumber && !/^\d{1,2}$/.test(customNumber)) {
        throw new OrderRequestError(400, `Item ${index + 1} number must contain up to two digits.`);
      }
      const fontImage = customization.fontImage === undefined || customization.fontImage === ''
        ? ''
        : requiredText(customization.fontImage, `Item ${index + 1} font image`, 2048);
      if (!fontImage && (customName || customNumber)) {
        throw new OrderRequestError(400, `Choose a font before adding name or number to item ${index + 1}.`);
      }

      if (input.patches !== undefined && !Array.isArray(input.patches)) {
        throw new OrderRequestError(400, `Item ${index + 1} patches must be a list.`);
      }
      const patches = input.patches ?? [];
      if (patches.length > MAX_PATCHES_PER_LINE || patches.some((patch) => typeof patch !== 'string' || patch.length > 2048)) {
        throw new OrderRequestError(400, `Item ${index + 1} has invalid patch selections.`);
      }
      if (new Set(patches).size !== patches.length) {
        throw new OrderRequestError(400, `Item ${index + 1} contains a duplicate patch.`);
      }

      return {
        productId: new ObjectId(input.productId),
        quantity: input.quantity,
        size,
        customName,
        customNumber,
        fontImage,
        patches,
      };
    });

    session = client.startSession();
    let savedOrder;

    await session.withTransaction(async () => {
      const productCache = new Map();
      const stockDemand = new Map();
      const orderItems = [];

      for (const input of requestedItems) {
        const productId = input.productId.toHexString();
        let product = productCache.get(productId);
        if (!product) {
          product = await products.findOne({ _id: input.productId }, { session });
          if (!product) throw new OrderRequestError(404, 'A product in your cart no longer exists.');
          productCache.set(productId, product);
        }

        if (!Array.isArray(product.size) || !product.size.includes(input.size)) {
          throw new OrderRequestError(400, `${product.title} does not have size ${input.size}.`);
        }

        const basePrice = Number(product.price);
        if (!Number.isFinite(basePrice) || basePrice < 0) {
          throw new OrderRequestError(409, `${product.title} has an invalid price.`);
        }

        let font = null;
        if (input.fontImage) {
          if (product.font !== true) throw new OrderRequestError(400, `${product.title} does not offer custom fonts.`);
          font = findPricedOption(product.fontsImg, input.fontImage, 'Font');
        }

        if ((input.customName || input.customNumber) && !font) {
          throw new OrderRequestError(400, `Select a font for ${product.title} before entering name or number.`);
        }

        if (input.patches.length && product.patch !== true) {
          throw new OrderRequestError(400, `${product.title} does not offer patches.`);
        }
        const patches = input.patches.map((image) => findPricedOption(product.patchsImg, image, 'Patch'));
        const optionsPrice = (font?.price ?? 0) + patches.reduce((sum, patch) => sum + patch.price, 0);
        const unitPrice = money(basePrice + optionsPrice);
        const originalBasePrice = product.discount === true ? Number(product.beforePrice) : 0;
        const originalUnitPrice = Number.isFinite(originalBasePrice) && originalBasePrice > basePrice
          ? money(originalBasePrice + optionsPrice)
          : null;

        stockDemand.set(productId, (stockDemand.get(productId) ?? 0) + input.quantity);
        orderItems.push({
          productId: input.productId,
          title: product.title,
          image: product.imagesLink?.[0] ?? '',
          size: input.size,
          quantity: input.quantity,
          basePrice: money(basePrice),
          font,
          patches,
          customization: {
            name: input.customName,
            number: input.customNumber,
          },
          unitPrice,
          originalUnitPrice,
          lineTotal: money(unitPrice * input.quantity),
        });
      }

      for (const [productId, quantity] of stockDemand) {
        const result = await products.updateOne(
          { _id: new ObjectId(productId), stock: { $gte: quantity } },
          { $inc: { stock: -quantity } },
          { session }
        );
        if (result.matchedCount !== 1) {
          throw new OrderRequestError(409, 'An item in your cart no longer has enough stock. Please review your cart.');
        }
      }

      const subtotal = money(orderItems.reduce((sum, item) => sum + item.lineTotal, 0));
      const deliveryFee = DELIVERY_FEES[deliveryArea];
      const now = new Date();
      const stamp = now.toISOString().slice(2, 10).replaceAll('-', '');
      const orderId = `NS-${stamp}-${randomBytes(4).toString('hex').toUpperCase()}`;

      savedOrder = {
        orderId,
        customer,
        items: orderItems,
        deliveryArea,
        deliveryFee,
        subtotal,
        total: money(subtotal + deliveryFee),
        paymentMethod: 'Cash on Delivery',
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      await orders.insertOne(savedOrder, { session });
    });

    return res.status(201).json({
      data: {
        orderId: savedOrder.orderId,
        status: savedOrder.status,
        total: savedOrder.total,
      },
    });
  } catch (error) {
    if (error instanceof OrderRequestError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Could not create a unique order ID. Please try again.' });
    }
    console.error('Order creation failed:', error);
    return res.status(500).json({ error: 'Could not place your order. Please try again.' });
  } finally {
    await session?.endSession();
  }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));