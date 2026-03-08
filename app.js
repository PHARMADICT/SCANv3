/**
 * PharmaScan Pro v5.0
 * GS1 Barcode Scanner for Pharmacy Inventory
 * OASIS PHARMACY / Alshaya-Boots
 * 
 * Features:
 * - Triple lookup: GTIN (14-digit) / BARCODE (EAN-13/12) / RMS Code
 * - GS1 AI parsing (01, 17, 10, 21)
 * - Instant scan result widget
 * - Master data management
 * - Export CSV/TSV
 */

'use strict';

const CONFIG = {
  DB_NAME: 'PharmaScanProV5',
  DB_VERSION: 5,
  EXPIRY_DAYS: 90,
  VERSION: '5.0.0',
  STORE_NO: '31374',
  STORE_NAME: 'T3 ARRIVAL'
};

// App State
const App = {
  db: null,
  master: new Map(),       // barcode/gtin -> product
  masterRMS: new Map(),    // RMS -> product
  masterGTIN: new Map(),   // GTIN -> product
  settings: { storeName: CONFIG.STORE_NAME, storeNo: CONFIG.STORE_NO },
  scanner: { active: false, instance: null },
  scans: [],
  editingId: null,
  search: ''
};

// ============================================
// GS1 PARSER
// ============================================
const GS1 = {
  parse(code) {
    const r = { raw: code || '', gtin: '', gtin13: '', barcode: '', expiry: '', expiryISO: '', expiryDisplay: '', batch: '', serial: '', qty: 1, isGS1: false };
    if (!code) return r;
    
    code = code.trim().replace(/[\r\n\t]/g, '');
    
    // Remove prefixes
    [']C1', ']e0', ']E0', ']d2', ']Q3'].forEach(p => { if (code.startsWith(p)) code = code.slice(p.length); });
    
    // Normalize FNC1
    code = code.replace(/[\x1d\x1e\x1c~]/g, '\x1d').replace(/\[FNC1\]|<GS>|\{GS\}/gi, '\x1d');
    
    // Check if GS1
    if (code.includes('\x1d') || /\(\d{2,4}\)/.test(code) || (/^(01|02|10|17|21)\d/.test(code) && code.length > 16)) {
      r.isGS1 = true;
      this.parseGS1(code, r);
    } else {
      // Simple barcode
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) {
        r.barcode = digits;
        r.gtin13 = digits.slice(-13).padStart(13, '0');
      }
    }
    
    return r;
  },

  parseGS1(code, r) {
    // Parentheses format
    if (code.includes('(')) {
      let m = code.match(/\(01\)(\d{14})/); if (m) { r.gtin = m[1]; r.gtin13 = m[1].slice(-13); }
      m = code.match(/\(17\)(\d{6})/) || code.match(/\(15\)(\d{6})/); if (m) this.parseDate(m[1], r);
      m = code.match(/\(10\)([^\(]+)/); if (m) r.batch = m[1].trim().slice(0, 20);
      m = code.match(/\(21\)([^\(]+)/); if (m) r.serial = m[1].trim().slice(0, 20);
      return;
    }
    
    // Raw AI format
    let pos = 0, len = code.length;
    while (pos < len) {
      if (code[pos] === '\x1d') { pos++; continue; }
      const ai = code.slice(pos, pos + 2);
      
      if (ai === '01' || ai === '02') {
        r.gtin = code.slice(pos + 2, pos + 16);
        r.gtin13 = r.gtin.slice(-13);
        pos += 16;
      } else if (ai === '17' || ai === '15') {
        this.parseDate(code.slice(pos + 2, pos + 8), r);
        pos += 8;
      } else if (ai === '10') {
        pos += 2;
        let batch = '';
        while (pos < len && code[pos] !== '\x1d') batch += code[pos++];
        r.batch = batch.slice(0, 20);
      } else if (ai === '21') {
        pos += 2;
        while (pos < len && code[pos] !== '\x1d') pos++;
      } else if (ai === '11' || ai === '12' || ai === '13') {
        pos += 8;
      } else {
        pos++;
      }
    }
  },

  parseDate(yymmdd, r) {
    if (!yymmdd || yymmdd.length !== 6) return;
    const yy = parseInt(yymmdd.slice(0, 2)), mm = parseInt(yymmdd.slice(2, 4));
    let dd = parseInt(yymmdd.slice(4, 6));
    if (isNaN(yy) || isNaN(mm) || isNaN(dd) || mm < 1 || mm > 12) return;
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    if (dd === 0) dd = new Date(year, mm, 0).getDate();
    r.expiry = yymmdd;
    r.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    r.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  },

  getStatus(iso) {
    if (!iso) return 'unknown';
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    const days = Math.floor((exp - today) / 86400000);
    return days < 0 ? 'expired' : days <= CONFIG.EXPIRY_DAYS ? 'expiring' : 'ok';
  },

  getDays(iso) {
    if (!iso) return Infinity;
    const today = new Date(); today.setHours(0,0,0,0);
    const exp = new Date(iso); exp.setHours(0,0,0,0);
    return Math.floor((exp - today) / 86400000);
  },

  formatDisplay(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
};

// ============================================
// MATCHER - Fast product lookup
// ============================================
const Matcher = {
  build(data) {
    App.master.clear();
    App.masterRMS.clear();
    App.masterGTIN.clear();
    
    for (const item of data) {
      const product = {
        gtin: String(item.gtin || '').trim(),
        barcode: String(item.barcode || '').replace(/\D/g, ''),
        rms: String(item.rms || item.rmsCode || '').trim(),
        alshayaCode: String(item.alshayaCode || '').trim(),
        name: String(item.name || item.description || '').trim(),
        brand: String(item.brand || '').trim(),
        supplier: String(item.supplier || '').trim(),
        conceptGroup: String(item.conceptGroup || '').trim(),
        returnPolicy: String(item.returnPolicy || '').trim(),
        keyBrands: String(item.keyBrands || '').trim()
      };
      
      // Index by GTIN (14-digit)
      if (product.gtin && product.gtin.length >= 8) {
        App.masterGTIN.set(product.gtin, product);
        App.masterGTIN.set(product.gtin.padStart(14, '0'), product);
        // Also index by last 13 digits
        App.masterGTIN.set(product.gtin.slice(-13), product);
      }
      
      // Index by Barcode (EAN-13/12/8)
      if (product.barcode && product.barcode.length >= 8) {
        App.master.set(product.barcode, product);
        App.master.set(product.barcode.padStart(14, '0'), product);
        App.master.set(product.barcode.slice(-13), product);
        App.master.set(product.barcode.slice(-12), product);
        App.master.set(product.barcode.slice(-8), product);
      }
      
      // Index by RMS
      if (product.rms) {
        App.masterRMS.set(product.rms, product);
        App.masterRMS.set(product.rms.replace(/\D/g, ''), product);
      }
    }
    
    console.log(`✅ Indexed: ${App.masterGTIN.size} GTIN, ${App.master.size} Barcode, ${App.masterRMS.size} RMS`);
  },

  find(code) {
    if (!code) return null;
    const clean = String(code).trim();
    const digits = clean.replace(/\D/g, '');
    
    // Try GTIN first (14 digits)
    if (digits.length === 14) {
      if (App.masterGTIN.has(digits)) return { ...App.masterGTIN.get(digits), matchType: 'GTIN' };
    }
    
    // Try GTIN lookup by shorter codes
    if (App.masterGTIN.has(clean)) return { ...App.masterGTIN.get(clean), matchType: 'GTIN' };
    if (App.masterGTIN.has(digits)) return { ...App.masterGTIN.get(digits), matchType: 'GTIN' };
    if (App.masterGTIN.has(digits.slice(-13))) return { ...App.masterGTIN.get(digits.slice(-13)), matchType: 'GTIN' };
    
    // Try Barcode
    if (App.master.has(digits)) return { ...App.master.get(digits), matchType: 'BARCODE' };
    if (App.master.has(digits.padStart(14, '0'))) return { ...App.master.get(digits.padStart(14, '0')), matchType: 'BARCODE' };
    if (App.master.has(digits.slice(-13))) return { ...App.master.get(digits.slice(-13)), matchType: 'BARCODE' };
    if (App.master.has(digits.slice(-12))) return { ...App.master.get(digits.slice(-12)), matchType: 'BARCODE' };
    if (App.master.has(digits.slice(-8))) return { ...App.master.get(digits.slice(-8)), matchType: 'BARCODE' };
    
    // Try RMS
    if (App.masterRMS.has(clean)) return { ...App.masterRMS.get(clean), matchType: 'RMS' };
    if (App.masterRMS.has(digits)) return { ...App.masterRMS.get(digits), matchType: 'RMS' };
    
    return null;
  },

  addProduct(item) {
    const product = {
      gtin: String(item.gtin || '').trim(),
      barcode: String(item.barcode || '').replace(/\D/g, ''),
      rms: String(item.rms || '').trim(),
      alshayaCode: String(item.alshayaCode || '').trim(),
      name: String(item.name || '').trim(),
      brand: String(item.brand || '').trim(),
      supplier: String(item.supplier || '').trim(),
      returnPolicy: String(item.returnPolicy || '').trim()
    };
    
    if (product.gtin) {
      App.masterGTIN.set(product.gtin, product);
      App.masterGTIN.set(product.gtin.slice(-13), product);
    }
    if (product.barcode) {
      App.master.set(product.barcode, product);
      App.master.set(product.barcode.slice(-13), product);
    }
    if (product.rms) {
      App.masterRMS.set(product.rms, product);
    }
  }
};

// ============================================
// DATABASE
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { App.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('scans')) {
          db.createObjectStore('scans', { keyPath: 'id', autoIncrement: true }).createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('master')) {
          db.createObjectStore('master', { keyPath: 'barcode' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  },

  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      if (r?.onsuccess !== undefined) { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }
      else { t.oncomplete = () => resolve(r); t.onerror = () => reject(t.error); }
    });
  },

  addScan: (item) => { item.timestamp = Date.now(); return DB.tx('scans', 'readwrite', s => s.add(item)); },
  updateScan: (item) => DB.tx('scans', 'readwrite', s => s.put(item)),
  getScan: (id) => DB.tx('scans', 'readonly', s => s.get(id)),
  getAllScans: () => DB.tx('scans', 'readonly', s => s.getAll()),
  deleteScan: (id) => DB.tx('scans', 'readwrite', s => s.delete(id)),
  clearScans: () => DB.tx('scans', 'readwrite', s => s.clear()),
  
  addMaster: (item) => DB.tx('master', 'readwrite', s => s.put(item)),
  getAllMaster: () => DB.tx('master', 'readonly', s => s.getAll()),
  clearMaster: () => DB.tx('master', 'readwrite', s => s.clear()),
  
  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const t = App.db.transaction('master', 'readwrite');
      const s = t.objectStore('master');
      let c = 0;
      for (const item of items) {
        const key = item.barcode || item.gtin || item.rms;
        if (key) { s.put({ ...item, barcode: key }); c++; }
      }
      t.oncomplete = () => resolve(c);
      t.onerror = () => reject(t.error);
    });
  },

  getSetting: async (key, def) => { try { const r = await DB.tx('settings', 'readonly', s => s.get(key)); return r?.value ?? def; } catch { return def; } },
  setSetting: (key, value) => DB.tx('settings', 'readwrite', s => s.put({ key, value }))
};

