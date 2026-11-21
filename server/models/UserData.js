/**
 * ============================================================================
 * SafeShelf V1 — User Cloud Data & OCC Model (UserData.js)
 * ============================================================================
 * Purpose:
 *   Stores cloud-synced user data (the active pantry inventory and shopping list)
 *   associated with an authenticated user account.
 *
 * Why this model exists:
 *   SafeShelf is designed as an "offline-first" application. Users can edit
 *   their pantry locally on their device, and changes synchronize with MongoDB
 *   whenever a network connection is available.
 *
 * Optimistic Concurrency Control (OCC):
 *   The `version` field tracks document revisions. Whenever the client saves
 *   updates, it submits its known version number. If another browser tab or device
 *   saved a newer revision first, the server detects the conflict (HTTP 409)
 *   so data is never silently overwritten or lost.
 * ============================================================================
 */

const mongoose = require('mongoose');

const UserDataSchema = new mongoose.Schema({
  // The owner user account (one UserData document per user)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },

  // Active pantry inventory provisions array
  inventory: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },

  // Active shopping list items array
  shoppingList: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },

  // Integer revision number for Optimistic Concurrency Control (starts at 1)
  version: {
    type: Number,
    default: 1,
    min: 1
  }
}, {
  timestamps: true, // Automatically track createdAt and updatedAt
  minimize: false   // Preserve empty objects/arrays in MongoDB storage
});

module.exports = mongoose.model('UserData', UserDataSchema);
