/**
 * ============================================================================
 * SafeShelf V1 — CSV Shopping List Import Route (shoppingImport.js)
 * ============================================================================
 * Purpose:
 *   Handles bulk shopping-list item imports from CSV files via POST /api/shopping-import/preview.
 *   Allows users to export a grocery list from Excel/Sheets and preview items
 *   before adding them to their SafeShelf account.
 *
 * How it works:
 *   1. Uploads the CSV file into memory using Multer (max 1 MB).
 *   2. Strips any UTF-8 Byte Order Mark (BOM: \uFEFF).
 *   3. Parses the CSV according to RFC 4180 rules (quotes, commas, newlines).
 *   4. Identifies column headers flexibly (e.g. "itemName", "product", "qty").
 *   5. Validates row lengths, sanitizes text, and rejects control characters.
 *   6. Returns a structured JSON preview with valid items and error details.
 * ============================================================================
 */

const express = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');

const router = express.Router();

// Multer memory-storage configuration for CSV file uploads (max 1 MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = String(file.originalname || '').toLowerCase().split('.').pop();
    if (ext !== 'csv' || (file.mimetype && !['text/csv', 'application/vnd.ms-excel', 'application/csv', 'text/plain', 'application/octet-stream'].includes(file.mimetype))) {
      return cb(Object.assign(new Error('Upload a .csv file only.'), { status: 400 }));
    }
    cb(null, true);
  }
});

/**
 * Parses raw CSV text into a 2D array of rows and columns (RFC 4180 compliant).
 *
 * Beginner explanation:
 * CSV files separate columns with commas. However, if a cell contains a comma
 * (like "Apples, Gala"), the text must be enclosed in double quotes. This parser
 * carefully tracks whether it is currently inside quotes so commas aren't split incorrectly.
 *
 * @param {string} text - The raw CSV file text.
 * @returns {Array<Array<string>>} Array of rows, where each row is an array of cell strings.
 * @throws {Error} If quotes are unbalanced or the file exceeds 500 rows.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      // Handle escaped quote inside a quoted field (represented as two double quotes "")
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        // Closing quote found
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      // Opening quote for a quoted field
      quoted = true;
    } else if (ch === ',') {
      // Column separator: finish current cell and start next
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      // Row separator: finish current row
      row.push(field.trim());
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  // Reject malformed CSVs with missing closing quotes
  if (quoted) throw Object.assign(new Error('CSV contains an unclosed quoted field.'), { status: 400 });

  // Push final trailing row if present
  if (field !== '' || row.length) {
    row.push(field.trim());
    if (row.some(v => v !== '')) rows.push(row);
  }

  // Enforce a strict row limit to prevent Denial of Service (DoS) attacks
  if (rows.length > 501) throw Object.assign(new Error('CSV is limited to 500 data rows.'), { status: 413 });

  return rows;
}

// ----------------------------------------------------------------------------
// POST /api/shopping-import/preview
// ----------------------------------------------------------------------------
// Protected route: parses and previews CSV rows before they are saved to inventory
router.post('/preview', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a CSV file first.' });

  try {
    // Convert binary buffer to string and remove optional UTF-8 Byte Order Mark (BOM)
    const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const rows = parseCsv(text);

    if (rows.length < 2) {
      return res.status(400).json({ error: 'CSV must contain a header and at least one item.' });
    }

    // Extract and normalize header column names (e.g. "Item Name" -> "itemname")
    const headers = rows.shift().map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

    // Flexible column matching: find indexes of name, quantity, and category columns
    const nameIndex = headers.findIndex(h => ['itemname', 'item', 'name', 'product', 'productname'].includes(h));
    const qtyIndex = headers.findIndex(h => ['quantity', 'qty', 'amount'].includes(h));
    const categoryIndex = headers.findIndex(h => ['category', 'department'].includes(h));

    if (nameIndex < 0) {
      return res.status(400).json({ error: 'CSV needs an itemName column. Optional columns: quantity, category.' });
    }

    const valid = [];
    const invalid = [];

    // Validate each row
    rows.forEach((r, i) => {
      const name = String(r[nameIndex] || '').trim();
      const quantity = qtyIndex < 0 ? '1' : String(r[qtyIndex] || '1').trim();
      const category = categoryIndex < 0 ? 'Other' : String(r[categoryIndex] || 'Other').trim();

      // Check for empty names or excessive string lengths
      if (!name || name.length > 160 || quantity.length > 60 || category.length > 80) {
        invalid.push({ row: i + 2, reason: 'Missing or overly long item name, quantity or category.' });
      }
      // Reject dangerous ASCII control characters
      else if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(name + quantity + category)) {
        invalid.push({ row: i + 2, reason: 'Control characters are not allowed.' });
      }
      // Valid item: queue for preview
      else {
        valid.push({ name, quantity, category, source: 'import' });
      }
    });

    if (valid.length > 500) {
      return res.status(413).json({ error: 'Import is limited to 500 rows per file.' });
    }

    // Return preview results to client
    res.json({ items: valid, invalid, total: rows.length });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message || 'Could not parse CSV.' });
  }
});

module.exports = router;
