/**
 * ============================================================================
 * SafeShelf V1 — Product & Pantry Item Model (Product.js)
 * ============================================================================
 * Purpose:
 *   Represents grocery and household pantry items in MongoDB.
 *
 * This schema handles two primary kinds of items:
 *   1. Master Catalog Products: Shared items from the 112-product seed dataset
 *      (`source: 'dataset'`) or third-party catalog (`source: 'api'`).
 *   2. Custom User Pantry Items: Provisions created directly by an authenticated
 *      user (`source: 'user'`, linked to their `userId`).
 * ============================================================================
 */

const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  // Numeric ID from the local 112-item JSON catalog (if applicable)
  datasetId: { type: Number, unique: true, sparse: true, index: true },

  // Human-readable product name (e.g. "Crisp Apples")
  name: { type: String, required: true, trim: true },

  // Lowercase, punctuation-free string used for fast, fuzzy catalog searching
  normalizedName: { type: String, required: true, index: true },

  // Optional brand name (e.g. "SafeShelf Organics")
  brand: { type: String, default: '' },

  // Category/Department (e.g. "Fruits", "Dairy, Bread & Eggs", "Cleaning & Household")
  category: { type: String, required: true, index: true },

  // Brief description or culinary notes
  description: { type: String, default: '' },

  // Estimated or recorded price
  price: { type: Number, default: null },
  currency: { type: String, default: 'INR' },
  priceUnit: { type: String, default: '' },
  priceIsEstimate: { type: Boolean, default: false },

  // Photo path or URL (e.g. "./dataset_assets/001-apple.jpeg" or "/uploads/uuid.png")
  image: { type: String, default: '' },
  imageUrl: { type: String, default: '' },

  // Provenance of the record:
  // - 'dataset': From the bundled 112-item offline JSON catalogue
  // - 'api': Enriched from external provider (DummyJSON)
  // - 'user': Added directly by an authenticated user
  source: { type: String, enum: ['dataset', 'api', 'user'], default: 'dataset', index: true },

  // Account ownership for user-created provisions (null for shared catalog items)
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },

  // Inventory tracking attributes
  quantity: { type: String, default: '1 unit' },
  expiryDate: { type: String, default: '' },       // Format: YYYY-MM-DD
  warrantyDate: { type: String, default: '' },     // Format: YYYY-MM-DD (for appliances)
  status: { type: String, default: 'Safe' },       // 'Safe', 'Expiring Soon', 'Expired'

  // Foreign keys / identifiers across legacy systems and imports
  catalogProductId: { type: String, default: '' },
  customId: { type: String, sparse: true, index: true },
  externalId: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true // Automatically manages createdAt and updatedAt
});

/**
 * Pre-validation Mongoose Middleware:
 * Automatically normalizes search text and synchronizes image properties
 * before saving to MongoDB.
 */
ProductSchema.pre('validate', function(next) {
  // Step 1: Generate normalized search text if missing
  // Example: "Alphonso Mango!" becomes "alphonso mango"
  if (this.name && !this.normalizedName) {
    this.normalizedName = String(this.name)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Step 2: Ensure backward compatibility between image and imageUrl fields
  if (!this.imageUrl && this.image) {
    this.imageUrl = this.image;
  } else if (!this.image && this.imageUrl) {
    this.image = this.imageUrl;
  }

  next();
});

// Compound indexes for high-speed catalog lookups and multi-tenant isolation
ProductSchema.index({ normalizedName: 1, category: 1 });
ProductSchema.index({ userId: 1, source: 1 });

module.exports = mongoose.model('Product', ProductSchema);
