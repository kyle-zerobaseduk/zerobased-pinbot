'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const MAX_LOGS = 300;

// Two brands, fixed. Everything else in the app hangs off these ids.
const DEFAULT_BRANDS = [
  {
    id: 'kd',
    name: 'K.D. Publishing',
    marketplace: 'amazon',
    tagline: 'Guided journals, word searches and puzzle books on Amazon KDP',
    accent: '#c2703f',
    paused: false,
    slots: ['09:00', '13:00', '18:00'],
    pinterest: null,
  },
  {
    id: 'zb',
    name: 'ZeroBased UK',
    marketplace: 'etsy',
    tagline: 'Digital products and printables on Etsy',
    accent: '#3f7dc2',
    paused: false,
    slots: ['10:00', '15:00', '20:00'],
    pinterest: null,
  },
];

// Starter board names so products can be set up before Pinterest is connected.
// They are replaced wholesale by the real boards once an account is linked.
const STARTER_BOARDS = {
  kd: ['Guided Journals', '80-Day Journals', 'Word Search Books', 'Puzzle Books', 'Gift Ideas for Book Lovers'],
  zb: ['Digital Downloads', 'Printable Planners', 'Budgeting & Money', 'Small Business Templates'],
};

function starterBoards() {
  const boards = {};
  for (const [brandId, names] of Object.entries(STARTER_BOARDS)) {
    boards[brandId] = names.map((name, index) => ({
      id: `starter-${brandId}-${index + 1}`,
      name,
      manual: true,
    }));
  }
  return boards;
}

