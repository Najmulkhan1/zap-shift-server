const express = require('express')
const cors = require('cors')
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express()
app.use(express.static('public'));
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const port = process.env.PORT || 3000


const crypto = require("crypto");

const admin = require("firebase-admin");
const serviceAccount = require("./zap-shift.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

function generateTrackingId() {
    const prefix = "PRC";
    const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
    const randomPart = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `${prefix}-${date}-${randomPart}`;
}



// middleware
app.use(express.json())
app.use(cors())

const verifyFBToken = async (req, res, next) => {
    console.log('headers in the middleware', req.headers.authorization);
    const token = req.headers.authorization

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    try {
        const idToken = token.split(' ')[1]
        const decoded = await admin.auth().verifyIdToken(idToken)
        req.decoded_email = decoded.email
        console.log(decoded);

    } catch (error) {
        return res.status(401).send({ message: 'unauthorized access' })
    }
    next()
}

// mongodb
const uri = process.env.MONGODB_URL

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const run = async () => {
    try {
        await client.connect()

        const db = client.db('zap_shift_db')
        const parcelsCollections = db.collection('parcels')
        const usersCollections = db.collection('users')
        const paymentsCollections = db.collection('payments')
        const ridersCollections = db.collection('riders')

        // middle admin before allowing admin activity
        // must be used after verifyFBToken middleware
        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded_email
            const query = { email }
            const user = await usersCollections.findOne(query)



            if (!user || user.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }

            next()
        }


        // user related api

        app.get('/users', verifyFBToken, async (req, res) => {
            const searchText = req.query.searchText
            const query = {}
            if (searchText) {
                // query.displayName = {$regex: searchText, $options: 'i'}

                query.$or = [
                    {displayName : {$regex: searchText, $options: 'i'}},
                    {email: {$regex: searchText, $options: 'i'}}
                ]
            }

            const cursor = usersCollections.find(query).sort({ createAt: -1 }).limit(5)
            const result = await cursor.toArray()
            res.send(result)
        })

        

        app.get('/users/:email/role', async (req, res) => {
            const email = req.params.email
            const query = { email }
            const user = await usersCollections.findOne(query)
            res.send({ role: user?.role || 'user' })
        })

        app.post('/users', async (req, res) => {
            const user = req.body
            user.role = 'user'
            user.createAt = new Date()
            const email = user.email
            const userExist = await usersCollections.findOne({ email })
            if (userExist) {
                return res.send({ message: 'user exist' })
            }

            const result = await usersCollections.insertOne(user)
            res.send(result)
        })

        app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
            const id = req.params.id
            const roleInfo = req.body
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await usersCollections.updateOne(query, updateDoc)
            res.send(result)
        })

        // parcel api
        app.get('/parcels', async (req, res) => {
            const query = {}

            const { email, deliveryStatus } = req.query
            if (email) {
                query.senderEmail = email
            }

            if(deliveryStatus){
                query.deliveryStatus = deliveryStatus
            }

            const options = { sort: { createAt: -1 } }

            const cursor = parcelsCollections.find(query, options)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.get('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const result = await parcelsCollections.findOne(query)
            res.send(result)
        })

        app.post('/parcels', async (req, res) => {
            const parcel = req.body;
            parcel.createAt = new Date()
            const result = await parcelsCollections.insertOne(parcel)
            res.send(result)
        })

        app.patch('/parcels/:id', async(req,res) => {
            const { riderId, riderName, riderEmail} = req.body
            const id = req.params.id
            const query = {_id: new ObjectId(id)}

            const updateDoc ={
                $set: {
                    deliveryStatus: 'driver_assigned',
                    riderId: riderId,
                    riderName: riderName,
                    riderEmail: riderEmail
                }
            }

            const result = await parcelsCollections.updateOne(query, updateDoc)

            // update rider information

            const riderQuery = {_id: new ObjectId(riderId)}
            const riderUpdateDoc = {
                $set: {
                    workStatus: 'in_delivery'
                }
            }

            const riderResult = await ridersCollections.updateOne(riderQuery, riderUpdateDoc)

            res.send(riderResult)
        })

        app.delete('/parcels/:id', async (req, res) => {
            const id = req.params.id
            const query = { _id: new ObjectId(id) }

            const result = await parcelsCollections.deleteOne(query)
            res.send(result)
        })

        // payment related app
        app.post('/create-checkout-session', async (req, res) => {
            const paymentInfo = req.body;
            const amount = parseInt(paymentInfo.cost) * 100
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        // Provide the exact Price ID (for example, price_1234) of the product you want to sell
                        price_data: {
                            currency: 'USD',
                            unit_amount: amount,
                            product_data: {
                                name: paymentInfo.parcelName
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                customer_email: paymentInfo.senderEmail,
                metadata: {
                    parcelId: paymentInfo.parcelId,
                    parcelName: paymentInfo.parcelName,

                },
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            })

            // console.log(session);
            res.send({ url: session.url })
        })

        app.patch('/payment-success', async (req, res) => {
            const sessionId = req.query.session_id

            const session = await stripe.checkout.sessions.retrieve(sessionId)
            // console.log("session retrieve", session);
            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }

            const paymentExist = await paymentsCollections.findOne(query)
            if (paymentExist) {
                return res.send({ success: true, message: 'Payment already exist', transactionId, trackingId: paymentExist.trackingId })
            }

            const trackingId = generateTrackingId()

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup',
                        trackingId: trackingId
                    }
                }

                const result = await parcelsCollections.updateOne(query, update)

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }

                if (session.payment_status === 'paid') {
                    const resultPayment = await paymentsCollections.insertOne(payment)
                    res.send({
                        success: true,
                        modifyParcel: result,
                        trackingId: trackingId,
                        transactionId: session.payment_intent,
                        paymentInfo: resultPayment
                    })
                }

            }

            res.send({ success: false })

        })

        // payment related api
        app.get('/payments', verifyFBToken, async (req, res) => {
            const email = req.query.email
            const query = {}

            console.log("headers", req.headers);

            if (email) {
                query.customerEmail = email

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }
            }
            const cursor = paymentsCollections.find(query).sort({ paidAt: -1 })
            const result = await cursor.toArray()
            res.send(result)
        })

        // raider api

        app.get('/riders', async (req, res) => {
            const {status, district, workStatus} = req.query
            const query = {}
            if (status) {
                query.status = status
            }

            if(district){
                query.district = district
            }
            if(workStatus){
                query.workStatus = workStatus
            }
            const cursor = ridersCollections.find(query)
            const result = await cursor.toArray()
            res.send(result)
        })

        app.patch('/riders/:id', verifyFBToken, async (req, res) => {
            const status = req.body.status
            const id = req.params.id
            const query = { _id: new ObjectId(id) }
            const updateDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            const result = await ridersCollections.updateOne(query, updateDoc)

            if (status === 'approved') {
                const email = req.body.email
                const useQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await usersCollections.updateOne(useQuery, updateUser)
            }
            res.send(result)
        })

        app.delete('/riders/:id', async (req, res) => {
            const id = req.params.id

            const result = await ridersCollections.deleteOne({ _id: new ObjectId(id) })
            res.send(result)
        })

        app.post('/riders', async (req, res) => {
            const rider = req.body
            rider.status = 'pending'
            rider.createdAt = new Date()

            const result = await ridersCollections.insertOne(rider)
            res.send(result)
        })


        await client.db('admin').command({ ping: 1 })
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

    }
    finally { }
}

run().catch(console.dir)

app.get('/', (req, res) => {
    res.send("Zap server is running")
})

app.listen(port, () => {
    console.log(`http://localhost:${port}`);

})