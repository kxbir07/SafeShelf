/**
 * ============================================================================
 * SafeShelf V1 — Product Catalog & Inventory CRUD Routes (products.js)
 * ============================================================================
 * Purpose:
 *   Manages two main types of product data:
 *     1. Master Catalog: Searchable pantry items for auto-complete and catalog browsing.
 *        Sources include local 112-item dataset (data/products.json) and optional
 *        external enrichment from DummyJSON, with a 30-minute in-memory cache.
 *     2. User Inventory CRUD: Allows authenticated users to create, view, update,
 *        and delete items in their personal pantry ledger.
 *
 * Key Architectural Highlights:
 *   - Offline Resilience: Catalog browsing and categories work even if MongoDB is offline.
 *   - Multi-Tenant Isolation: Queries enforce `userId: req.user.sub` so users
 *     can only access and modify their own inventory items.
 *   - Dual-Sync Architecture: Automatically keeps `products` collection and legacy
 *     `UserData.inventory` array synchronized for complete backward compatibility.
 * ============================================================================
 */

const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const UserData = require('../models/UserData');
const auth = require('../middleware/auth');
const localProducts = require('../../data/products.json');

const router = express.Router();

/**
 * Helper: Normalizes a string for clean, accent-free text comparison.
 *
 * @param {string} s - Input text.
 * @returns {string} Lowercase string with accents removed and non-alphanumeric chars replaced by spaces.
 */
const norm = s => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Normalizes an external API product object (e.g. from DummyJSON)
 * into SafeShelf's unified product schema.
 *
 * @param {Object} p - Raw product object from external API.
 * @returns {Object|null} Standardized SafeShelf product object, or null if invalid.
 */
function normalizeApi(p) {
  const name = String(p.title || p.name || '').trim();
  if (!name) return null;
  const rawImage = p.thumbnail || (Array.isArray(p.images) && p.images[0]) || p.image || '';
  let image = '';
  try {
    const u = new URL(rawImage);
    if (u.protocol === 'https:') image = u.href;
  } catch (_) {}
  return {
    id: `api_${p.id || norm(name).replace(/ /g, '-')}`,
    name,
    brand: p.brand || '',
    category: typeof p.category === 'string' ? p.category : (p.category && p.category.name) || 'Other',
    description: p.description || '',
    price: Number.isFinite(Number(p.price)) ? Number(p.price) : null,
    currency: 'USD',
    image,
    source: 'api',
    priceIsEstimate: false
  };
}

// In-memory cache for external third-party catalog items
let externalCache = {
  data: null,
  timestamp: 0
};
const EXTERNAL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes Time-To-Live (TTL)

/**
 * Fetches and caches product items from external catalog (DummyJSON).
 * Avoids outbound network latency on repeated requests by serving from cache.
 *
 * @returns {Promise<Array<Object>>} Array of normalized external catalog items.
 */
async function externalProducts() {
  if (process.env.EXTERNAL_PRODUCTS_ENABLED === 'false') return [];
  const now = Date.now();

  // Return cached results if still fresh within the 30-minute window
  if (externalCache.data && (now - externalCache.timestamp) < EXTERNAL_CACHE_TTL_MS) {
    return externalCache.data;
  }
  const url = process.env.EXTERNAL_PRODUCTS_URL || 'https://dummyjson.com/products?limit=100';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`External catalog returned ${response.status}`);
    const data = await response.json();
    const normalized = (data.products || data.items || []).map(normalizeApi).filter(Boolean);
    externalCache = { data: normalized, timestamp: now };
    return normalized;
  } catch (e) {
    // If fetch fails but we have stale cached data, gracefully return stale cache
    if (externalCache.data) {
      console.warn('External product fetch failed; returning cached external catalog:', e.message);
      return externalCache.data;
    }
    throw e;
  }
}

/**
 * Standardizes a MongoDB product document into a client-safe inventory response object.
 *
 * @param {Object} doc - Raw Mongoose document or lean JavaScript object.
 * @returns {Object|null} Formatted inventory item with consistent id, status, and dates.
 */
