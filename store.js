const fs = require('fs');
const path = require('path');

const DEFAULT_BRANDS = [
  {
    id: 'kd-publishing',
    name: 'K.D.Publishing',
    destination: 'Amazon',
    enabled: true,
    schedule: { slots: ['09:00', '13:00', '18:00'], maxPerDay: 3, timezone: 'Europe/London' }
  },
  {
    id: 'zerobased-uk',
    name: 'ZeroBased UK',
    destination: 'Etsy',
    enabled: true,
    schedule: { slots: ['10:00', '14:00', '19:00'], maxPerDay: 3, timezone: 'Europe/London' }
  }
];

class Store {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.initFiles();
  }

  initFiles() {
    const defaults = {
      'pins.json': [],
      'products.json': [],
      'images.json': [],
      'boards.json': [],
      'state.json': { armed: false },
      'schedule.json': { slots: ['09:00', '13:00', '18:00'], maxPerDay: 3, timezone: 'Europe/London' },
      'brands.json': DEFAULT_BRANDS
    };

    Object.entries(defaults).forEach(([file, data]) => {
      const filePath = path.join(this.dataDir, file);
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    });
  }

  read(filename) {
    return JSON.parse(fs.readFileSync(path.join(this.dataDir, filename), 'utf8'));
  }

  write(filename, data) {
    fs.writeFileSync(path.join(this.dataDir, filename), JSON.stringify(data, null, 2));
  }

  getBrands() {
    return this.read('brands.json');
  }

  getBrand(id) {
    return this.getBrands().find(b => b.id === id);
  }

  updateBrand(id, patch) {
    const brands = this.getBrands();
    const index = brands.findIndex(b => b.id === id);
    if (index < 0) throw new Error(`Unknown brand: ${id}`);
    brands[index] = { ...brands[index], ...patch, id: brands[index].id };
    this.write('brands.json', brands);
    return brands[index];
  }

  getAllPins(brandId) {
    const pins = this.read('pins.json');
    return brandId ? pins.filter(p => p.brandId === brandId) : pins;
  }

  addPin(pin) {
    const pins = this.getAllPins();
    pins.push({ id: pin.id || this.makeId(), createdAt: new Date().toISOString(), ...pin });
    this.write('pins.json', pins);
  }

  getProducts(brandId) {
    const products = this.read('products.json');
    return brandId ? products.filter(p => p.brandId === brandId) : products;
  }

  getProduct(id) {
    return this.getProducts().find(p => p.id === id);
  }

  addProduct(product) {
    const products = this.getProducts();
    const saved = { id: this.makeId(), enabled: true, ...product };
    products.push(saved);
    this.write('products.json', products);
    return saved;
  }

  getImages(brandId) {
    const images = this.read('images.json');
    return brandId ? images.filter(i => i.brandId === brandId) : images;
  }

  addImage(image) {
    const images = this.getImages();
    const saved = { id: this.makeId(), uses: 0, ...image };
    images.push(saved);
    this.write('images.json', images);
    return saved;
  }

  incrementImageUse(id) {
    const images = this.getImages();
    const image = images.find(i => i.id === id);
    if (image) {
      image.uses = (image.uses || 0) + 1;
      image.lastUsedAt = new Date().toISOString();
      this.write('images.json', images);
    }
  }

  getBoards(brandId) {
    const boards = this.read('boards.json');
    return brandId ? boards.filter(b => b.brandId === brandId) : boards;
  }

  setBoards(brandId, boards) {
    const all = this.getBoards().filter(b => b.brandId !== brandId);
    this.write('boards.json', all.concat(boards.map(b => ({ ...b, brandId }))));
  }

  getState(key, defaultValue) {
    const state = this.read('state.json');
    return state[key] !== undefined ? state[key] : defaultValue;
  }

  setState(key, value) {
    const state = this.read('state.json');
    state[key] = value;
    this.write('state.json', state);
  }

  getSchedule(brandId) {
    if (brandId) return this.getBrand(brandId)?.schedule || null;
    return this.read('schedule.json');
  }

  setSchedule(brandId, schedule) {
    if (typeof brandId === 'object') {
      this.write('schedule.json', brandId);
      return brandId;
    }
    const brand = this.getBrand(brandId);
    if (!brand) throw new Error(`Unknown brand: ${brandId}`);
    return this.updateBrand(brandId, { schedule: { ...brand.schedule, ...schedule } });
  }

  countPinsToday(brandId) {
    const today = new Date().toISOString().slice(0, 10);
    return this.getAllPins(brandId).filter(p => String(p.createdAt || '').startsWith(today)).length;
  }

  makeId() {
    return Math.random().toString(36).slice(2, 11);
  }
}

module.exports = Store;
