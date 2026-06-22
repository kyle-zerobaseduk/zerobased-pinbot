const fs = require('fs');
const path = require('path');

class Store {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.initFiles();
  }

  initFiles() {
    const files = ['pins.json', 'products.json', 'images.json', 'boards.json', 'state.json', 'schedule.json'];
    files.forEach(file => {
      const filePath = path.join(this.dataDir, file);
      if (!fs.existsSync(filePath)) {
        const data = file === 'schedule.json' 
          ? { slots: ['09:00', '13:00', '18:00'], maxPerDay: 3, timezone: 'Europe/London' }
          : file === 'state.json'
          ? { armed: false }
          : [];
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
    });
  }

  read(filename) {
    const filePath = path.join(this.dataDir, filename);
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  }

  write(filename, data) {
    const filePath = path.join(this.dataDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  // Pins
  getAllPins() {
    return this.read('pins.json');
  }

  addPin(pin) {
    const pins = this.getAllPins();
    pins.push(pin);
    this.write('pins.json', pins);
  }

  updatePin(pin) {
    const pins = this.getAllPins();
    const idx = pins.findIndex(p => p.id === pin.id);
    if (idx >= 0) pins[idx] = pin;
    this.write('pins.json', pins);
  }

  // Products
  getProducts() {
    return this.read('products.json');
  }

  getProduct(id) {
    const products = this.getProducts();
    return products.find(p => p.id === id);
  }

  addProduct(product) {
    const products = this.getProducts();
    product.id = Math.random().toString(36).substr(2, 9);
    products.push(product);
    this.write('products.json', products);
  }

  // Images
  getImages() {
    return this.read('images.json');
  }

  addImage(image) {
    const images = this.getImages();
    image.id = Math.random().toString(36).substr(2, 9);
    image.uses = 0;
    images.push(image);
    this.write('images.json', images);
  }

  // Boards
  getBoards() {
    return this.read('boards.json');
  }

  // State (armed, etc)
  getState(key, defaultValue) {
    const state = this.read('state.json');
    return state[key] !== undefined ? state[key] : defaultValue;
  }

  setState(key, value) {
    const state = this.read('state.json');
    state[key] = value;
    this.write('state.json', state);
  }

  // Schedule
  getSchedule() {
    return this.read('schedule.json');
  }
}

module.exports = Store;