// ============================================
// SCANNER
// ============================================
const Scanner = {
  async toggle() { App.scanner.active ? await this.stop() : await this.start(); },

  async start() {
    try {
      if (!App.scanner.instance) App.scanner.instance = new Html5Qrcode('reader');
      await App.scanner.instance.start(
        { facingMode: 'environment' },
        { fps: 15, qrbox: { width: 250, height: 150 } },
        code => this.onScan(code),
        () => {}
      );
      App.scanner.active = true;
      document.getElementById('scannerPlaceholder').classList.add('hidden');
      document.getElementById('viewfinder').classList.add('active');
      document.getElementById('btnScannerText').textContent = 'Stop';
      document.getElementById('btnScanner').classList.add('stop');
      haptic('medium');
    } catch (e) {
      toast('Camera error: ' + e.message, 'error');
    }
  },

  async stop() {
    try { if (App.scanner.instance && App.scanner.active) await App.scanner.instance.stop(); } catch {}
    App.scanner.active = false;
    document.getElementById('scannerPlaceholder')?.classList.remove('hidden');
    document.getElementById('viewfinder')?.classList.remove('active');
    document.getElementById('btnScannerText').textContent = 'Start Scanner';
    document.getElementById('btnScanner')?.classList.remove('stop');
  },

  async onScan(code) {
    await this.stop();
    haptic('success');
    processBarcode(code);
  }
};