function defaultData() {
  return {
    version: 2,
    settings: {
      timezone: config.timezone,
      paused: true, // start paused; nothing posts until the user says so
      liveMode: false, // false = simulation, no real Pinterest calls
      maxPerDay: 3,
      planAheadDays: 3,
    },
    brands: DEFAULT_BRANDS.map((b) => ({ ...b })),
    products: [],
    pins: [],
    boards: starterBoards(), // brandId -> [{id, name}]; replaced by real Pinterest boards
    logs: [],
    oauthStates: [],
  };
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

class Db {
  constructor(file = config.dbFile) {
    this.file = file;
    this.data = defaultData();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.mkdirSync(config.uploadsDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...defaultData(), ...parsed };
        this.data.settings = { ...defaultData().settings, ...(parsed.settings || {}) };
        if (this.migrate()) this.save();
        return;
      } catch (err) {
        // Never lose data on a parse error: park the bad file and start clean.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, backup);
        } catch (_) {
          /* best effort */
        }
        this.data = defaultData();
        this.log('error', `Could not read data file (${err.message}). Previous file kept at ${backup}.`);
      }
    }
    this.save();
  }

  // Make sure both brands always exist, even if the file predates a change.
  migrate() {
    let changed = false;
    const resetLegacyDraftApprovals = Number(this.data.version || 1) < 2;
    for (const preset of DEFAULT_BRANDS) {
      const existing = this.data.brands.find((b) => b.id === preset.id);
      if (!existing) {
        this.data.brands.push({ ...preset });
        changed = true;
      } else {
        for (const key of Object.keys(preset)) {
          if (existing[key] === undefined) {
            existing[key] = preset[key];
            changed = true;
          }
        }
      }
    }
    if (!Array.isArray(this.data.oauthStates)) {
      this.data.oauthStates = [];
      changed = true;
    }
    if (!this.data.boards || typeof this.data.boards !== 'object') {
      this.data.boards = {};
      changed = true;
    }
    for (const [brandId, boards] of Object.entries(starterBoards())) {
      if (!Array.isArray(this.data.boards[brandId])) {
        this.data.boards[brandId] = boards;
        changed = true;
      }
    }

    // Pinterest requires the owner to consider and approve each Pin individually.
    // Existing records are deliberately migrated to Not approved; no old queue item
    // may inherit permission merely because it predates this field.
    for (const pin of this.data.pins) {
      if (resetLegacyDraftApprovals || pin.approvedForPublishing === undefined) {
        pin.approvedForPublishing = false;
        pin.approvedAt = null;
        changed = true;
      }
    }

    // Keep only operational identifiers from Pinterest responses. Account IDs,
    // account types, board privacy and cached Sandbox board lists are not needed.
    for (const brand of this.data.brands) {
      for (const key of ['pinterest', 'pinterestSandbox']) {
        const connection = brand[key];
        if (!connection) continue;
        for (const unnecessary of ['accountId', 'accountType']) {
          if (connection[unnecessary] !== undefined) {
            delete connection[unnecessary];
            changed = true;
          }
        }
      }
      if (brand.pinterestSandboxBoards !== undefined) {
        delete brand.pinterestSandboxBoards;
        changed = true;
      }
      // Fetch the connected account's board list only when the owner needs the
      // selector. Selected board IDs remain on products and Pins, but the full
      // Pinterest response is not retained in the data file.
      if (brand.pinterest && this.data.boards[brand.id]?.length) {
        this.data.boards[brand.id] = [];
        changed = true;
      }
    }
    for (const boards of Object.values(this.data.boards)) {
      for (const board of boards) {
        if (board.privacy !== undefined) {
          delete board.privacy;
          changed = true;
        }
      }
    }
    if (this.data.version !== 2) {
      this.data.version = 2;
      changed = true;
    }
    return changed;
  }

  // Write to a temp file then rename, so a crash mid-write cannot truncate the data.
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  log(level, message) {
    const entry = { t: new Date().toISOString(), level, message };
    this.data.logs.push(entry);
    if (this.data.logs.length > MAX_LOGS) {
      this.data.logs = this.data.logs.slice(-MAX_LOGS);
    }
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}`);
    return entry;
  }

  // ---- brands -------------------------------------------------------------
  brands() {
    return this.data.brands;
  }

  brand(id) {
    return this.data.brands.find((b) => b.id === id) || null;
  }

  // ---- products -----------------------------------------------------------
  products(brandId) {
    return brandId ? this.data.products.filter((p) => p.brandId === brandId) : this.data.products;
  }

  product(id) {
    return this.data.products.find((p) => p.id === id) || null;
  }

  addProduct(input) {
    const product = {
      id: newId('prod'),
      brandId: input.brandId,
      title: input.title,
      url: input.url,
      kind: input.kind || '',
      keywords: input.keywords || [],
      notes: input.notes || '',
      boardId: input.boardId || '',
      active: input.active !== false,
      images: [],
      pinCount: 0,
      lastPinnedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.data.products.push(product);
    this.save();
    return product;
  }

  updateProduct(id, patch) {
    const product = this.product(id);
    if (!product) return null;
    const allowed = ['title', 'url', 'kind', 'keywords', 'notes', 'boardId', 'active', 'brandId'];
    for (const key of allowed) {
      if (patch[key] !== undefined) product[key] = patch[key];
    }
    this.save();
    return product;
  }

  deleteProduct(id) {
    const before = this.data.products.length;
    this.data.products = this.data.products.filter((p) => p.id !== id);
    // Queued pins for a deleted product are meaningless; drop them but keep history.
    this.data.pins = this.data.pins.filter((pin) => pin.productId !== id || pin.status !== 'queued');
    this.save();
    return this.data.products.length < before;
  }

  addImage(productId, image) {
    const product = this.product(productId);
    if (!product) return null;
    const record = {
      id: newId('img'),
      url: image.url || '',
      file: image.file || '',
      uses: 0,
      addedAt: new Date().toISOString(),
    };
    product.images.push(record);
    this.save();
    return record;
  }

  deleteImage(productId, imageId) {
    const product = this.product(productId);
    if (!product) return false;
    const before = product.images.length;
    product.images = product.images.filter((i) => i.id !== imageId);
    this.save();
    return product.images.length < before;
  }

  // ---- pins ---------------------------------------------------------------
  pins(filter = {}) {
    return this.data.pins.filter((pin) => {
      if (filter.brandId && pin.brandId !== filter.brandId) return false;
      if (filter.status && pin.status !== filter.status) return false;
      return true;
    });
  }

  pin(id) {
    return this.data.pins.find((p) => p.id === id) || null;
  }

  addPin(input) {
    const pin = {
      id: newId('pin'),
      brandId: input.brandId,
      productId: input.productId,
      imageId: input.imageId || '',
      boardId: input.boardId || '',
      title: input.title,
      description: input.description,
      link: input.link,
      status: input.status || 'queued',
      scheduledFor: input.scheduledFor,
      postedAt: null,
      pinterestPinId: null,
      pinterestUrl: null,
      error: null,
      attempts: 0,
      approvedForPublishing: false,
      approvedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.data.pins.push(pin);
    this.save();
    return pin;
  }

  updatePin(id, patch) {
    const pin = this.pin(id);
    if (!pin) return null;
    Object.assign(pin, patch);
    this.save();
    return pin;
  }

  deletePin(id) {
    const before = this.data.pins.length;
    this.data.pins = this.data.pins.filter((p) => p.id !== id);
    this.save();
    return this.data.pins.length < before;
  }

  // ---- misc ---------------------------------------------------------------
  setSettings(patch) {
    const allowed = ['timezone', 'paused', 'liveMode', 'maxPerDay', 'planAheadDays'];
    for (const key of allowed) {
      if (patch[key] !== undefined) this.data.settings[key] = patch[key];
    }
    this.save();
    return this.data.settings;
  }

  setBoards(brandId, boards) {
    this.data.boards[brandId] = boards.map((board) => ({ id: board.id, name: board.name }));

    // Products pointing at a board that no longer exists would fail at post
    // time with an unhelpful error, so surface them now instead.
    const validIds = new Set(boards.map((b) => b.id));
    const orphaned = this.products(brandId).filter((p) => p.boardId && !validIds.has(p.boardId));
    for (const product of orphaned) product.boardId = '';
    if (orphaned.length) {
      this.log('warn', `${orphaned.length} product(s) need a board chosen again: ${orphaned.map((p) => p.title).join(', ')}`);
    }

    this.save();
    return orphaned;
  }

  boards(brandId) {
    return this.data.boards[brandId] || [];
  }
}

module.exports = { Db, newId, defaultData, starterBoards, DEFAULT_BRANDS, STARTER_BOARDS };
