const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  datasetId: { type: Number, unique: true, sparse: true, index: true },
  name: { type: String, required: true, trim: true },
  normalizedName: { type: String, required: true, index: true },
  brand: { type: String, default: '' },
  category: { type: String, required: true, index: true },
  description: { type: String, default: '' },
  price: { type: Number, default: null },
  currency: { type: String, default: 'INR' },
  priceUnit: { type: String, default: '' },
  priceIsEstimate: { type: Boolean, default: false },
  image: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  source: { type: String, enum: ['dataset', 'api', 'user'], default: 'dataset', index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  quantity: { type: String, default: '1 unit' },
  expiryDate: { type: String, default: '' },
  warrantyDate: { type: String, default: '' },
  status: { type: String, default: 'Safe' },
  catalogProductId: { type: String, default: '' },
  customId: { type: String, sparse: true, index: true },
  externalId: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

ProductSchema.pre('validate', function(next) {
  if (this.name && !this.normalizedName) {
    this.normalizedName = String(this.name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  if (!this.imageUrl && this.image) {
    this.imageUrl = this.image;
  } else if (!this.image && this.imageUrl) {
    this.image = this.imageUrl;
  }
  next();
});

ProductSchema.index({ normalizedName: 1, category: 1 });
ProductSchema.index({ userId: 1, source: 1 });

module.exports = mongoose.model('Product', ProductSchema);
