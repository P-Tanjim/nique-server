const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());



const uri = process.env.MONGODB_URL;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const database = client.db("nique_sports");
    const products = database.collection("products");

    app.post('/add-product', async (req, res) => {
      // const product = req.body;
      const product = {
        "title": "BD Premium Home jersey 26/27",
        "desc": "This is a high quality jersey with editable font and patch. You can write your name on the back side of the jersey by just adding 150tk extra.",
        "imageLink": "https://ibb.co.com/chXmhrp7",
        "price": 1050,
        "size": ["L", "M", "XL"],
        "patch": false,
        "font": true,
        "featured": true,
        "stock": 10
      }

      const result = await products.insertOne(product);
      console.log(result);
      res.json(result);
    })

    app.get('/hi', async (req, res) => {
      res.send("hi")
    })









    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})

