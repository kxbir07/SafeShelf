 # SafeShelf V1 — Beginner's Project Code & Architecture Guide

Welcome to the **SafeShelf V1 Project Code Guide**! This document is designed for beginner developers and students preparing for a project viva, exam, or technical presentation. It explains in simple English how SafeShelf is built, how each file and folder works, and how data moves between the user's browser, the Express server, and the MongoDB database.

---

## 1. What is SafeShelf?

**SafeShelf** is an editorial household inventory, expiration tracking, and shopping management web application. 

### Key Features:
- **Pantry Ledger:** Keep track of food, groceries, and household goods.
- **Expiration Tracker:** Categorizes items into *Urgent* (≤ 3 days), *Upcoming* (4–7 days), and *Safe* (> 7 days) to minimize household food waste.
- **Appliance Warranty Ledger:** Counts down warranty expirations for electronics and appliances.
- **Automated Shopping List:** Auto-detects items that are low in stock (quantity ≤ 1) and adds them to your grocery list.
- **Offline-First Resilience:** SafeShelf works completely offline in the browser using `localStorage` and a bundled 112-product dataset. When connected, it synchronizes seamlessly with a Node.js/MongoDB cloud backend.

---

## 2. Overall System Architecture

SafeShelf is organized into a clean **Client-Server Architecture**:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                      1. FRONTEND (User's Browser)                      │
│                                                                        │
│  HTML & CSS:                                                           │
│    - index.html (Single-Page App interface with 10 view sections)      │
│    - css/styles.css (Design tokens, editorial typography, layouts)     │
│                                                                        │
│  JavaScript Modules:                                                   │
│    - js/auth.js (Login, registration, offline-storage, OCC sync)       │
│    - js/inventory.js (Pantry CRUD, table/grid rendering, drawers)      │
│    - js/features.js (Shopping list, low-stock alerts, EmailJS)         │
│    - js/dashboard.js (Router, KPI metrics, triage board, backup)       │
│    - js/dataset-catalog.js (112 offline items + API enrichment)        │
│    - js/config.js (XSS sanitization & EmailJS config)                  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP REST Requests
                                    │ (JSON & JWT Bearer Token)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   2. BACKEND API (Node.js & Express.js)                │
│                                                                        │
│  Entry Point & Security:                                               │
│    - server.js (Express server, Helmet CSP, DDoS Rate Limiters)        │
│    - server/middleware/auth.js (JWT authentication gatekeeper)         │
│                                                                        │
│  REST Route Handlers:                                                  │
│    - server/routes/auth.js (POST /register, POST /login, PUT /profile) │
│    - server/routes/products.js (Catalog search, categories, CRUD)      │
│    - server/routes/userData.js (Cloud sync with OCC version control)   │
│    - server/routes/uploads.js (Image upload with magic-byte checks)    │
│    - server/routes/shoppingImport.js (RFC 4180 streaming CSV parser)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Mongoose ORM
                                    │ (mongodb:// connection)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     3. DATABASE (MongoDB Database)                     │
│                                                                        │
│  Collections & Schemas:                                                │
│    - User (Accounts with salted bcrypt password hashes)                │
│    - Product (Catalog items and user-created pantry provisions)        │
│    - UserData (Multi-tenant cloud inventory, shopping list & version)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Major Folders & Their Purpose

| Folder | What It Contains | Why It Exists |
| :--- | :--- | :--- |
| **`server/`** | Backend server code | Houses all route handlers, authentication middleware, and Mongoose database models. |
| **`server/models/`** | Database schemas | Defines what data records look like in MongoDB (`User`, `Product`, `UserData`). |
| **`server/routes/`** | API endpoints | Handles HTTP requests (`GET`, `POST`, `PUT`, `DELETE`) and returns JSON responses. |
| **`server/middleware/`**| Gatekeeper code | Code that runs *before* reaching a route (e.g. verifying JWT authentication tokens). |
| **`js/`** | Frontend JavaScript | Client-side application modules (vanilla JavaScript, zero frontend frameworks). |
| **`css/`** | Stylesheets | `styles.css` containing design tokens (colors, spacing, typography) and responsive styling. |
| **`data/`** | JSON datasets | Bundled 112-product catalog dataset and category mappings for offline operation. |
| **`images/`** | UI photos | 32 thumbnail photos used by hero still-life cards and sample pantry items. |
| **`dataset_assets/`** | Product photos | 112 high-resolution photos matched with the master product catalog. |
| **`scripts/`** | Automation & Tests | Automated test suites (`npm test`), database seed scripts, and interactive demo runners. |
| **`uploads/`** | User upload storage | Stores custom photos uploaded by users via camera/device (contains `.gitkeep`). |

---

## 4. Important Files & Their Responsibilities

### Backend Files
1. **`server.js`**: The heart of the backend. It starts Express, loads `.env`, configures Helmet security headers, sets up rate limiting to prevent spam attacks, registers all API routes, serves static frontend files, and connects to MongoDB with graceful offline fallback.
2. **`server/middleware/auth.js`**: Verifies incoming `Authorization: Bearer <token>` headers. Decodes the token using the secret key and ensures the user ID is a valid MongoDB ID before letting the request proceed.
3. **`server/models/User.js`**: Stores user accounts. Passwords are saved as secure bcrypt hashes (never plain text).
4. **`server/models/UserData.js`**: Stores the user's cloud-synced inventory and shopping list. Includes a `version` number used for **Optimistic Concurrency Control (OCC)**.
5. **`server/models/Product.js`**: Stores pantry items. Contains a `pre('validate')` hook that automatically normalizes product names (e.g. "Honey!" becomes "honey") for fast fuzzy searches.
6. **`server/routes/auth.js`**: Handles `/register`, `/login`, and `/profile` updates.
7. **`server/routes/products.js`**: Handles inventory CRUD operations (`/api/products`), category counts (`/categories`), and catalog searching.
8. **`server/routes/userData.js`**: Synchronizes local data with MongoDB and detects multi-device editing conflicts.
9. **`server/routes/uploads.js`**: Handles custom product photo uploads. Uses **magic-byte inspection** to inspect file binary headers, ensuring attackers cannot upload malicious scripts disguised as images.
10. **`server/routes/shoppingImport.js`**: Reads uploaded `.csv` shopping list files, validates rows, and previews items before importing.

### Frontend Files
1. **`index.html`**: The entire application lives inside this single HTML file. Contains the markup for all 10 views (Dashboard, Inventory, Shopping, Categories, etc.), modal dialogs, and slide drawers.
2. **`js/config.js`**: Stores configuration (such as EmailJS) and provides `escapeHTML()` to defend against Cross-Site Scripting (XSS).
3. **`js/auth.js`**:
   - `AuthModule`: Handles login, registration, JWT storage in `localStorage`, and logout cleanup.
   - `StorageModule`: Local-first persistence engine. Saves to `localStorage`, coordinates with cloud APIs, and manages the cloud sync badge (`☁️ Synced`).
   - `SessionModule`: Stores temporary tab-only statistics in `sessionStorage`.
4. **`js/inventory.js`**:
   - `CatalogStore`: Built-in pantry taxonomy (10 departments) with icons and shelf-life estimates.
   - `InventoryModule`: Controls the Inventory Table and Retail Grid views, search filter, and the slide-out Add Drawer.
   - `resolveProductImage()`: 5-step image resolution engine (direct image -> linked item -> catalog -> name match -> fallback initials monogram).
5. **`js/features.js`**:
   - `ShoppingListModule`: Manages grocery items, automatically generates entries for items with low stock (quantity ≤ 1), and supports printing.
   - `EmailModule`: Uses EmailJS to email low-stock alerts directly to the user.
6. **`js/dashboard.js`**:
   - `DashboardModule`: Computes total counts, days remaining, expiration status badges, and warranty countdowns.
   - `NavigationModule`: Client-side single-page router that switches views instantly when sidebar buttons are clicked.
   - `BackupModule`: Exports and restores full `.json` data backups.

---

## 5. How Frontend Communicates with Backend

SafeShelf's frontend communicates with the backend using modern **HTTP REST API** calls via the native `fetch()` browser API:

1. **Authentication Token (JWT):**
   When you log in, the server generates a JSON Web Token (JWT) signed with a secret key. The browser saves this token in `localStorage.setItem('safeshelf_auth_token', token)`.
2. **Sending Requests:**
   Whenever the frontend needs to view or save data, it sends an HTTP header:
   ```text
   Authorization: Bearer <jwt_token_here>
   Content-Type: application/json
   ```
3. **File Uploads:**
   When uploading a photo or a CSV file, the frontend uses `FormData` objects:
   ```javascript
   const form = new FormData();
   form.append('image', file);
   fetch('/api/uploads/image', { method: 'POST', body: form });
   ```
4. **Offline Resilience:**
   If the user has no internet connection or if the backend is down, `fetch()` will fail. SafeShelf's frontend catches the error and switches to **local-first mode**: you can still view, add, and edit provisions locally without seeing a blank screen!

---

## 6. How Backend Communicates with MongoDB

The backend uses **Mongoose**, which is an Object Data Modeling (ODM) library for MongoDB and Node.js.

1. **Connection Lifecycle:**
   In `server.js`, Mongoose connects using:
   ```javascript
   await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
   ```
   SafeShelf listens to connection events (`disconnected` and `connected`) dynamically. If your MongoDB server shuts down while the app is running, SafeShelf gracefully marks `app.locals.mongoReady = false` and serves data from local JSON fallback files instead of crashing!
2. **Multi-Tenant Account Isolation:**
   Every user's items in MongoDB are tagged with their specific user ID (`userId: req.user.sub`). When retrieving or modifying items, queries always include `{ userId: req.user.sub }`. This guarantees User A can never view or delete User B's inventory.
3. **Optimistic Concurrency Control (OCC):**
   In `server/routes/userData.js`, every document has an integer `version`. When you save, the server checks if your version matches what is in the database:
   - If they match: Version increments (e.g. 1 -> 2) and saves successfully.
   - If they don't match: Another tab or phone saved first! The server returns **HTTP 409 Conflict** along with the latest server data so you can choose to merge or keep local edits.

---

## 7. Complete Login-to-Dashboard Data Flow

Here is the exact step-by-step journey of what happens behind the scenes from the moment you log in to viewing your dashboard:

```text
1. User enters email & password on Login Form
      │
      ▼
2. Frontend `AuthModule.login()` sends POST /api/auth/login
      │
      ▼
3. Express matches route in `server/routes/auth.js`
      │
      ├─► Finds user in MongoDB by email (`User.findOne({ email })`)
      ├─► Compares password hash using `bcrypt.compare()`
      └─► Signs JWT token with secret key: { sub: user._id, email: user.email }
      │
      ▼
4. Backend returns HTTP 200 with `{ token, user }`
      │
      ▼
5. Frontend stores token in `localStorage`
      │
      ▼
6. Frontend triggers `StorageModule.syncFromServer()`
      │
      ├─► Calls GET /api/products/inventory to retrieve user's saved items from MongoDB
      ├─► Calls GET /api/user-data to retrieve shopping list and version
      └─► Saves items into browser's `localStorage` for instant offline cache
      │
      ▼
7. Frontend hides Auth container and shows App container
      │
      ▼
8. `DashboardModule.updateDashboardMetrics(products)` runs:
      │
      ├─► Tally Total Provisions, Expiring Soon, Low Stock, and Expired items
      ├─► Updates summary metric cards on the screen
      ├─► Computes Category distribution and Freshness Health bar
      └─► Checks low stock: `ShoppingListModule.syncShoppingList()` auto-adds groceries
      │
      ▼
9. `InventoryModule.renderProductTable(products)` renders the provision rows
      │
      ▼
10. User sees their complete, personalized pantry dashboard! 🎉
```

---

## 8. Common Viva & Interview Questions

### Q1: What makes SafeShelf an "offline-first" application?
> **Answer:** SafeShelf stores all inventory and shopping list records in the browser's `localStorage` and includes a bundled 112-product catalog. The user can view and edit items without an internet connection. When connection is available, it synchronizes with MongoDB in the background.

### Q2: How do you prevent passwords from being stolen if the database is leaked?
> **Answer:** We never store plain text passwords. We hash passwords using `bcryptjs` with 12 salt rounds before saving them to MongoDB. Bcrypt is a one-way mathematical function with a high work factor, making brute-force cracking computationally unfeasible.

### Q3: What is Optimistic Concurrency Control (OCC) and why does SafeShelf use it?
> **Answer:** If a user opens SafeShelf on two devices simultaneously (e.g., phone and laptop), OCC uses an integer `version` number on the user's data document. If the phone saves version 1, the cloud version becomes 2. When the laptop tries to save version 1, the server detects the conflict (HTTP 409) rather than silently overwriting the phone's new items.

### Q4: What is XSS and how does SafeShelf prevent it?
> **Answer:** Cross-Site Scripting (XSS) occurs when an attacker inputs malicious `<script>` or HTML tags that run inside another user's browser. SafeShelf implements `escapeHTML()` in `js/config.js` to convert characters like `<`, `>`, and `&` into harmless HTML entity codes (`&lt;`, `&gt;`), and implements strict Content Security Policy (CSP) headers in `server.js`.

### Q5: Why do you check "magic bytes" during image uploads instead of just file extensions?
> **Answer:** Renaming a malicious executable script to `.png` is trivial. In `server/routes/uploads.js`, `detectImage()` reads the raw first binary bytes of the file (e.g., `89 50 4E 47` for PNG or `FF D8 FF` for JPEG) to verify that the file's binary content is genuinely an image before saving it to disk.
