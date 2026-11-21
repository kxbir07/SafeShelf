/**
 * ============================================================================
 * SafeShelf V1 — User Account Model (User.js)
 * ============================================================================
 * Purpose:
 *   Defines the Mongoose schema for user account records in MongoDB.
 *   Stores account identity, login credentials (hashed passwords only),
 *   and user roles for authorization.
 *
 * Fields:
 *   - name: The user's display name (trimmed, 2-80 characters).
 *   - email: Unique email address used for login and notifications (lowercased).
 *   - passwordHash: Strong bcrypt hash of the password (never store plain text!).
 *   - role: Authorization level ('user' or 'admin').
 *   - timestamps: Automatically manages createdAt and updatedAt fields.
 * ============================================================================
 */

const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  }
}, {
  timestamps: true // Automatically adds createdAt and updatedAt timestamps
});

module.exports = mongoose.model('User', UserSchema);
