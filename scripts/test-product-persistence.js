require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const { app } = require('../server');
const Product = require('../server/models/Product');
const User = require('../server/models/User');

const PORT = 3099;
let server;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✖ FAIL: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✔ PASS: ${message}`);
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 TESTING PRODUCT CRUD & MONGODB PERSISTENCE');
  console.log('====================================================\n');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
  app.locals.mongoReady = true;

  server = http.createServer(app);
  await new Promise(resolve => server.listen(PORT, resolve));
  const BASE_URL = `http://127.0.0.1:${PORT}`;

  try {
    // 1. Create a test user and obtain auth token
    const testEmail = `test_crud_${Date.now()}@safeshelf.test`;
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Inventory Tester', email: testEmail, password: 'Password123!' })
    });
    const regData = await regRes.json();
    assert(regRes.status === 201, 'Test user registered');

    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'Password123!' })
    });
    const loginData = await loginRes.json();
    const token = loginData.token;
    const userId = loginData.user.id;
    assert(!!token, 'Auth token obtained for test user');

    // Count existing products in MongoDB before our test
    const initialDatasetCount = await Product.countDocuments({ source: 'dataset' });
    assert(initialDatasetCount === 112, `112 dataset products remain untouched (found ${initialDatasetCount})`);

    // 2. CREATE (POST /api/products)
    console.log('\n▶ Testing CREATE product via API...');
    const postPayload = {
      name: 'Organic Brown Rice 5kg',
      category: 'Atta, Rice & Dal',
      quantity: '5 kg',
      expiryDate: '2027-01-15',
      warrantyDate: '',
      description: 'High quality whole grain rice',
      imageUrl: '/images/rice.jpeg'
    };

    const createRes = await fetch(`${BASE_URL}/api/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(postPayload)
    });
    const createData = await createRes.json();
    assert(createRes.status === 201, `POST /api/products responded with HTTP 201 Created`);
    assert(createData.success === true, 'Response contains success: true');
    assert(createData.product && createData.product.id, 'Returned product has an ID');
    const createdProductId = createData.product.id;

    // Verify document exists directly in MongoDB safeshelf.products collection
    const mongoDoc = await Product.findById(createdProductId).lean();
    assert(mongoDoc !== null, 'Document verified in MongoDB safeshelf.products collection');
    assert(mongoDoc.name === 'Organic Brown Rice 5kg', 'MongoDB document name matches payload');
    assert(mongoDoc.source === 'user', 'MongoDB document source is "user"');
    assert(mongoDoc.userId.toString() === userId, 'MongoDB document userId matches authenticated user');
    assert(mongoDoc.quantity === '5 kg', 'MongoDB document quantity matches');

    // 3. READ (GET /api/products/inventory)
    console.log('\n▶ Testing READ inventory via API...');
    const getRes = await fetch(`${BASE_URL}/api/products/inventory`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const getData = await getRes.json();
    assert(getRes.status === 200, 'GET /api/products/inventory responded with HTTP 200 OK');
    assert(Array.isArray(getData.products), 'Returned products is an array');
    const foundInList = getData.products.find(p => p.id === createdProductId);
    assert(foundInList !== undefined, 'Created product is present in inventory listing');
    assert(foundInList.name === 'Organic Brown Rice 5kg', 'Inventory listing item name is correct');

    // Also test GET /api/products/:id
    const getSingleRes = await fetch(`${BASE_URL}/api/products/${createdProductId}`);
    const getSingleData = await getSingleRes.json();
    assert(getSingleRes.status === 200, 'GET /api/products/:id responded with HTTP 200 OK');
    assert(getSingleData.product && getSingleData.product.name === 'Organic Brown Rice 5kg', 'Product retrieved by ID');

    // 4. UPDATE (PUT /api/products/:id)
    console.log('\n▶ Testing UPDATE product via API...');
    const updatePayload = {
      name: 'Organic Brown Rice 10kg Jumbo',
      category: 'Atta, Rice & Dal',
      quantity: '10 kg',
      expiryDate: '2027-02-28',
      description: 'Updated description for jumbo pack'
    };

    const updateRes = await fetch(`${BASE_URL}/api/products/${createdProductId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(updatePayload)
    });
    const updateData = await updateRes.json();
    assert(updateRes.status === 200, 'PUT /api/products/:id responded with HTTP 200 OK');
    assert(updateData.success === true, 'Update response contains success: true');
    assert(updateData.product.name === 'Organic Brown Rice 10kg Jumbo', 'Returned product has updated name');
    assert(updateData.product.quantity === '10 kg', 'Returned product has updated quantity');

    // Verify change directly in MongoDB
    const updatedMongoDoc = await Product.findById(createdProductId).lean();
    assert(updatedMongoDoc.name === 'Organic Brown Rice 10kg Jumbo', 'MongoDB document name updated');
    assert(updatedMongoDoc.quantity === '10 kg', 'MongoDB document quantity updated');
    assert(updatedMongoDoc.expiryDate === '2027-02-28', 'MongoDB document expiryDate updated');

    // 5. ACCOUNT ISOLATION CHECK
    console.log('\n▶ Testing Multi-Tenant Account Isolation...');
    const userBEmail = `test_isolation_${Date.now()}@safeshelf.test`;
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'User B', email: userBEmail, password: 'Password123!' })
    });
    const loginBRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userBEmail, password: 'Password123!' })
    });
    const tokenB = (await loginBRes.json()).token;

    // User B tries to update User A's product -> 404
    const hijackRes = await fetch(`${BASE_URL}/api/products/${createdProductId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ name: 'Hacked Rice' })
    });
    assert(hijackRes.status === 404, 'User B cannot update User A product (HTTP 404)');

    // 6. DELETE (DELETE /api/products/:id)
    console.log('\n▶ Testing DELETE product via API...');
    const deleteRes = await fetch(`${BASE_URL}/api/products/${createdProductId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const deleteData = await deleteRes.json();
    assert(deleteRes.status === 200, 'DELETE /api/products/:id responded with HTTP 200 OK');
    assert(deleteData.success === true, 'Delete response contains success: true');

    // Verify deletion directly in MongoDB
    const deletedMongoDoc = await Product.findById(createdProductId).lean();
    assert(deletedMongoDoc === null, 'Document confirmed removed from MongoDB safeshelf.products');

    // Verify 112 dataset products are still untouched
    const finalDatasetCount = await Product.countDocuments({ source: 'dataset' });
    assert(finalDatasetCount === 112, `112 dataset products remain preserved after tests (found ${finalDatasetCount})`);

    // Clean up test users
    await User.deleteMany({ email: { $in: [testEmail, userBEmail] } });

    console.log('\n====================================================');
    console.log('🎉 ALL PRODUCT CRUD & MONGODB TESTS PASSED (16/16)');
    console.log('====================================================');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
  }
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

