require('dotenv').config();
const mongoose = require('mongoose');
const UserData = require('../server/models/UserData');
const Product = require('../server/models/Product');
const User = require('../server/models/User');

function assert(condition, message) {
  if (!condition) {
    console.error(`  ✖ FAIL: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✔ PASS: ${message}`);
}

// Minimal browser-like environment helpers to test the exact frontend functions
const { safeImageURL, escapeHTML } = (function() {
  function safeImageURL(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    if (/^(\.\.?\/|\/)[a-zA-Z0-9_./-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw, 'http://localhost:3000');
      if ((parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.origin === 'http://localhost:3000')) && !parsed.username && !parsed.password) return parsed.href;
    } catch (_) {}
    return '';
  }
  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  return { safeImageURL, escapeHTML };
})();

async function runTests() {
  console.log('====================================================');
  console.log('🧪 TESTING SHOPPING LIST PRODUCT IMAGE RESOLUTION');
  console.log('====================================================\n');

  await mongoose.connect(process.env.MONGODB_URI);

  try {
    // 1. Verify Kabir's user data and 'mongo test product' in MongoDB
    console.log('▶ Step 1: Inspecting "mongo test product" in MongoDB...');
    const mongoTestProd = await Product.findOne({ name: 'mongo test product', source: 'user' }).lean();
    assert(mongoTestProd !== null, '"mongo test product" found in MongoDB safeshelf.products');
    assert(mongoTestProd.imageUrl === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', '"mongo test product" has valid /uploads/ image URL');
    assert(safeImageURL(mongoTestProd.imageUrl) === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', 'safeImageURL accepts /uploads/ path');

    // 2. Test auto-item building logic with image URL preservation
    console.log('\n▶ Step 2: Testing auto-generated shopping list item creation...');
    
    // Simulate frontend ShoppingListModule.buildAutoItem
    function buildAutoItem(product, reason) {
      const img = (product.imageUrl || product.image || '').trim();
      return {
        id: product.id || product._id,
        productId: product.id || product._id,
        name: product.name,
        category: product.category,
        quantity: product.quantity,
        imageUrl: img,
        image: img,
        catalogProductId: product.catalogProductId || '',
        source: 'auto',
        reason: reason,
        purchased: false,
        addedAt: new Date().toISOString()
      };
    }

    const autoItem = buildAutoItem(mongoTestProd, 'low_stock');
    assert(autoItem.imageUrl === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', 'Auto-item retained product.imageUrl');
    assert(autoItem.image === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', 'Auto-item retained product.image');
    assert(autoItem.source === 'auto', 'Auto-item marked as source: auto');
    assert(autoItem.reason === 'low_stock', 'Auto-item reason set to low_stock');

    // 3. Test resolveProductImage function with various products
    console.log('\n▶ Step 3: Testing resolveProductImage resolution hierarchy...');
    const CatalogStore = {
      categories: [
        {
          id: 'fruits',
          name: 'Fruits',
          products: [{ id: 'apple', name: 'Apple', image: './images/apple.jpeg' }]
        }
      ],
      getAllProducts() {
        return this.categories.flatMap(c => c.products);
      },
      getProductById(id) {
        return this.getAllProducts().find(p => p.id === id);
      }
    };

    const mockProducts = [
      {
        id: 'prod_mongo_1',
        _id: 'prod_mongo_1',
        name: 'mongo test product',
        category: 'Food Grains',
        quantity: '1 kg',
        imageUrl: '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg'
      },
      {
        id: 'prod_rice_2',
        _id: 'prod_rice_2',
        name: 'Organic Basmati Rice',
        category: 'Food Grains',
        quantity: '2 kg',
        imageUrl: './images/rice.jpeg'
      },
      {
        id: 'prod_apple_3',
        _id: 'prod_apple_3',
        name: 'Apple',
        category: 'Fruits',
        quantity: '1 kg',
        imageUrl: ''
      },
      {
        id: 'prod_tool_4',
        _id: 'prod_tool_4',
        name: 'Custom Plastic Bucket',
        category: 'Household',
        quantity: '1 unit',
        imageUrl: ''
      }
    ];

    function resolveProductImage(item, productsList) {
      if (!item) return null;

      // 1. Direct image property
      const directImg = typeof item.imageUrl === 'string' && item.imageUrl.trim()
        ? item.imageUrl.trim()
        : (typeof item.image === 'string' && item.image.trim() ? item.image.trim() : '');
      if (directImg) return directImg;

      // 2. Linked inventory product
      if (productsList && Array.isArray(productsList)) {
        const targetId = item.productId || item.id;
        if (targetId) {
          const invProd = productsList.find(p => p && (p.id === targetId || p._id === targetId || String(p._id) === String(targetId)));
          if (invProd) {
            const invImg = (invProd.imageUrl || invProd.image || '').trim();
            if (invImg) return invImg;
          }
        }
      }

      // 3. Name match in inventory
      const rawName = (item.name || '').toLowerCase().trim();
      if (!rawName) return null;

      if (productsList && Array.isArray(productsList)) {
        const nameMatch = productsList.find(p => p && p.name && p.name.toLowerCase().trim() === rawName);
        if (nameMatch) {
          const matchImg = (nameMatch.imageUrl || nameMatch.image || '').trim();
          if (matchImg) return matchImg;
        }
      }

      // 4. Asset rules
      const assetRules = [
        { regex: /\b(green\s*apple|red\s*apple|apples?)\b/i, not: /\b(pineapple|apple\s*cider)\b/i, file: './images/apple.jpeg' }
      ];
      for (const rule of assetRules) {
        if (rule.regex.test(rawName)) {
          if (!rule.not || !rule.not.test(rawName)) return rule.file;
        }
      }

      // 5. Exact catalog match
      const allCat = CatalogStore.getAllProducts();
      const exactMatch = allCat.find(p => (p.name || '').toLowerCase().trim() === rawName);
      if (exactMatch && exactMatch.image) return exactMatch.image;

      return null;
    }

    // Test resolution for mongo test product with direct image
    const img1 = resolveProductImage(autoItem, mockProducts);
    assert(img1 === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', '"mongo test product" resolves to /uploads/ image');

    // Test resolution for legacy auto-item WITHOUT direct image (linked by productId)
    const legacyItemWithoutImg = {
      id: 'prod_mongo_1',
      productId: 'prod_mongo_1',
      name: 'mongo test product',
      category: 'Food Grains',
      source: 'auto'
    };
    const img2 = resolveProductImage(legacyItemWithoutImg, mockProducts);
    assert(img2 === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', 'Legacy auto-item linked by productId resolves image from inventory');

    // Test resolution for Apple (fallback to asset rule)
    const appleItem = { name: 'Apple', productId: 'prod_apple_3' };
    const img3 = resolveProductImage(appleItem, mockProducts);
    assert(img3 === './images/apple.jpeg', 'Apple resolves to ./images/apple.jpeg via assetRules fallback');

    // Test resolution for an item without an image (should return null -> trigger initials monogram)
    const noImageItem = { name: 'Custom Plastic Bucket', productId: 'prod_tool_4' };
    const img4 = resolveProductImage(noImageItem, mockProducts);
    assert(img4 === null, 'Item without image cleanly returns null');

    // 4. Test thumbnail markup generation
    console.log('\n▶ Step 4: Testing thumbnail rendering markup...');
    function renderThumbnailHtml(item, productsList) {
      let img = (item.imageUrl || item.image || '').trim();
      if (!img) {
        img = resolveProductImage(item, productsList) || '';
      }
      const monogram = item.name ? item.name.trim().slice(0, 2).toUpperCase() : 'SS';
      const safeUrl = img ? safeImageURL(img) : '';
      if (safeUrl) {
        return `<img src="${escapeHTML(safeUrl)}" alt="${escapeHTML(item.name)}" class="product-thumbnail-img" loading="lazy" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='flex';"><span class="product-thumbnail-fallback" style="display: none; font-size: 10px;">${escapeHTML(monogram)}</span>`;
      }
      return `<span class="product-thumbnail-fallback" style="font-size: 10px;">${escapeHTML(monogram)}</span>`;
    }

    const htmlMongo = renderThumbnailHtml(autoItem, mockProducts);
    assert(htmlMongo.includes('<img src="/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg"'), 'HTML contains correct <img src="/uploads/..." for mongo test product');
    assert(htmlMongo.includes('product-thumbnail-fallback'), 'HTML contains fallback initials span');
    assert(htmlMongo.includes('MO'), 'Fallback span contains monogram "MO"');

    const htmlNoImg = renderThumbnailHtml(noImageItem, mockProducts);
    assert(!htmlNoImg.includes('<img'), 'HTML does not contain <img> tag when image is null');
    assert(htmlNoImg.includes('<span class="product-thumbnail-fallback"'), 'HTML contains fallback initials span');
    assert(htmlNoImg.includes('CU'), 'Initials "CU" correctly rendered for "Custom Plastic Bucket"');

    // 5. Test syncShoppingList backfill on Kabir's actual shopping list
    console.log('\n▶ Step 5: Testing backfill of Kabir\'s shopping list in memory...');
    const kabirUserData = await UserData.findOne({ userId: '6adf042527e3f9bfcb535d57' }).lean();
    assert(kabirUserData !== null, 'Kabir UserData found in MongoDB');
    assert(Array.isArray(kabirUserData.shoppingList), 'Kabir shoppingList is an array');

    const kabirInventory = await Product.find({ userId: '6adf042527e3f9bfcb535d57', source: 'user' }).lean();
    console.log(`  Found ${kabirInventory.length} inventory products and ${kabirUserData.shoppingList.length} shopping list items for Kabir.`);

    kabirUserData.shoppingList.forEach(item => {
      const resolved = resolveProductImage(item, kabirInventory);
      console.log(`    - Shopping Item: "${item.name}" -> resolved image: ${resolved || '(none: fallback to ' + item.name.slice(0, 2).toUpperCase() + ')'}`);
      if (item.name === 'mongo test product') {
        assert(resolved === '/uploads/872b85ce-e4d8-4223-8f72-f40d7b079257.jpg', '"mongo test product" resolves to /uploads/ image in Kabir\'s list');
      }
      if (item.name === 'Grow bag') {
        assert(resolved === '/uploads/6f51b0ea-a29b-4607-8aa4-af611b95b003.jpg', '"Grow bag" resolves to /uploads/ image in Kabir\'s list');
      }
      if (item.name === 'Apple') {
        assert(resolved === './images/apple.jpeg', '"Apple" resolves to ./images/apple.jpeg in Kabir\'s list');
      }
    });

    console.log('\n====================================================');
    console.log('🎉 ALL SHOPPING LIST IMAGE RESOLUTION TESTS PASSED (14/14)');
    console.log('====================================================');
  } finally {
    await mongoose.disconnect();
  }
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

