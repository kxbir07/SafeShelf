/**
 * ============================================================================
 * SafeShelf V1 — Image Upload Route (uploads.js)
 * ============================================================================
 * Purpose:
 *   Handles custom product photo uploads via POST /api/uploads/image.
 *   Enables users to attach photos from their camera or device when adding
 *   or editing pantry items.
 *
 * Security Architecture (Defense in Depth):
 *   1. Authentication: Only logged-in users with a valid JWT token can upload files.
 *   2. Memory Buffering: Files are kept in RAM (`memoryStorage`) during inspection.
 *   3. File Size Limit: Maximum 5 MB per upload to prevent server memory exhaustion.
 *   4. MIME Type Whitelist: Accepts only image/jpeg, image/png, and image/webp.
 *   5. Binary Magic-Byte Inspection: Inspects the raw first bytes of the file to
 *      verify it is genuinely an image (preventing file-extension spoofing).
 *   6. Secure Filenames: Generates cryptographic UUIDs so original filenames
 *      cannot cause directory traversal or collisions.
 * ============================================================================
 */

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const auth = require('../middleware/auth');

const router = express.Router();

// Destination directory for saved user uploads
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// File size constraint: 5 Megabytes in bytes
const MAX_BYTES = 5 * 1024 * 1024;

// Set of allowed client-reported MIME types
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Configure Multer multipart/form-data parser
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 10, parts: 12 },
  fileFilter: (req, file, cb) =>
    ALLOWED_MIME.has(file.mimetype)
      ? cb(null, true)
      : cb(Object.assign(new Error('Only JPEG, PNG or WebP images are allowed.'), { status: 400 }))
});

/**
 * Inspects the binary header ("magic bytes") of an uploaded file buffer.
 *
 * Explanation for beginners:
 * File extensions like ".png" or ".jpg" can be forged by renaming any file.
 * However, every real image format has specific "signature bytes" right at the
 * start of the file. Checking these bytes guarantees the file is actually an image.
 *
 * @param {Buffer} buffer - The binary file contents in memory.
 * @returns {{ ext: string, mime: string } | null} The detected image format or null if unknown.
 */
function detectImage(buffer) {
  // PNG signature: 8 specific bytes [137, 80, 78, 71, 13, 10, 26, 10]
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { ext: '.png', mime: 'image/png' };
  }
  // JPEG signature: starts with FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  // WebP signature: "RIFF" at byte 0 and "WEBP" at byte 8
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

// ----------------------------------------------------------------------------
// POST /api/uploads/image
// ----------------------------------------------------------------------------
// Protected endpoint: receives a single multipart file named "image"
router.post('/image', auth, (req, res, next) => {
  upload.single('image')(req, res, async err => {
    if (err) return next(err);
    try {
      // Ensure a file was actually attached to the request
      if (!req.file) return res.status(400).json({ error: 'Choose an image file.' });

      // Verify the file's binary magic bytes match the reported image type
      const detected = detectImage(req.file.buffer);
      if (!detected || detected.mime !== req.file.mimetype) {
        return res.status(400).json({ error: 'The uploaded file content does not match a supported image type.' });
      }

      // Ensure the destination uploads/ directory exists
      await fs.mkdir(UPLOAD_DIR, { recursive: true });

      // Generate a collision-free UUID filename (e.g. "a3b8c2d1-....png")
      const filename = `${crypto.randomUUID()}${detected.ext}`;

      // Write file to disk with strict permissions (0o640: owner read/write, group read)
      await fs.writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer, { flag: 'wx', mode: 0o640 });

      // Return the public URL and filename to the frontend
      res.status(201).json({ url: `/uploads/${filename}`, filename });
    } catch (e) {
      next(e);
    }
  });
});

module.exports = router;