// ============================================
// BARCODE PROCESSING
// ============================================
function processBarcode(code) {
  if (!code) return;
  code = code.trim();
  if (!code) return;
  
  console.log('📷 Scanned:', code);
  
  // Parse GS1
  const parsed = GS1.parse(code);
  console.log('📊 Parsed:', parsed);
  
  // Find product
  let product = null;
  if (parsed.gtin) {
    product = Matcher.find(parsed.gtin);
  }
  if (!product && parsed.gtin13) {
    product = Matcher.find(parsed.gtin13);
  }
  if (!product && parsed.barcode) {
    product = Matcher.find(parsed.barcode);
  }
  if (!product) {
    product = Matcher.find(code);
  }
  
  // Show result widget
  showScanResult(parsed, product);
  
  document.getElementById('manualInput').value = '';
}

// ============================================
// SCAN RESULT WIDGET
// ============================================
function showScanResult(parsed, product) {
  const widget = document.getElementById('scanResultWidget');
  const found = product && product.name;
  const status = parsed.expiryISO ? GS1.getStatus(parsed.expiryISO) : 'unknown';
  const days = parsed.expiryISO ? GS1.getDays(parsed.expiryISO) : null;
  
  // Check non-returnable
  const isNonReturnable = product?.returnPolicy?.toUpperCase().includes('NO RETURN') || 
                          product?.returnPolicy?.toUpperCase().includes('NON-RETURN');
  
  let statusBadge = '';
  if (status === 'expired') statusBadge = '<span class="badge badge-expired">⚠️ EXPIRED</span>';
  else if (status === 'expiring') statusBadge = `<span class="badge badge-expiring">⏰ ${days} DAYS</span>`;
  else if (status === 'ok' && days !== null) statusBadge = `<span class="badge badge-ok">✓ ${days} DAYS</span>`;
  
  const barcodeDisplay = parsed.gtin || parsed.gtin13 || parsed.barcode || parsed.raw?.slice(0,14) || '-';
  
  widget.innerHTML = `
    <div class="srw-header ${found ? 'found' : 'notfound'}">
      <span class="srw-icon">${found ? '✅' : '⚠️'}</span>
      <span class="srw-title">${found ? 'PRODUCT FOUND' : 'NEW PRODUCT'}</span>
      <button class="srw-close" onclick="hideScanResult()">✕</button>
    </div>
    <div class="srw-body">
      ${isNonReturnable ? `
      <div style="background:#fee2e2;border:2px solid #DC2626;border-radius:10px;padding:12px;margin-bottom:12px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:1.5rem;">🚫</span>
        <div>
          <div style="font-weight:700;color:#DC2626;">NON-RETURNABLE</div>
          <div style="font-size:0.75rem;color:#991B1B;">This item cannot be returned</div>
        </div>
      </div>
      ` : ''}
      
      <div class="srw-product">
        ${!found ? `
        <div class="form-group">
          <label class="form-label">DESCRIPTION *</label>
          <input type="text" class="form-input" id="srwName" placeholder="Enter product name">
        </div>
        ` : `
        <div class="srw-name">${escapeHtml(product?.name || 'Unknown')}</div>
        `}
        
        <div class="srw-chips">
          ${found ? `
          <span class="srw-chip brand">🏷️ ${escapeHtml(product?.brand || '-')}</span>
          <span class="srw-chip supplier">🏢 ${escapeHtml(product?.supplier || '-')}</span>
          ${isNonReturnable ? '<span class="srw-chip noreturn">🚫 Non-Returnable</span>' : ''}
          ` : `
          <input type="text" class="form-input" id="srwBrand" placeholder="Brand" style="flex:1;height:36px;font-size:13px;">
          <input type="text" class="form-input" id="srwSupplier" placeholder="Supplier" style="flex:1;height:36px;font-size:13px;">
          `}
        </div>
        
        ${statusBadge ? `<div style="margin-top:8px;">${statusBadge}</div>` : ''}
      </div>
      
      <div class="srw-codes">
        <div class="srw-code">
          <div class="srw-code-label">GTIN</div>
          <div class="srw-code-val">${product?.gtin || parsed.gtin || '-'}</div>
        </div>
        <div class="srw-code">
          <div class="srw-code-label">BARCODE</div>
          <div class="srw-code-val">${product?.barcode || parsed.barcode || barcodeDisplay}</div>
        </div>
        <div class="srw-code">
          <div class="srw-code-label">RMS</div>
          <div class="srw-code-val">${found ? (product?.rms || '-') : `<input type="text" id="srwRms" style="width:100%;border:none;background:transparent;text-align:center;font-family:monospace;font-size:11px;color:var(--text);" placeholder="RMS">`}</div>
        </div>
      </div>
      
      <div class="srw-form">
        <div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:10px;">📅 EXPIRY & BATCH</div>
        <div class="form-row">
          <div class="form-group" style="margin:0;">
            <label class="form-label">EXPIRY (DDMMYY)</label>
            <input type="text" class="form-input mono" id="srwExpiryText" placeholder="DDMMYY" maxlength="6" inputmode="numeric" value="${parsed.expiry || ''}" oninput="handleExpiryInput(this)" onkeyup="autoMoveToBatch(this)">
            <input type="hidden" id="srwExpiry" value="${parsed.expiryISO || ''}">
          </div>
          <div class="form-group" style="margin:0;">
            <label class="form-label">BATCH NO</label>
            <input type="text" class="form-input mono" id="srwBatch" placeholder="BATCH" maxlength="20" value="${parsed.batch || ''}" onkeyup="autoMoveToQty(this)">
          </div>
        </div>
        <div id="expiryPreview" style="font-size:12px;color:var(--success);margin-top:6px;text-align:center;display:none;"></div>
      </div>
      
      <div style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:${parsed.isGS1 ? 'rgba(0,230,118,0.1)' : 'rgba(255,171,0,0.1)'};border-radius:8px;margin-bottom:12px;justify-content:center;">
        <span>${parsed.isGS1 ? '✅' : '📝'}</span>
        <span style="font-size:12px;font-weight:600;color:${parsed.isGS1 ? 'var(--success)' : 'var(--warning)'};">${parsed.isGS1 ? 'GS1 Barcode' : 'Manual Entry'}</span>
      </div>
      
      <div class="srw-qty">
        <span style="font-weight:600;color:var(--text-dim);">QTY:</span>
        <button class="srw-qty-btn" onclick="adjustSrwQty(-1)">−</button>
        <input type="number" class="srw-qty-input" id="srwQty" value="1" min="1">
        <button class="srw-qty-btn" onclick="adjustSrwQty(1)">+</button>
      </div>
      
      <div class="srw-actions">
        ${!found ? `
        <button class="btn btn-primary btn-full" onclick="saveAsNewProduct()">➕ ADD TO MASTER & SAVE</button>
        ` : `
        <button class="btn btn-primary btn-full" onclick="saveScanResult()">💾 SAVE TO HISTORY</button>
        `}
        <button class="btn btn-secondary btn-full" onclick="hideScanResult()">✕ Cancel</button>
      </div>
    </div>
  `;
  
  // Store data
  widget.dataset.parsed = JSON.stringify(parsed);
  widget.dataset.product = product ? JSON.stringify(product) : '';
  widget.dataset.barcode = barcodeDisplay;
  
  widget.classList.add('show');
  
  // Focus
  setTimeout(() => {
    if (!found) {
      document.getElementById('srwName')?.focus();
    } else if (!parsed.expiry) {
      document.getElementById('srwExpiryText')?.focus();
    }
  }, 100);
}

