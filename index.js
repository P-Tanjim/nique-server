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
    res.status(200).json({data: result});
  }
  catch (err) {
    res.status(500).json({message: "Something Went Wrong." })
  }

});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));