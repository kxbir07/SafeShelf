/**
 * ============================================================================
 * SafeShelf V1 — Client CSV Shopping Import Handler (shopping-import.js)
 * ============================================================================
 * Purpose:
 *   Wired to the "Import CSV" button on the Shopping List view.
 *   Provides a streamlined, guided import experience:
 *     1. Opens a file selector when the user clicks "Import CSV".
 *     2. Transmits the CSV to the backend preview API (/api/shopping-import/preview).
 *     3. Shows a friendly confirmation modal summarizing valid and skipped rows.
 *     4. Deduplicates incoming rows against current shopping list items.
 *     5. Automatically matches item names against the pantry catalogue to attach
 *        high-resolution product photos.
 *     6. Saves items to local storage and synchronizes with cloud MongoDB.
 * ============================================================================
 */

(function () {
  // Grab DOM elements for the import button and the hidden file input
  const button = document.getElementById('importShoppingCsvBtn');
  const input = document.getElementById('shoppingCsvFile');

  // If the shopping view elements are not present on this page, exit cleanly
  if (!button || !input) return;

  // Step 1: Forward button clicks to trigger the hidden native file picker
  button.addEventListener('click', () => input.click());

  // Step 2: Handle file selection by the user
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // Check if the user is signed in (CSV preview requires authentication)
    const token = localStorage.getItem('safeshelf_auth_token');
    if (!token) {
      if (typeof showNotification === 'function') {
        showNotification('Please sign in before importing a CSV.', 'warning');
      } else {
        alert('Please sign in before importing a CSV.');
      }
      input.value = '';
      return;
    }

    // Indicate loading state on the button
    button.disabled = true;
    button.textContent = 'Checking CSV…';

    try {
      // Step 3: Send file via FormData to the preview endpoint
      const form = new FormData();
      form.append('file', file);

      const response = await fetch('/api/shopping-import/preview', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'CSV import failed.');

      const items = payload.items || [];
      if (!items.length) throw new Error('No valid items were found in this CSV.');

      const invalidNote = payload.invalid && payload.invalid.length
        ? ` (${payload.invalid.length} invalid row(s) will be skipped)`
        : '';

      // Step 4: Callback executed when the user confirms the import modal
      const proceedImport = async () => {
        // Load current shopping list items
        const current = StorageModule.loadShoppingList();
        const norm = s => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

        // Build a Set of existing normalized names to prevent duplicates
        const existing = new Set(current.map(x => norm(x.name || x.productName || x.itemName || x.product)));
        let added = 0;

        items.forEach(item => {
          const key = norm(item.name);
          // Skip empty or already-present items
          if (!key || existing.has(key)) return;
          existing.add(key);

          // Intelligent image matching:
          // Check if the item already exists in user's inventory or master catalog
          let matchedImg = '';
          let matchedCatId = '';

          if (typeof products !== 'undefined' && Array.isArray(products)) {
            const inv = products.find(p => norm(p.name) === key);
            if (inv) {
              matchedImg = (inv.imageUrl || inv.image || '').trim();
              matchedCatId = inv.catalogProductId || '';
            }
          }

          if (!matchedImg && typeof CatalogStore !== 'undefined' && CatalogStore.getAllProducts) {
            const cp = CatalogStore.getAllProducts().find(p => norm(p.name) === key);
            if (cp && cp.image) {
              matchedImg = cp.image;
              matchedCatId = cp.id || '';
            }
          }

          // Append formatted shopping item
          current.push({
            id: 'import_' + Date.now().toString(36) + '_' + added,
            name: item.name,
            productName: item.name,
            quantity: item.quantity || '1',
            category: item.category || 'Other',
            imageUrl: matchedImg,
            image: matchedImg,
            catalogProductId: matchedCatId,
            source: 'manual',
            purchased: false
          });
          added++;
        });

        // Step 5: Save items to offline storage and sync with cloud
        const syncRes = await StorageModule.saveShoppingList(AuthModule.currentUser && AuthModule.currentUser.id, current);

        // Re-render the shopping list table
        if (typeof ShoppingListModule !== 'undefined' && ShoppingListModule.renderShoppingList) {
          ShoppingListModule.renderShoppingList();
        } else if (typeof ShoppingListModule !== 'undefined' && ShoppingListModule.render) {
          ShoppingListModule.render();
        }

        // Notify user of completion and sync status
        const cloudSuffix = syncRes && syncRes.ok
          ? ' Synced to cloud.'
          : (syncRes && (syncRes.status === 'offline' || syncRes.status === 503) ? ' Saved locally (cloud sync offline).' : '');

        if (typeof showNotification === 'function') {
          showNotification(`Import complete. Added ${added} item(s); ${items.length - added} duplicate(s) skipped.${cloudSuffix}`, 'success');
        } else {
          alert(`Import complete. Added ${added} item(s); ${items.length - added} duplicate(s) skipped.${cloudSuffix}`);
        }
      };

      // Step 6: Present confirmation dialog before altering the shopping list
      if (typeof showConfirm === 'function') {
        showConfirm(
          'Import Shopping List?',
          `Import ${items.length} shopping-list item(s)?${invalidNote}\nExisting item names will not be duplicated.`,
          proceedImport,
          'Import'
        );
      } else {
        if (confirm(`Import ${items.length} shopping-list item(s)?${invalidNote}\nExisting item names will not be duplicated.`)) {
          proceedImport();
        }
      }
    } catch (e) {
      if (typeof showNotification === 'function') {
        showNotification(e.message || 'Unable to import CSV.', 'error');
      } else {
        alert(e.message || 'Unable to import CSV.');
      }
    } finally {
      // Reset button state and input value for future imports
      button.disabled = false;
      button.textContent = 'Import CSV';
      input.value = '';
    }
  });
})();