function handleExpiryInput(input) {
  const val = input.value.replace(/\D/g, '');
  input.value = val;
  
  if (val.length === 6) {
    const dd = parseInt(val.slice(0, 2));
    const mm = parseInt(val.slice(2, 4));
    const yy = parseInt(val.slice(4, 6));
    
    if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) {
      const year = yy >= 50 ? 1900 + yy : 2000 + yy;
      const isoDate = `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      document.getElementById('srwExpiry').value = isoDate;
      
      const preview = document.getElementById('expiryPreview');
      const status = GS1.getStatus(isoDate);
      const days = GS1.getDays(isoDate);
      preview.style.display = 'block';
      preview.style.color = status === 'expired' ? 'var(--danger)' : status === 'expiring' ? 'var(--warning)' : 'var(--success)';
      preview.innerHTML = `📅 ${dd}/${mm}/${year} — ${status === 'expired' ? 'EXPIRED' : days + ' days left'}`;
    }
  } else {
    document.getElementById('expiryPreview').style.display = 'none';
  }
}

function autoMoveToBatch(input) {
  if (input.value.length >= 6) {
    document.getElementById('srwBatch').focus();
  }
}

function autoMoveToQty(input) {
  if (event.key === 'Enter') {
    document.getElementById('srwQty').focus();
    document.getElementById('srwQty').select();
  }
}

function adjustSrwQty(delta) {
  const input = document.getElementById('srwQty');
  input.value = Math.max(1, parseInt(input.value || 1) + delta);
}

function hideScanResult() {
  document.getElementById('scanResultWidget').classList.remove('show');
}

async function saveAsNewProduct() {
  const widget = document.getElementById('scanResultWidget');
  const parsed = JSON.parse(widget.dataset.parsed);
  const barcode = widget.dataset.barcode.replace(/\D/g, '');
  
  const newProduct = {
    barcode: barcode,
    gtin: parsed.gtin || '',
    name: document.getElementById('srwName')?.value.trim() || 'Unknown Product',
    rms: document.getElementById('srwRms')?.value.trim() || '',
    brand: document.getElementById('srwBrand')?.value.trim() || '',
    supplier: document.getElementById('srwSupplier')?.value.trim() || '',
    returnPolicy: ''
  };
  
  if (!newProduct.name || newProduct.name === 'Unknown Product') {
    toast('Please enter product name', 'error');
    document.getElementById('srwName')?.focus();
    return;
  }
  
  // Save to master
  await DB.addMaster(newProduct);
  Matcher.addProduct(newProduct);
  
  // Save to history
  const expiry = document.getElementById('srwExpiry')?.value || '';
  const batch = document.getElementById('srwBatch')?.value.trim() || '';
  const qty = parseInt(document.getElementById('srwQty')?.value) || 1;
  
  const scan = {
    ...newProduct,
    expiryISO: expiry,
    expiryDisplay: expiry ? GS1.formatDisplay(expiry) : '',
    batch: batch,
    qty: qty,
    isGS1: parsed.isGS1,
    matchType: 'NEW'
  };
  
  await DB.addScan(scan);
  await refreshUI();
  
  hideScanResult();
  haptic('success');
  toast('✅ Product added!', 'success');
}

async function saveScanResult() {
  const widget = document.getElementById('scanResultWidget');
  const parsed = JSON.parse(widget.dataset.parsed);
  const product = widget.dataset.product ? JSON.parse(widget.dataset.product) : {};
  
  const expiry = document.getElementById('srwExpiry')?.value || '';
  const batch = document.getElementById('srwBatch')?.value.trim() || '';
  const qty = parseInt(document.getElementById('srwQty')?.value) || 1;
  
  const scan = {
    gtin: product.gtin || parsed.gtin || '',
    barcode: product.barcode || parsed.barcode || '',
    rms: product.rms || '',
    alshayaCode: product.alshayaCode || '',
    name: product.name || 'Unknown',
    brand: product.brand || '',
    supplier: product.supplier || '',
    conceptGroup: product.conceptGroup || '',
    returnPolicy: product.returnPolicy || '',
    keyBrands: product.keyBrands || '',
    expiryISO: expiry,
    expiryDisplay: expiry ? GS1.formatDisplay(expiry) : '',
    batch: batch,
    qty: qty,
    isGS1: parsed.isGS1,
    matchType: product.matchType || 'NONE'
  };
  
  await DB.addScan(scan);
  await refreshUI();
  
  hideScanResult();
  haptic('success');
  toast(`Saved: ${scan.name}`, 'success');
}

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  const [scans, master] = await Promise.all([DB.getAllScans(), DB.getAllMaster()]);
  
  App.scans = scans;
  Matcher.build(master);
  
  // Stats
  document.getElementById('statMaster').textContent = master.length;
  document.getElementById('statScans').textContent = scans.length;
  
  // Count expiring
  const expiring = scans.filter(s => GS1.getStatus(s.expiryISO) === 'expiring').length;
  document.getElementById('statExpiring').textContent = expiring;
  
  // Settings
  document.getElementById('settingsDbCount').textContent = master.length;
  document.getElementById('settingsScanCount').textContent = scans.length;
  
  // Sort by timestamp
  scans.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  // Render lists
  renderHistory('recentList', scans.slice(0, 5), 'emptyRecent');
  renderHistory('historyList', filterScans(scans), 'emptyHistory');
}

function filterScans(scans) {
  if (!App.search) return scans;
  const q = App.search.toLowerCase();
  return scans.filter(s =>
    s.name?.toLowerCase().includes(q) ||
    s.gtin?.includes(q) ||
    s.barcode?.includes(q) ||
    s.rms?.includes(q) ||
    s.batch?.toLowerCase().includes(q) ||
    s.brand?.toLowerCase().includes(q)
  );
}

function renderHistory(containerId, items, emptyId) {
  const container = document.getElementById(containerId);
  const empty = document.getElementById(emptyId);
  
  if (!items.length) {
    container.innerHTML = '';
    if (empty) { container.appendChild(empty); empty.classList.remove('hidden'); }
    return;
  }
  
  if (empty) empty.classList.add('hidden');
  
  container.innerHTML = items.map(item => {
    const status = GS1.getStatus(item.expiryISO);
    const days = GS1.getDays(item.expiryISO);
    
    let badge = '<span class="badge badge-ok">✓</span>';
    if (status === 'expired') badge = '<span class="badge badge-expired">EXP</span>';
    else if (status === 'expiring') badge = `<span class="badge badge-expiring">${days}d</span>`;
    
    return `
      <div class="history-item ${status}" onclick="editItem(${item.id})">
        <div class="item-icon">${item.isGS1 ? '📊' : '📦'}</div>
        <div class="item-info">
          <div class="item-name">${escapeHtml(item.name)}</div>
          <div class="item-meta">${item.expiryDisplay || '-'} • ${item.batch || '-'}</div>
          <div class="item-badges">
            ${item.brand ? `<span class="badge" style="background:rgba(245,158,11,0.2);color:#F59E0B;">${escapeHtml(item.brand)}</span>` : ''}
          </div>
        </div>
        ${badge}
        <div class="qty-controls" onclick="event.stopPropagation()">
          <button class="qty-btn" onclick="adjustQty(${item.id},-1)">−</button>
          <span class="qty-val">${item.qty || 1}</span>
          <button class="qty-btn" onclick="adjustQty(${item.id},1)">+</button>
        </div>
      </div>
    `;
  }).join('');
}

async function adjustQty(id, delta) {
  const item = await DB.getScan(id);
  if (item) {
    item.qty = Math.max(1, (item.qty || 1) + delta);
    await DB.updateScan(item);
    haptic('light');
    await refreshUI();
  }
}

// ============================================
// EDIT MODAL
// ============================================
async function editItem(id) {
  const item = await DB.getScan(id);
  if (!item) return;
  
  App.editingId = id;
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editAlshaya').value = item.alshayaCode || '';
  document.getElementById('editBrand').value = item.brand || '';
  document.getElementById('editSupplier').value = item.supplier || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editModal').classList.add('show');
}

async function saveEdit() {
  const item = await DB.getScan(App.editingId);
  if (!item) return;
  
  item.name = document.getElementById('editName').value.trim();
  item.rms = document.getElementById('editRms').value.trim();
  item.alshayaCode = document.getElementById('editAlshaya').value.trim();
  item.brand = document.getElementById('editBrand').value.trim();
  item.supplier = document.getElementById('editSupplier').value.trim();
  item.expiryISO = document.getElementById('editExpiry').value;
  item.expiryDisplay = item.expiryISO ? GS1.formatDisplay(item.expiryISO) : '';
  item.batch = document.getElementById('editBatch').value.trim();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  
  await DB.updateScan(item);
  closeEditModal();
  await refreshUI();
  toast('Saved', 'success');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  App.editingId = null;
}

async function deleteItem() {
  if (confirm('Delete this item?')) {
    await DB.deleteScan(App.editingId);
    closeEditModal();
    await refreshUI();
    toast('Deleted', 'success');
  }
}

// ============================================
// EXPORT
// ============================================
async function exportCSV() {
  const scans = await DB.getAllScans();
  if (!scans.length) { toast('No data', 'warning'); return; }
  
  const headers = ['STORE NO', 'STORE NAME', 'RMS CODE', 'BARCODE', 'GTIN', 'ALSHAYA CODE', 'DESCRIPTION', 'BRAND', 'SUPPLIER', 'CONCEPT GROUP', 'RETURN POLICY', 'QTY', 'EXPIRY DATE', 'BATCH NO'];
  
  const rows = scans.map(h => [
    CONFIG.STORE_NO,
    CONFIG.STORE_NAME,
    h.rms || '',
    h.barcode || '',
    h.gtin || '',
    h.alshayaCode || '',
    h.name || '',
    h.brand || '',
    h.supplier || '',
    h.conceptGroup || '',
    h.returnPolicy || '',
    h.qty || 1,
    h.expiryDisplay || '',
    h.batch || ''
  ]);
  
  let csv = headers.join(',') + '\n';
  rows.forEach(row => {
    csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  });
  
  download(csv, `pharmascan-${formatDateFile()}.csv`, 'text/csv');
  toast('Exported CSV', 'success');
}

async function exportTSV() {
  const scans = await DB.getAllScans();
  if (!scans.length) { toast('No data', 'warning'); return; }
  
  const headers = ['RMS', 'BARCODE', 'DESCRIPTION', 'QTY', 'EXPIRY DATE', 'BATCH NO', 'STORE NO', 'STORE NAME'];
  
  const rows = scans.map(h => [
    h.rms || '',
    h.barcode || h.gtin || '',
    h.name || '',
    h.qty || 1,
    h.expiryISO ? excelDate(h.expiryISO) : '',
    h.batch || '',
    CONFIG.STORE_NO,
    CONFIG.STORE_NAME
  ]);
  
  let tsv = headers.join('\t') + '\n';
  rows.forEach(row => { tsv += row.join('\t') + '\n'; });
  
  download(tsv, `pharmascan-${formatDateFile()}.tsv`, 'text/tab-separated-values');
  toast('Exported for Excel', 'success');
}

function excelDate(iso) {
  const d = new Date(iso);
  return Math.floor((d - new Date(1899, 11, 30)) / 86400000);
}

async function backupMaster() {
  const master = await DB.getAllMaster();
  if (!master.length) { toast('No master data', 'warning'); return; }
  
  const backup = {
    version: CONFIG.VERSION,
    exportDate: new Date().toISOString(),
    storeNo: CONFIG.STORE_NO,
    storeName: CONFIG.STORE_NAME,
    productCount: master.length,
    products: master
  };
  
  download(JSON.stringify(backup, null, 2), `master-backup-${formatDateFile()}.json`, 'application/json');
  toast(`Backed up ${master.length} products`, 'success');
}

// ============================================
// MASTER UPLOAD
// ============================================
async function uploadMaster(file) {
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('Invalid file', 'error'); return; }
    
    const delim = lines[0].includes('\t') ? '\t' : ',';
    const cols = lines[0].toLowerCase().split(delim).map(c => c.trim().replace(/['"]/g, ''));
    
    console.log('📊 Columns:', cols);
    
    // Find columns - GTIN and BARCODE are SEPARATE
    const idx = {
      gtin: cols.findIndex(c => c === 'gtin'),
      barcode: cols.findIndex(c => c === 'barcode' || c === 'ean'),
      name: cols.findIndex(c => c === 'description' || c === 'name' || c === 'product'),
      rms: cols.findIndex(c => c === 'rms code' || c === 'rms' || c === 'rms_code'),
      alshaya: cols.findIndex(c => c.includes('alshaya') && !c.includes('new')),
      brand: cols.findIndex(c => c === 'brand'),
      supplier: cols.findIndex(c => c.includes('supplier')),
      concept: cols.findIndex(c => c.includes('concept')),
      returnPolicy: cols.findIndex(c => c.includes('return')),
      keyBrands: cols.findIndex(c => c.includes('key') && c.includes('brand'))
    };
    
    console.log('📋 Indexes:', idx);
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g, ''));
      
      const gtin = idx.gtin >= 0 ? row[idx.gtin]?.replace(/\D/g, '') : '';
      const barcode = idx.barcode >= 0 ? row[idx.barcode]?.replace(/\D/g, '') : '';
      const rms = idx.rms >= 0 ? row[idx.rms]?.trim() : '';
      
      // Need at least one identifier
      if (!gtin && !barcode && !rms) continue;
      
      items.push({
        barcode: barcode || gtin || rms, // Use as primary key
        gtin: gtin,
        name: idx.name >= 0 ? row[idx.name] : '',
        rms: rms,
        alshayaCode: idx.alshaya >= 0 ? row[idx.alshaya] : '',
        brand: idx.brand >= 0 ? row[idx.brand] : '',
        supplier: idx.supplier >= 0 ? row[idx.supplier] : '',
        conceptGroup: idx.concept >= 0 ? row[idx.concept] : '',
        returnPolicy: idx.returnPolicy >= 0 ? row[idx.returnPolicy] : '',
        keyBrands: idx.keyBrands >= 0 ? row[idx.keyBrands] : ''
      });
    }
    
    const count = await DB.bulkAddMaster(items);
    await refreshUI();
    toast(`✅ Uploaded ${count} products`, 'success');
  } catch (e) {
    console.error(e);
    toast('Upload failed', 'error');
  }
}

// ============================================
// UTILITIES
// ============================================
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-icon">${{success:'✓',error:'✕',warning:'⚠',info:'ℹ'}[type]}</div><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2500);
}

function haptic(type) {
  if (!navigator.vibrate) return;
  navigator.vibrate({light:10,medium:25,success:[20,40,20],error:[80,40,80]}[type] || 10);
}

function escapeHtml(s) { return s ? String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])) : ''; }
function formatDateFile() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function download(content, name, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type})); a.download = name; a.click(); }

// ============================================
// NAVIGATION & EVENTS
// ============================================
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${id}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-page="${id}"]`)?.classList.add('active');
  if (id !== 'home' && App.scanner.active) Scanner.stop();
  closeSideMenu();
}

