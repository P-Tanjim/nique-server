const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');

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

async function connectDB() {
  await client.connect();
  const database = client.db('nique_sports');
  products = database.collection("products");
  console.log("MongoDB connected");
}
connectDB().catch((err) => console.error("Mongo connection failed:", err));

// Routes are always registered, no matter what happens above
app.get('/', (req, res) => res.send('Hello World!'));
app.get('/hi', (req, res) => res.send('hi'));

app.post('/add-product', async (req, res) => {
  if (!products) return res.status(503).json({ error: 'Database not connected yet' });
  const result = await products.insertOne(req.body);
  res.json(result);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));