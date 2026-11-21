/**
 * ============================================================================
 * SafeShelf V1 — Main Server Entry Point (server.js)
 * ============================================================================
 * Purpose:
 *   This file boots up the Node.js HTTP server using Express.js.
 *   It coordinates:
 *     1. Loading environment variables from .env
 *     2. Setting up security middleware (Helmet, Content Security Policy)
 *     3. Rate-limiting incoming requests to defend against brute-force attacks
 *     4. Registering REST API routes (Auth, Products, Cloud Sync, Uploads, CSV)
 *     5. Serving static assets (Frontend single-page app, uploaded images)
 *     6. Connecting to MongoDB (with graceful fallback if the database is offline)
 *     7. Centralizing error handling for predictable JSON responses
 * ============================================================================
 */

// Load environment variables (.env file) into process.env
require('dotenv').config();

// Import core web framework and utilities
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Import database models
const Product = require('./server/models/Product');

// Import route modules
const authRoutes = require('./server/routes/auth');
const productRoutes = require('./server/routes/products');
const uploadRoutes = require('./server/routes/uploads');
const userDataRoutes = require('./server/routes/userData');
const shoppingImportRoutes = require('./server/routes/shoppingImport');

// Initialize the Express application
const app = express();

// Track if we are running in production mode
const isProduction = process.env.NODE_ENV === 'production';

// ----------------------------------------------------------------------------
// JWT Secret Validation
// ----------------------------------------------------------------------------
// SafeShelf uses JSON Web Tokens (JWT) for user authentication.
// For security, the secret key must be at least 32 characters long and not a placeholder.
const jwtSecret = process.env.JWT_SECRET || '';
const validSecret = jwtSecret.length >= 32 && !/replace-with|change-me|your-secret/i.test(jwtSecret);

// In production, block startup if secret is missing or insecure
if (!validSecret && isProduction) {
  console.error('Startup blocked: configure a unique JWT_SECRET of at least 32 characters in the environment.');
  process.exit(1);
}

// In local development, warn the developer if tokens cannot be signed
if (!validSecret) console.warn('WARNING: Authentication tokens are disabled until a valid JWT_SECRET is configured.');
app.locals.jwtReady = validSecret;

// ----------------------------------------------------------------------------
// Security Middleware & HTTP Headers
// ----------------------------------------------------------------------------
// Disable the "X-Powered-By: Express" header so attackers cannot fingerprint the server
app.disable('x-powered-by');

// Configure reverse proxy trust (useful if deployed behind Nginx, Render, or Railway)
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// Helmet helps secure Express apps by setting various HTTP response headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-site' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'", 'https://dummyjson.com', 'https://api.emailjs.com'],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));

// Parse incoming JSON request bodies (limit payload size to 1 MB to prevent memory overflow)
app.use(express.json({ limit: '1mb', strict: true }));

// ----------------------------------------------------------------------------
// Rate Limiters (DDoS & Brute-Force Protection)
// ----------------------------------------------------------------------------
// General API rate limiter: max 300 requests per 15 minutes per IP
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
}));

// Stricter rate limiter for authentication routes: max 30 attempts per 15 minutes
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' }
}), authRoutes);

// ----------------------------------------------------------------------------
// API Route Registration
// ----------------------------------------------------------------------------
// Products catalog, search, and user inventory CRUD
app.use('/api/products', productRoutes);

// Multi-tenant cloud synchronization with Optimistic Concurrency Control (OCC)
app.use('/api/user-data', userDataRoutes);

// CSV shopping list streaming import
app.use('/api/shopping-import', shoppingImportRoutes);

// User image upload endpoint with magic-byte validation
app.use('/api/uploads', uploadRoutes);

// ----------------------------------------------------------------------------
// Static File Serving
// ----------------------------------------------------------------------------
// Serve uploaded images safely with nosniff headers and dotfiles disabled
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  fallthrough: false,
  dotfiles: 'deny',
  index: false,
  setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); }
}));

// Health check endpoint: reports whether the server, database, and auth are ready
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  database: app.locals.mongoReady ? 'connected' : 'offline',
  fallback: 'local dataset',
  authentication: app.locals.jwtReady ? 'configured' : 'not-configured'
}));

// Serve the frontend single-page application (index.html, css/, js/, images/, dataset_assets/)
app.use(express.static(__dirname, {
  index: 'index.html',
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    // HTML files should not be aggressively cached so updates appear immediately
    if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ----------------------------------------------------------------------------
// Global Error Handling Middleware
// ----------------------------------------------------------------------------
// Catches errors thrown anywhere in the Express pipeline and formats clean JSON
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = 500;

  // Handle Multer upload errors (e.g. file too large)
  if (err.name === 'MulterError') {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  }
  // Handle Mongoose schema validation or invalid ObjectId format errors
  else if (err.name === 'ValidationError' || err.name === 'CastError') {
    status = 400;
  }
  // Handle invalid or expired JWT authentication tokens
  else if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    status = 401;
  }
  // Handle explicit HTTP status codes attached to error objects
  else if (Number.isInteger(err.status)) {
    status = err.status;
  }

  // Log 500 internal server errors for backend debugging
  if (status >= 500) console.error('Request failed:', err.message);

  res.status(status).json({ error: status === 500 ? 'Server error. Check server logs.' : err.message });
});

// Determine server port (defaults to 3000 if PORT is not set in environment)
const port = Number(process.env.PORT) || 3000;

// ----------------------------------------------------------------------------
// Database Connection & Server Boot
// ----------------------------------------------------------------------------
async function start() {
  if (process.env.MONGODB_URI) {
    try {
      // Connect to MongoDB with a 4-second timeout to avoid long hangs if offline
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
      app.locals.mongoReady = true;
      console.log('MongoDB connected');
    } catch (e) {
      // Graceful degradation: SafeShelf can operate in local offline mode without MongoDB
      app.locals.mongoReady = false;
      console.warn('MongoDB unavailable; product API will use local dataset:', e.message);
    }
  } else {
    app.locals.mongoReady = false;
    console.warn('MONGODB_URI not configured; using local dataset fallback.');
  }

  // React dynamically to database disconnections and reconnections at runtime
  mongoose.connection.on('disconnected', () => {
    app.locals.mongoReady = false;
    console.warn('MongoDB disconnected; cloud data operations are paused.');
  });
  mongoose.connection.on('connected', () => {
    app.locals.mongoReady = true;
    console.log('MongoDB connection restored.');
  });

  // Start listening for incoming HTTP connections
  app.listen(port, () => console.log(`SafeShelf running at http://localhost:${port}`));
}

// Start automatically if run directly via `node server.js`
if (require.main === module) start();

// Export app and start function for integration tests
module.exports = { app, start };