function formatInventoryProduct(doc) {
  if (!doc) return null;
  const id = doc._id ? doc._id.toString() : (doc.id || doc.customId || '');
  return {
    id,
    _id: id,
    userId: doc.userId ? doc.userId.toString() : '',
    name: doc.name || '',
    category: doc.category || '',
    quantity: doc.quantity || '1 unit',
    expiryDate: doc.expiryDate || '',
    warrantyDate: doc.warrantyDate || '',
    description: doc.description || '',
    imageUrl: doc.imageUrl || doc.image || '',
    image: doc.image || doc.imageUrl || '',
    status: doc.status || 'Safe',
    source: doc.source || 'user',
    catalogProductId: doc.catalogProductId || '',
    customId: doc.customId || id,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

// ----------------------------------------------------------------------------
// 1. GET /api/products/categories
// ----------------------------------------------------------------------------
// Returns an aggregated list of product categories along with item counts.
// Example response: [{ name: "Fruits", count: 17 }, { name: "Vegetables", count: 23 }]
// If MongoDB is connected, performs an aggregation pipeline on the database.
// If MongoDB is offline, falls back to computing counts from local JSON.
router.get('/categories', async (req, res, next) => {
  try {
    let items = localProducts;
    if (req.app.locals.mongoReady) {
      try {
        const docs = await Product.aggregate([
          { $match: { source: 'dataset' } },
          { $group: { _id: '$category', count: { $sum: 1 } } },
          { $sort: { _id: 1 } }
        ]);
        if (docs.length) return res.json(docs.map(d => ({ name: d._id, count: d.count })));
      } catch (dbErr) {
        console.warn('Mongo product categories query unavailable; using local dataset:', dbErr.message);
      }
    }
    // Offline fallback: tally counts directly from the local JSON array
    const counts = {};
    items.forEach(p => counts[p.category] = (counts[p.category] || 0) + 1);
    res.json(Object.keys(counts).sort().map(name => ({ name, count: counts[name] })));
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// 2. GET /api/products/inventory
// ----------------------------------------------------------------------------
// Protected endpoint: returns all pantry provisions belonging to the authenticated user.
// Enforces multi-tenant isolation: only returns items where userId matches req.user.sub.
router.get('/inventory', auth, async (req, res, next) => {
  try {
    if (!req.app.locals.mongoReady) {
      return res.status(503).json({ error: 'MongoDB is unavailable. Inventory products could not be retrieved from the database.' });
    }

    let docs = await Product.find({ userId: req.user.sub, source: 'user' }).sort({ createdAt: -1 }).lean();

    // Migration helper: If user has no documents in products collection yet,
    // check if UserData has inventory records for this user and migrate them.
    if (docs.length === 0) {
      try {
        const ud = await UserData.findOne({ userId: req.user.sub }).lean();
        if (ud && Array.isArray(ud.inventory) && ud.inventory.length > 0) {
          const toInsert = ud.inventory.map(item => ({
            userId: req.user.sub,
            name: String(item.name || 'Untitled').trim(),
            normalizedName: norm(item.name || 'Untitled'),
            category: item.category || 'Other',
            quantity: item.quantity || '1 unit',
            expiryDate: item.expiryDate || '',
            warrantyDate: item.warrantyDate || '',
            description: item.description || '',
            imageUrl: item.imageUrl || item.image || '',
            image: item.image || item.imageUrl || '',
            status: item.status || 'Safe',
            source: 'user',
            customId: item.id || undefined,
            catalogProductId: item.catalogProductId || ''
          }));
          await Product.insertMany(toInsert);
          docs = await Product.find({ userId: req.user.sub, source: 'user' }).sort({ createdAt: -1 }).lean();
        }
      } catch (migErr) {
        console.warn('Automatic UserData inventory migration notice:', migErr.message);
      }
    }

    const formatted = docs.map(formatInventoryProduct);
    res.set('Cache-Control', 'no-store').json({ products: formatted, count: formatted.length });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// 3. GET /api/products
// ----------------------------------------------------------------------------
// Searchable catalogue listing.
// Supports query parameters:
//   - ?q=keyword      (fuzzy search on name, brand, description)
//   - ?category=name  (filter by department)
// Merges local bundled items with external API items while suppressing duplicates.
router.get('/', async (req, res, next) => {
  try {
    // If request explicitly asks for inventory products and has auth
    if (req.query.inventory === 'true' || req.query.source === 'user') {
      if (!req.app.locals.mongoReady) {
        return res.status(503).json({ error: 'MongoDB is unavailable. Inventory products could not be retrieved.' });
      }
      return auth(req, res, async () => {
        const docs = await Product.find({ userId: req.user.sub, source: 'user' }).sort({ createdAt: -1 }).lean();
        const formatted = docs.map(formatInventoryProduct);
        return res.set('Cache-Control', 'no-store').json({ products: formatted, count: formatted.length });
      });
    }

    const q = norm(req.query.q);
    const category = String(req.query.category || '').trim();
    let dataset = localProducts;

    try {
      if (req.app.locals.mongoReady) {
        const filter = { source: 'dataset' };
        if (category) filter.category = category;
        if (q) filter.normalizedName = { $regex: q.split(' ').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), $options: 'i' };
        const docs = await Product.find(filter).lean();
        if (docs.length) dataset = docs.map(p => ({ ...p, id: `dataset_${p.datasetId}`, priceUnit: p.priceUnit, priceIsEstimate: p.priceIsEstimate }));
      }
    } catch (dbErr) {
      console.warn('Mongo product query unavailable; using local dataset:', dbErr.message);
    }

    dataset = dataset.map(p => ({ ...p, id: p.id || `dataset_${p.datasetId}`, source: 'dataset', image: p.image || '' }));
    let api = [];
    let apiAvailable = false;

    try {
      api = await externalProducts();
      apiAvailable = true;
    } catch (e) {
      console.warn('External product API unavailable; serving dataset only:', e.message);
    }

    const seen = new Set(dataset.map(p => norm(p.name)));
    const merged = [...dataset, ...api.filter(p => {
      const key = norm(p.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })];

    const filtered = merged.filter(p => (!q || norm(`${p.name} ${p.brand} ${p.description}`).includes(q)) && (!category || norm(p.category) === norm(category)));
    res.set('Cache-Control', 'no-store').json({ products: filtered, count: filtered.length, sources: { dataset: dataset.length, api: api.length, apiAvailable } });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// 4. POST /api/products/inventory (and POST /api/products)
// ----------------------------------------------------------------------------
// Creates a new custom inventory provision in MongoDB for the logged-in user.
// Validates:
//   - Product name (required, max 100 characters)
//   - Product category (required)
//   - Sanitizes quantity, dates, description, and photo URL
// Automatically syncs the new item with legacy UserData.inventory for compatibility.
async function handleCreateProduct(req, res, next) {
  try {
    if (!req.app.locals.mongoReady) {
      return res.status(503).json({ error: 'MongoDB is unavailable. Product could not be saved to the database.' });
    }

    const name = String(req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Product name is required.' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Product name must not exceed 100 characters.' });
    }

    const category = String(req.body.category || '').trim();
    if (!category) {
      return res.status(400).json({ error: 'Product category is required.' });
    }

    const quantity = req.body.quantity !== undefined ? String(req.body.quantity).trim() : '1 unit';
    const expiryDate = req.body.expiryDate !== undefined ? String(req.body.expiryDate).trim() : '';
    const warrantyDate = req.body.warrantyDate !== undefined ? String(req.body.warrantyDate).trim() : '';
    const description = req.body.description !== undefined ? String(req.body.description).slice(0, 500).trim() : '';
    const imageUrl = String(req.body.imageUrl || req.body.image || '').trim();
    const status = String(req.body.status || 'Safe').trim();
    const catalogProductId = String(req.body.catalogProductId || '').trim();
    const customId = req.body.id ? String(req.body.id).trim() : (req.body.customId ? String(req.body.customId).trim() : undefined);

    const doc = await Product.create({
      userId: req.user.sub,
      name,
      normalizedName: norm(name),
      category,
      quantity,
      expiryDate,
      warrantyDate,
      description,
      imageUrl,
      image: imageUrl,
      status,
      source: 'user',
      catalogProductId,
      customId
    });

    const formatted = formatInventoryProduct(doc);

    // Keep legacy UserData.inventory in sync for full backwards compatibility
    try {
      await UserData.findOneAndUpdate(
        { userId: req.user.sub },
        {
          $push: {
            inventory: {
              id: formatted.id,
              userId: req.user.sub,
              name,
              category,
              quantity,
              expiryDate,
              warrantyDate,
              description,
              imageUrl,
              status
            }
          }
        }
      );
    } catch (udErr) {
      console.warn('UserData inventory sync notice on product create:', udErr.message);
    }

    res.status(201).json({ success: true, product: formatted });
  } catch (e) { next(e); }
}

router.post('/inventory', auth, handleCreateProduct);
router.post('/', auth, handleCreateProduct);

// ----------------------------------------------------------------------------
// 5. GET /api/products/:id
// ----------------------------------------------------------------------------
// Retrieves single product by its MongoDB _id, customId, or dataset ID.
// Checks MongoDB first; if not found or DB is offline, checks local JSON catalog.
router.get('/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    let doc = null;

    if (req.app.locals.mongoReady) {
      if (mongoose.Types.ObjectId.isValid(id)) {
        doc = await Product.findById(id).lean();
      }
      if (!doc) {
        doc = await Product.findOne({ $or: [{ customId: id }, { datasetId: Number(id) || -1 }] }).lean();
      }
    }

    if (!doc) {
      const match = localProducts.find(p => String(p.id) === id || `dataset_${p.id}` === id);
      if (match) doc = { ...match, id: `dataset_${match.id}`, source: 'dataset' };
    }

    if (!doc) return res.status(404).json({ error: 'Product not found.' });
    res.json({ product: doc.source === 'user' ? formatInventoryProduct(doc) : doc });
  } catch (e) { next(e); }
});

// ----------------------------------------------------------------------------
// 6. PUT /api/products/:id (and PUT /api/products/inventory/:id)
// ----------------------------------------------------------------------------
// Updates an existing pantry inventory item in MongoDB.
// Multi-tenant security check: query must match `userId: req.user.sub`.
// If user B tries to update user A's product, the filter returns null (HTTP 404).
async function handleUpdateProduct(req, res, next) {
  try {
    if (!req.app.locals.mongoReady) {
      return res.status(503).json({ error: 'MongoDB is unavailable. Changes could not be saved to the database.' });
    }

    const id = req.params.id;
    const isObjectId = mongoose.Types.ObjectId.isValid(id);
    const filter = {
      userId: req.user.sub,
      source: 'user',
      $or: [
        ...(isObjectId ? [{ _id: id }] : []),
        { customId: id }
      ]
    };

    const updateFields = {};
    if (req.body.name !== undefined) {
      const trimmed = String(req.body.name).trim();
      if (!trimmed) return res.status(400).json({ error: 'Product name cannot be empty.' });
      if (trimmed.length > 100) return res.status(400).json({ error: 'Product name must not exceed 100 characters.' });
      updateFields.name = trimmed;
      updateFields.normalizedName = norm(trimmed);
    }
    if (req.body.category !== undefined) {
      const cat = String(req.body.category).trim();
      if (!cat) return res.status(400).json({ error: 'Product category cannot be empty.' });
      updateFields.category = cat;
    }
    if (req.body.quantity !== undefined) updateFields.quantity = String(req.body.quantity).trim();
    if (req.body.expiryDate !== undefined) updateFields.expiryDate = String(req.body.expiryDate).trim();
    if (req.body.warrantyDate !== undefined) updateFields.warrantyDate = String(req.body.warrantyDate).trim();
    if (req.body.description !== undefined) updateFields.description = String(req.body.description).slice(0, 500).trim();
    if (req.body.imageUrl !== undefined || req.body.image !== undefined) {
      const img = String(req.body.imageUrl || req.body.image || '').trim();
      updateFields.imageUrl = img;
      updateFields.image = img;
    }
    if (req.body.status !== undefined) updateFields.status = String(req.body.status).trim();
    updateFields.updatedAt = new Date();

    const updatedDoc = await Product.findOneAndUpdate(filter, { $set: updateFields }, { new: true, runValidators: true });
    if (!updatedDoc) {
      return res.status(404).json({ error: 'Product not found or unauthorized.' });
    }

    const formatted = formatInventoryProduct(updatedDoc);

    // Keep legacy UserData.inventory in sync
    try {
      const ud = await UserData.findOne({ userId: req.user.sub });
      if (ud && Array.isArray(ud.inventory)) {
        const itemIdx = ud.inventory.findIndex(item => item && (item.id === id || item._id === id || item.id === formatted.id));
        if (itemIdx !== -1) {
          Object.assign(ud.inventory[itemIdx], updateFields);
          ud.markModified('inventory');
          await ud.save();
        }
      }
    } catch (udErr) {
      console.warn('UserData inventory sync notice on product update:', udErr.message);
    }

    res.json({ success: true, product: formatted });
  } catch (e) { next(e); }
}

router.put('/inventory/:id', auth, handleUpdateProduct);
router.put('/:id', auth, handleUpdateProduct);

// ----------------------------------------------------------------------------
// 7. DELETE /api/products/:id (and DELETE /api/products/inventory/:id)
// ----------------------------------------------------------------------------
// Removes an inventory provision from MongoDB for the authenticated user.
// Strictly checks `userId: req.user.sub` so users cannot delete others' items.
async function handleDeleteProduct(req, res, next) {
  try {
    if (!req.app.locals.mongoReady) {
      return res.status(503).json({ error: 'MongoDB is unavailable. Product could not be deleted from the database.' });
    }

    const id = req.params.id;
    const isObjectId = mongoose.Types.ObjectId.isValid(id);
    const filter = {
      userId: req.user.sub,
      source: 'user',
      $or: [
        ...(isObjectId ? [{ _id: id }] : []),
        { customId: id }
      ]
    };

    const deletedDoc = await Product.findOneAndDelete(filter);
    if (!deletedDoc) {
      return res.status(404).json({ error: 'Product not found or unauthorized.' });
    }

    // Keep legacy UserData.inventory in sync
    try {
      const ud = await UserData.findOne({ userId: req.user.sub });
      if (ud && Array.isArray(ud.inventory)) {
        ud.inventory = ud.inventory.filter(item => item && item.id !== id && item._id !== id && item.id !== deletedDoc._id.toString());
        ud.markModified('inventory');
        await ud.save();
      }
    } catch (udErr) {
      console.warn('UserData inventory sync notice on product delete:', udErr.message);
    }

    res.json({ success: true, message: 'Product deleted successfully.' });
  } catch (e) { next(e); }
}

router.delete('/inventory/:id', auth, handleDeleteProduct);
router.delete('/:id', auth, handleDeleteProduct);

module.exports = router;
