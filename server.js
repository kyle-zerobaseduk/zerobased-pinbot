const express = require('express');
const cron = require('node-cron');
const path = require('path');
const crypto = require('crypto');
const Store = require('./lib/store');
const Pinterest = require('./lib/pinterest');
const Writer = require('./lib/writer');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Auth middleware
const dashboardPassword = process.env.DASHBOARD_PASSWORD || 'default';
const hashPassword = (pwd) => crypto.createHash('sha256').update(pwd).digest('hex');

app.use((req, res, next) => {
    if (req.path === '/' || req.path.startsWith('/public') || req.path.startsWith('/api')) {
        next();
    } else {
        next();
    }
});

// Initialize services
const store = new Store(process.env.DATA_DIR || './data');
const pinterest = new Pinterest(process.env.PINTEREST_TOKEN || '');
const writer = new Writer(process.env.ANTHROPIC_API_KEY || '', process.env.AI_MODEL || 'claude-haiku-4-5-20251001');

let systemState = {
    armed: false,
    lastCheck: new Date(),
    nextPost: null,
    logs: []
};

// Logging utility
function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${msg}`;
    systemState.logs.push(logEntry);
    if (systemState.logs.length > 100) systemState.logs.shift();
    console.log(logEntry);
}

// ===== API ENDPOINTS =====

// Products API
app.get('/api/products', (req, res) => {
    try {
        const products = store.getProducts();
        res.json(products);
    } catch (err) {
        addLog(`ERROR getting products: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', (req, res) => {
    try {
        const { name, link, keywords } = req.body;
        if (!name || !link || !keywords) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        store.addProduct({ name, link, keywords });
        addLog(`Product added: ${name}`);
        res.json({ success: true, name });
    } catch (err) {
        addLog(`ERROR adding product: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Images API
app.get('/api/images', (req, res) => {
    try {
        const images = store.getImages();
        res.json(images);
    } catch (err) {
        addLog(`ERROR getting images: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/images', (req, res) => {
    try {
        const { product, url } = req.body;
        if (!product || !url) {
            return res.status(400).json({ error: 'Missing product or URL' });
        }
        store.addImage({ product, url });
        addLog(`Image added for ${product}`);
        res.json({ success: true, product });
    } catch (err) {
        addLog(`ERROR adding image: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Schedule API
app.post('/api/schedule', (req, res) => {
    try {
        const { slots, maxPerDay } = req.body;
        if (!slots || !maxPerDay) {
            return res.status(400).json({ error: 'Missing schedule data' });
        }
        store.setSchedule({ slots, maxPerDay });
        addLog(`Schedule updated: ${slots.join(', ')} (max ${maxPerDay}/day)`);
        res.json({ success: true, slots, maxPerDay });
    } catch (err) {
        addLog(`ERROR saving schedule: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Boards API
app.get('/api/boards', async (req, res) => {
    try {
        const boards = await pinterest.getBoards();
        addLog(`Loaded ${boards.length} boards`);
        res.json(boards);
    } catch (err) {
        addLog(`ERROR loading boards: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Arm/Disarm API
app.post('/api/arm', (req, res) => {
    try {
        const { armed } = req.body;
        systemState.armed = armed;
        addLog(`System ${armed ? 'ARMED' : 'DISARMED'}`);
        res.json({ success: true, armed });
    } catch (err) {
        addLog(`ERROR updating arm status: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Status API
app.get('/api/status', (req, res) => {
    try {
        res.json({
            armed: systemState.armed,
            lastCheck: systemState.lastCheck,
            nextPost: systemState.nextPost,
            logsCount: systemState.logs.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Logs API
app.get('/api/logs', (req, res) => {
    try {
        res.json({ logs: systemState.logs.slice(-50) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== SCHEDULER =====

// Check every minute for scheduled posts
cron.schedule('* * * * *', async () => {
    if (!systemState.armed) return;

    try {
        const now = new Date();
        const schedule = store.getSchedule();
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

        // Check if current time matches any scheduled slot
        if (schedule.slots.includes(currentTime)) {
            const postsToday = systemState.logs.filter(l => 
                l.includes('Pin created') && 
                l.substring(1, 9) === now.toISOString().substring(0, 10)
            ).length;

            if (postsToday < schedule.maxPerDay) {
                await createAndPostPin();
            }
        }

        systemState.lastCheck = new Date();
    } catch (err) {
        addLog(`ERROR in scheduler: ${err.message}`);
    }
});

// Create and post a pin
async function createAndPostPin() {
    try {
        const products = store.getProducts();
        const images = store.getImages();

        if (products.length === 0 || images.length === 0) {
            addLog('Skipping post: no products or images configured');
            return;
        }

        // Get next product (round-robin)
        const product = products[Math.floor(Math.random() * products.length)];

        // Get images for this product
        const productImages = images.filter(img => img.product === product.name);
        if (productImages.length === 0) {
            addLog(`No images for ${product.name}`);
            return;
        }

        const image = productImages[Math.floor(Math.random() * productImages.length)];

        // Generate description using AI
        const description = await writer.generateDescription(product, image);

        // Create pin on Pinterest
        const pin = await pinterest.createPin({
            title: product.name,
            description,
            imageUrl: image.url,
            link: product.link
        });

        addLog(`Pin created: ${product.name}`);
        systemState.logs.push({
            timestamp: new Date(),
            product: product.name,
            pinId: pin.id
        });
    } catch (err) {
        addLog(`ERROR creating pin: ${err.message}`);
    }
}

// ===== DASHBOARD ROUTES =====

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== ERROR HANDLING =====

app.use((err, req, res, next) => {
    addLog(`ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
});

// ===== START SERVER =====

app.listen(port, () => {
    addLog(`PinBot server running on port ${port}`);
    addLog(`Timezone: ${process.env.TZ || 'UTC'}`);
    addLog('Ready for commands');
});