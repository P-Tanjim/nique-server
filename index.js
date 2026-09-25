const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
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

async function connectDB() {
  await client.connect();
  const database = client.db('nique_sports');
  products = database.collection("products");
  testimonials = database.collection("testimonials")
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

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));