/**
 * ============================================================================
 * SafeShelf V1 — Client Configuration & Security Helpers (config.js)
 * ============================================================================
 * Purpose:
 *   Central configuration and frontend security sanitizers for SafeShelf.
 *
 * Contents:
 *   1. EMAIL_CONFIG: Client-side credentials for EmailJS to send low-stock alerts.
 *   2. escapeHTML(): Prevents Cross-Site Scripting (XSS) in HTML templates.
 *   3. safeImageURL(): Validates image links to ensure safe rendering.
 *
 * Setup Guide for EmailJS:
 *   1. Register a free account at https://www.emailjs.com/
 *   2. Add an Email Service (e.g. Gmail) to obtain your SERVICE_ID.
 *   3. Create an Email Template to obtain your TEMPLATE_ID.
 *   4. Copy your Public Key from Account Settings.
 *   5. Replace the placeholder values below with your real credentials.
 * ============================================================================
 */

const EMAIL_CONFIG = {
    SERVICE_ID: "YOUR_SERVICE_ID",
    TEMPLATE_ID: "YOUR_TEMPLATE_ID",
    PUBLIC_KEY: "YOUR_PUBLIC_KEY"
};

/**
 * Escapes untrusted user input before inserting it into HTML templates.
 *
 * Beginner explanation:
 * If a user creates a product named `<img src=x onerror=alert('hack')>`, inserting
 * that directly into `innerHTML` would run unauthorized JavaScript in the user's browser
 * (an XSS attack). This function converts dangerous characters like `<` and `>` into
 * harmless HTML entity codes like `&lt;` and `&gt;`.
 *
 * @param {string|any} value - The raw text to escape.
 * @returns {string} Sanitized text safe for innerHTML interpolation.
 */
function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

/**
 * Validates and sanitizes image URLs before assigning them to `<img src="...">`.
 *
 * Beginner explanation:
 * Attackers can sometimes provide malicious links such as `javascript:alert(1)`.
 * This function guarantees that only genuine local image paths (e.g. `./images/apple.jpeg`
 * or `/uploads/photo.png`) or secure `https://` URLs are permitted.
 *
 * @param {string} value - The raw image source string.
 * @returns {string} A validated, safe URL string, or an empty string if rejected.
 */
function safeImageURL(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';

    // Allow local relative paths to images and uploads
    if (/^(\.\.?\/|\/)[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(raw)) return raw;

    // Allow secure external HTTPS links with no embedded passwords
    try {
        const parsed = new URL(raw, window.location.origin);
        if ((parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.origin === window.location.origin)) && !parsed.username && !parsed.password) {
            return parsed.href;
        }
    } catch (_) {}

    return '';
}
