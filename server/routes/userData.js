/**
 * ============================================================================
 * SafeShelf V1 — User Cloud Data & OCC Sync Route (userData.js)
 * ============================================================================
 * Purpose:
 *   Synchronizes the user's pantry inventory and shopping list with MongoDB.
 *   Provides two endpoints:
 *     1. GET /api/user-data — Retrieve current cloud-saved inventory and shopping list.
 *     2. PUT /api/user-data — Save local inventory changes to the cloud using
 *        Optimistic Concurrency Control (OCC) to prevent data loss.
 *
 * How Optimistic Concurrency Control (OCC) Works:
 *   Imagine you have SafeShelf open on your laptop and your phone:
 *   1. Both start with version 1.
 *   2. On your phone, you add "Milk". Your phone sends version 1. The server
 *      accepts it and increments the cloud version to 2.
 *   3. On your laptop, you add "Eggs" and send version 1.
 *   4. The server sees version 1 is outdated (current cloud version is 2).
 *   5. The server rejects the laptop's request with HTTP 409 Conflict and sends
 *      back the latest cloud data so the laptop can merge instead of overwriting!
 * ============================================================================
 */

const express = require('express');
const UserData = require('../models/UserData');
const auth = require('../middleware/auth');

const router = express.Router();

// Require valid authentication across all user-data endpoints
router.use(auth);

// Return HTTP 503 if MongoDB is disconnected so the client knows cloud sync is paused
router.use((req, res, next) =>
  req.app.locals.mongoReady
    ? next()
    : res.status(503).json({
        error: 'Your saved data is temporarily unavailable because MongoDB is disconnected. Local cached data remains on this device.'
      })
);

// ----------------------------------------------------------------------------
// GET /api/user-data
// ----------------------------------------------------------------------------
// Fetches the authenticated user's cloud-saved inventory and shopping list
router.get('/', async (req, res, next) => {
  try {
    // Find the single UserData document owned by the logged-in user (req.user.sub)
    const doc = await UserData.findOne({ userId: req.user.sub }).lean();

    // Prevent caching so the browser always receives fresh data
    res.set('Cache-Control', 'no-store').json({
      inventory: doc?.inventory || [],
      shoppingList: doc?.shoppingList || [],
      updatedAt: doc?.updatedAt || null,
      version: doc ? (Number(doc.version) || 1) : 0
    });
  } catch (e) {
    next(e);
  }
});

// ----------------------------------------------------------------------------
// PUT /api/user-data
// ----------------------------------------------------------------------------
// Saves updated inventory and shopping list arrays to MongoDB using OCC versioning
router.put('/', async (req, res, next) => {
  try {
    const inventory = Array.isArray(req.body.inventory) ? req.body.inventory : null;
    const shoppingList = Array.isArray(req.body.shoppingList) ? req.body.shoppingList : null;

    // Validate that payload contains arrays
    if (!inventory || !shoppingList) {
      return res.status(400).json({ error: 'inventory and shoppingList must be arrays.' });
    }

    // Impose reasonable safety caps on item counts
    if (inventory.length > 5000 || shoppingList.length > 2000) {
      return res.status(413).json({ error: 'Too many records.' });
    }

    // Limit payload size to 900 KB to protect MongoDB memory
    const serialized = JSON.stringify({ inventory, shoppingList });
    if (Buffer.byteLength(serialized, 'utf8') > 900 * 1024) {
      return res.status(413).json({ error: 'Saved data exceeds the 900 KB limit.' });
    }

    // Ensure every record in the array is a plain JSON object
    const isPlainRecord = value =>
      value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
    if (![...inventory, ...shoppingList].every(isPlainRecord)) {
      return res.status(400).json({ error: 'Each inventory and shopping-list entry must be an object.' });
    }

    // Require an integer version number for OCC
    const clientVersion = req.body.version !== undefined && req.body.version !== null ? Number(req.body.version) : null;
    if (clientVersion === null || !Number.isInteger(clientVersion) || clientVersion < 0) {
      return res.status(400).json({
        error: 'A non-negative integer version is required for optimistic concurrency control.'
      });
    }

    // Find the user's existing cloud document
    const existing = await UserData.findOne({ userId: req.user.sub });

    // ------------------------------------------------------------------------
    // Case 1: First-time document creation (Document does not exist yet)
    // ------------------------------------------------------------------------
    if (!existing) {
      // First save must provide clientVersion === 0
      if (clientVersion !== 0) {
        return res.status(409).json({
          error: 'Conflict: Document does not exist on server yet, but client sent a non-zero version.',
          currentVersion: 0,
          serverData: null
        });
      }

      try {
        const newDoc = await UserData.create({
          userId: req.user.sub,
          inventory,
          shoppingList,
          version: 1
        });
        return res.set('Cache-Control', 'no-store').json({
          ok: true,
          version: newDoc.version,
          updatedAt: newDoc.updatedAt
        });
      } catch (err) {
        // Handle race condition: another concurrent request created the document first
        if (err.code === 11000) {
          const conflictDoc = await UserData.findOne({ userId: req.user.sub }).lean();
          return res.status(409).json({
            error: 'Conflict: Another session created cloud data concurrently.',
            currentVersion: conflictDoc ? (Number(conflictDoc.version) || 1) : 1,
            serverData: {
              inventory: conflictDoc?.inventory || [],
              shoppingList: conflictDoc?.shoppingList || [],
              updatedAt: conflictDoc?.updatedAt || null
            }
          });
        }
        throw err;
      }
    }

    // ------------------------------------------------------------------------
    // Case 2: Document already exists — verify version matches
    // ------------------------------------------------------------------------
    const currentServerVersion = Number(existing.version) || 1;
    if (clientVersion !== currentServerVersion) {
      return res.status(409).json({
        error: 'Conflict: Your data is out of date. Another session has saved newer changes.',
        currentVersion: currentServerVersion,
        serverData: {
          inventory: existing.inventory || [],
          shoppingList: existing.shoppingList || [],
          updatedAt: existing.updatedAt
        }
      });
    }

    // ------------------------------------------------------------------------
    // Case 3: Atomic update with version filter
    // ------------------------------------------------------------------------
    const filter = {
      _id: existing._id,
      userId: req.user.sub,
      $or: [
        { version: clientVersion },
        { version: { $exists: false } }
      ]
    };
    const update = {
      $set: {
        inventory,
        shoppingList,
        version: currentServerVersion + 1
      }
    };
    const updatedDoc = await UserData.findOneAndUpdate(filter, update, { new: true, runValidators: true });

    // If updatedDoc is null, an interleaving write occurred right between find and update
    if (!updatedDoc) {
      const latest = await UserData.findOne({ userId: req.user.sub }).lean();
      return res.status(409).json({
        error: 'Conflict: Another session updated this document concurrently.',
        currentVersion: latest ? (Number(latest.version) || 1) : 1,
        serverData: {
          inventory: latest?.inventory || [],
          shoppingList: latest?.shoppingList || [],
          updatedAt: latest?.updatedAt || null
        }
      });
    }

    // Successfully saved! Return updated version number to the client
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      version: updatedDoc.version,
      updatedAt: updatedDoc.updatedAt
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
