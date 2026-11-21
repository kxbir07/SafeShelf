/**
 * ============================================================================
 * SafeShelf V1 — Authentication Middleware (auth.js)
 * ============================================================================
 * Purpose:
 *   An Express middleware function that protects private API routes.
 *   Before allowing a user to view or modify personal inventory data,
 *   this function verifies that the client provided a valid JSON Web Token (JWT).
 *
 * How it works:
 *   1. Checks that the server has an active JWT secret configured.
 *   2. Inspects the incoming "Authorization" HTTP request header for "Bearer <token>".
 *   3. Cryptographically verifies the token using HMAC-SHA256.
 *   4. Ensures the user ID embedded in the token (`sub`) is a valid MongoDB ObjectId.
 *   5. Attaches the decoded user data (`req.user`) to the request object so downstream
 *      routes know exactly who is making the request.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

/**
 * Express middleware to authenticate incoming API requests.
 *
 * @param {express.Request} req - The Express request object.
 * @param {express.Response} res - The Express response object.
 * @param {express.NextFunction} next - Callback to pass control to the next handler.
 */
module.exports = function auth(req, res, next) {
  // Step 1: Ensure JWT authentication has been properly initialized on the server
  if (!req.app.locals.jwtReady || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    return res.status(503).json({
      error: 'Authentication is not configured. Set a strong JWT_SECRET and restart the server.'
    });
  }

  // Step 2: Read the Authorization header (expected format: "Bearer <token>")
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    // Step 3: Verify the token signature and expiration date
    // match[1] contains the actual token string extracted by the regex
    const decoded = jwt.verify(match[1], process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Step 4: Ensure the token contains a valid user identifier (MongoDB ObjectId)
    if (!decoded || !decoded.sub || !mongoose.Types.ObjectId.isValid(decoded.sub)) {
      return res.status(401).json({ error: 'Session is invalid or expired.' });
    }

    // Step 5: Attach the authenticated user payload to req.user for downstream route access
    req.user = decoded;
    next();
  } catch (_) {
    // If jwt.verify throws (e.g. token expired, signature tampered), return 401 Unauthorized
    return res.status(401).json({ error: 'Session is invalid or expired.' });
  }
};