function openSideMenu() { 
  document.getElementById('sideMenuBg').classList.add('show'); 
  document.getElementById('sideMenu').classList.add('show'); 
}

function closeSideMenu() { 
  document.getElementById('sideMenuBg').classList.remove('show'); 
  document.getElementById('sideMenu').classList.remove('show'); 
}

function setupEvents() {
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => btn.onclick = () => showPage(btn.dataset.page));
  
  // Scanner
  document.getElementById('btnScanner').onclick = () => Scanner.toggle();
  document.getElementById('scannerFrame').onclick = () => { if (!App.scanner.active) Scanner.start(); };
  
  // Manual input
  document.getElementById('manualInput').onkeypress = e => { if (e.key === 'Enter') processBarcode(document.getElementById('manualInput').value); };
  document.getElementById('btnManualAdd').onclick = () => processBarcode(document.getElementById('manualInput').value);
  document.getElementById('btnManualEntry').onclick = () => document.getElementById('manualInput').focus();
  
  // History
  document.getElementById('btnViewAll').onclick = () => showPage('history');
  document.getElementById('searchInput').oninput = e => { App.search = e.target.value; refreshUI(); };
  document.getElementById('btnExport').onclick = exportCSV;
  document.getElementById('btnClearAll').onclick = async () => { 
    if (confirm('Clear all scanned items?')) { 
      await DB.clearScans(); 
      await refreshUI(); 
      toast('Cleared', 'success'); 
    } 
  };
  
  // Settings - File upload
  document.getElementById('uploadArea').onclick = () => document.getElementById('masterFileInput').click();
  document.getElementById('masterFileInput').onchange = e => { 
    if (e.target.files[0]) { 
      uploadMaster(e.target.files[0]); 
      e.target.value = ''; 
    } 
  };
  
  // Side menu
  document.getElementById('btnMenu').onclick = openSideMenu;
  document.getElementById('sideMenuBg').onclick = closeSideMenu;
  document.getElementById('menuExportCSV').onclick = () => { closeSideMenu(); exportCSV(); };
  document.getElementById('menuExportTSV').onclick = () => { closeSideMenu(); exportTSV(); };
  document.getElementById('menuBackup').onclick = () => { closeSideMenu(); backupMaster(); };
  document.getElementById('menuClearHistory').onclick = async () => { 
    closeSideMenu(); 
    if (confirm('Clear all history?')) { 
      await DB.clearScans(); 
      await refreshUI(); 
      toast('History cleared', 'success'); 
    } 
  };
  document.getElementById('menuClearMaster').onclick = async () => { 
    closeSideMenu(); 
    if (confirm('⚠️ Clear ALL master data?\n\nThis removes all product info.\nBackup first!')) { 
      await DB.clearMaster(); 
      App.master.clear();
      App.masterRMS.clear();
      App.masterGTIN.clear();
      await refreshUI(); 
      toast('Master cleared', 'success'); 
    } 
  };
  
  // Edit modal
  document.getElementById('btnCloseEdit').onclick = closeEditModal;
  document.getElementById('btnSaveEdit').onclick = saveEdit;
  document.getElementById('btnDeleteEdit').onclick = deleteItem;
  document.getElementById('editModal').onclick = e => { if (e.target.id === 'editModal') closeEditModal(); };
  
  // Online/offline
  window.addEventListener('online', () => document.getElementById('offlineTag').classList.remove('show'));
  window.addEventListener('offline', () => document.getElementById('offlineTag').classList.add('show'));
}

// ============================================
// INIT
// ============================================
async function init() {
  console.log(`🚀 PharmaScan Pro v${CONFIG.VERSION}`);
  
  try {
    await DB.init();
    setupEvents();
    await refreshUI();
    
    if (!navigator.onLine) document.getElementById('offlineTag').classList.add('show');
    
    console.log('✅ Ready');
    toast('App ready', 'success');
  } catch (e) {
    console.error(e);
    toast('Init error', 'error');
  }
}

// Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(e => console.log('SW error:', e));
}

// Start
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
