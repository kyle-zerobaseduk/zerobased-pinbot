const express = require('express');
const cron = require('node-cron');
const dotenv = require('dotenv');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/London';
const DATA_DIR = process.env.DATA_DIR || './data';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'default-change-me';

// Import modules
const Store = require('./lib/store');
const PinterestAPI = require('./lib/pinterest');
const Writer = require('./lib/writer');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize store
const store = new Store(DATA_DIR);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Dashboard password check middleware
const authMiddleware = (req, res, next) => {
  const token = req.cookies?.auth;
  const hash = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest('hex');
  
  if (token === hash) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized' });
};

// Set cookie for authentication
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const hash = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest('hex');
  
  if (password === DASHBOARD_PASSWORD) {
    res.cookie('auth', hash, { 
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
    return res.json({ success: true });
  }
  
  res.status(401).json({ error: 'Invalid password' });
});

// API Routes
app.get('/api/status', authMiddleware, (req, res) => {
  const pins = store.getAllPins();
  const schedule = store.getSchedule();
  res.json({ 
    armed: store.getState('armed', false),
    totalPins: pins.length,
    schedule,
    nextCheck: new Date()
  });
});

app.post('/api/boards/refresh', authMiddleware, async (req, res) => {
  try {
    const pinterest = new PinterestAPI(process.env.PINTEREST_TOKEN);
    const boards = await pinterest.getBoards();
    store.setState('boards', boards);
    res.json(boards);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/boards', authMiddleware, (req, res) => {
  const boards = store.getState('boards', []);
  res.json(boards);
});

app.post('/api/schedule', authMiddleware, (req, res) => {
  const { slots, maxPerDay, timezone } = req.body;
  store.setState('schedule', { slots, maxPerDay, timezone });
  res.json({ success: true });
});

app.get('/api/schedule', authMiddleware, (req, res) => {
  const schedule = store.getSchedule();
  res.json(schedule);
});

app.get('/api/products', authMiddleware, (req, res) => {
  const products = store.getProducts();
  res.json(products);
});

app.post('/api/products', authMiddleware, (req, res) => {
  const { name, etsy_link, keywords } = req.body;
  store.addProduct({ name, etsy_link, keywords });
  res.json({ success: true });
});

app.get('/api/images', authMiddleware, (req, res) => {
  const images = store.getImages();
  res.json(images);
});

app.post('/api/images', authMiddleware, (req, res) => {
  const { url, product_id } = req.body;
  store.addImage({ url, product_id });
  res.json({ success: true });
});

app.post('/api/pins/create', authMiddleware, async (req, res) => {
  try {
    const { board_id, product_id, scheduled_for } = req.body;
    const writer = new Writer(process.env.ANTHROPIC_API_KEY);
    const product = store.getProduct(product_id);
    const angle = Math.floor(Math.random() * 10);
    
    const description = await writer.generatePinDescription(product.name, product.keywords, angle);
    
    const pin = {
      id: crypto.randomUUID(),
      board_id,
      product_id,
      description,
      scheduled_for: new Date(scheduled_for),
      created_at: new Date(),
      status: 'scheduled',
      posted_at: null
    };
    
    store.addPin(pin);
    res.json(pin);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pins', authMiddleware, (req, res) => {
  const pins = store.getAllPins();
  res.json(pins);
});

app.post('/api/control/arm', authMiddleware, (req, res) => {
  const { armed } = req.body;
  store.setState('armed', armed);
  res.json({ armed });
});

// Serve dashboard HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Scheduler
const scheduler = () => {
  cron.schedule('* * * * *', { tz: TZ }, async () => {
    if (!store.getState('armed', false)) return;
    
    const now = new Date();
    const schedule = store.getSchedule();
    const pins = store.getAllPins();
    
    // Count posts today
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const postedToday = pins.filter(p => {
      const posted = new Date(p.posted_at);
      return p.status === 'posted' && posted >= today;
    }).length;
    
    if (postedToday >= schedule.maxPerDay) return;
    
    // Check if current time matches any schedule slot
    const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const isScheduleTime = schedule.slots.includes(currentHHMM);
    
    if (isScheduleTime) {
      // Find next scheduled pin
      const nextPin = pins.find(p => p.status === 'scheduled' && new Date(p.scheduled_for) <= now);
      
      if (nextPin) {
        try {
          const pinterest = new PinterestAPI(process.env.PINTEREST_TOKEN);
          const board = store.getState('boards', []).find(b => b.id === nextPin.board_id);
          const image = store.getImages().find(img => img.product_id === nextPin.product_id);
          
          if (image && board) {
            const created = await pinterest.createPin({
              board_id: board.id,
              media_source: image.url,
              description: nextPin.description,
              link: store.getProduct(nextPin.product_id).etsy_link
            });
            
            nextPin.status = 'posted';
            nextPin.posted_at = new Date();
            store.updatePin(nextPin);
            
            console.log(`✅ Posted pin: ${nextPin.id}`);
          }
        } catch (err) {
          console.error(`❌ Failed to post pin ${nextPin.id}:`, err.message);
          nextPin.status = 'failed';
          nextPin.error = err.message;
          store.updatePin(nextPin);
        }
      }
    }
  });
};

// Start scheduler
scheduler();

app.listen(PORT, () => {
  console.log(`🤖 PinBot running on port ${PORT}`);
  console.log(`📍 Timezone: ${TZ}`);
  console.log(`🔐 Dashboard: http://localhost:${PORT}`);
});
