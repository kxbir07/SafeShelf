/**
 * ============================================================================
 * SafeShelf V1 — Authentication & Account Routes (auth.js)
 * ============================================================================
 * Purpose:
 *   Handles user account lifecycle:
 *     1. POST /api/auth/register — Create a new account with hashed password
 *     2. POST /api/auth/login    — Verify password and issue a JWT session token
 *     3. PUT  /api/auth/profile  — Update account profile (name, email)
 *
 * Security:
 *   - Passwords are never saved in plain text; they are hashed using bcrypt
 *     with 12 salt rounds.
 *   - Issues HMAC-SHA256 JWT tokens containing the user ID in the `sub` claim.
 *   - Requires MongoDB to be active; returns HTTP 503 if the database is offline.
 * ============================================================================
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const router = express.Router();

/**
 * Middleware: Verify that the server has an active JWT_SECRET.
 * If not, authentication services cannot securely sign tokens.
 */
const requireJwt = (req, res, next) =>
  req.app.locals.jwtReady
    ? next()
    : res.status(503).json({
        error: 'Authentication is not configured. Set a strong JWT_SECRET and restart the server.'
      });

/**
 * Middleware: Verify that MongoDB is currently connected.
 * If MongoDB is down, user account operations return HTTP 503 with a friendly message.
 */
const requireDatabase = (req, res, next) =>
  req.app.locals.mongoReady
    ? next()
    : res.status(503).json({
        error: 'Account service is unavailable because MongoDB is disconnected. Please try again shortly.'
      });

// Apply prerequisite checks across all authentication endpoints
router.use(requireJwt, requireDatabase);

/**
 * Helper: Generate a signed JSON Web Token (JWT) for a user.
 *
 * @param {Object} user - The Mongoose user document.
 * @returns {string} Signed JWT string valid for the configured duration (default: 7 days).
 */
const tokenFor = user =>
  jwt.sign(
    { sub: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// ----------------------------------------------------------------------------
// POST /api/auth/register
// ----------------------------------------------------------------------------
// Registers a new user account with validated email, name, and hashed password.
router.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    // Input validation: ensure valid lengths and email format
    if (name.length < 2 || name.length > 80 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Enter a name, valid email and password of at least 8 characters.' });
    }

    // Check if an account with this email already exists
    if (await User.exists({ email })) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash the password with bcrypt (12 rounds) and create the user in MongoDB
    const user = await User.create({
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12)
    });

    // Return the session token and user profile
    res.status(201).json({
      token: tokenFor(user),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    next(e);
  }
});

// ----------------------------------------------------------------------------
// POST /api/auth/login
// ----------------------------------------------------------------------------
// Authenticates user credentials and returns a JWT session token.
router.post('/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    // Look up the user record by email
    const user = await User.findOne({ email });

    // Compare the submitted password against the stored bcrypt hash
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Successful login: issue a fresh JWT token
    res.json({
      token: tokenFor(user),
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    next(e);
  }
});

// Import authentication middleware for protected account routes
const auth = require('../middleware/auth');

// ----------------------------------------------------------------------------
// PUT /api/auth/profile
// ----------------------------------------------------------------------------
// Updates the authenticated user's profile information (name and email).
router.put('/profile', auth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    // Validate name length and email pattern
    if (name.length < 2 || name.length > 80 || !/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid name (at least 2 characters) and a valid email.' });
    }

    // Ensure the new email is not already claimed by a DIFFERENT user account
    const duplicate = await User.findOne({ email, _id: { $ne: req.user.sub } });
    if (duplicate) {
      return res.status(409).json({ error: 'This email is already in use by another account.' });
    }

    // Update user record in MongoDB and return the updated profile
    const user = await User.findByIdAndUpdate(req.user.sub, { $set: { name, email } }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({
      ok: true,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
