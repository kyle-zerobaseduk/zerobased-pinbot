require('dotenv').config();

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const Store = require('./store');
const Pinterest = require('./pinterest');
const Writer = require('./writer');

const app = express();
const port = process.env.PORT || 3000;
const store = new Store(process.env.DATA_DIR || './data');
const writer = new Writer(process.env.ANTHROPIC_API_KEY || '');

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

const pinterestClients = {
  'kd-publishing': new Pinterest(process.env.PINTEREST_TOKEN_KDP || ''),
  'zerobased-uk': new Pinterest(process.env.PINTEREST_TOKEN_ZEROBASED || '')
};

let runtime = { logs: [], runningJobs: new Set(), lastCheck: null };

function addLog(message, brandId = 'system') {
  const entry = { timestamp: new Date().toISOString(), brandId, message };
  runtime.logs.push(entry);
  if (runtime.logs.length > 200) runtime.logs.shift();
  console.log(`[${entry.timestamp}] [${brandId}] ${message}`);
}
function getClient(brandId) { const client = pinterestClients[brandId]; if (!client) throw new Error(`No Pinterest client configured for ${brandId}`); return client; }
function validateBrand(brandId) { const brand = store.getBrand(brandId); if (!brand) throw new Error(`Unknown brand: ${brandId}`); return brand; }
function currentLondonTime() { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
function chooseProductAndImage(brandId) {
  const products = store.getProducts(brandId).filter(p => p.enabled !== false); if (!products.length) return null;
  const recentPins = store.getAllPins(brandId).slice(-10).reverse(); const recentProductIds = new Set(recentPins.slice(0, 3).map(p => p.productId));
  const preferred = products.filter(p => !recentProductIds.has(p.id)); const pool = preferred.length ? preferred : products; const product = pool[Math.floor(Math.random() * pool.length)];
  const images = store.getImages(brandId).filter(i => (i.productId === product.id || i.product === product.name) && i.enabled !== false); if (!images.length) return { product, image: null };
  images.sort((a, b) => (a.uses || 0) - (b.uses || 0)); const minimumUses = images[0].uses || 0; const leastUsed = images.filter(i => (i.uses || 0) === minimumUses);
  return { product, image: leastUsed[Math.floor(Math.random() * leastUsed.length)] };
}
async function createAndPostPin(brandId, { manual = false } = {}) {
  const brand = validateBrand(brandId); if (!brand.enabled && !manual) return null;
  if (runtime.runningJobs.has(brandId)) { addLog('Skipped because a post is already being created', brandId); return null; }
  runtime.runningJobs.add(brandId);
  try {
    const selected = chooseProductAndImage(brandId); if (!selected) throw new Error('No enabled products configured'); if (!selected.image) throw new Error(`No image configured for ${selected.product.name}`);
    const product = selected.product; const image = selected.image; const boardId = product.boardId || brand.boardId; if (!boardId) throw new Error('No Pinterest board selected for this product or brand');
    const description = await writer.generateDescription(product, brand); const client = getClient(brandId);
    const pin = await client.createPin({ title: product.pinTitle || product.name, description, imageUrl: image.url, link: product.link, boardId });
    store.incrementImageUse(image.id); store.addPin({ id: pin.id, brandId, productId: product.id, productName: product.name, imageId: image.id, boardId, destination: brand.destination, link: product.link, description });
    addLog(`Pin created for ${product.name} (${pin.id})`, brandId); return pin;
  } catch (err) { addLog(`ERROR: ${err.response?.data?.message || err.message}`, brandId); throw err; } finally { runtime.runningJobs.delete(brandId); }
}

app.get('/privacy/ZeroBasedUK', (req, res) => res.sendFile(path.join(__dirname, 'public', 'zerobaseduk-privacy.html')));
app.get('/api/brands', (req, res) => res.json(store.getBrands().map(brand => ({ ...brand, pinterestConfigured: getClient(brand.id).isConfigured(), products: store.getProducts(brand.id).length, images: store.getImages(brand.id).length, pinsToday: store.countPinsToday(brand.id) }))));
app.patch('/api/brands/:brandId', (req, res) => { try { const allowed = ['enabled', 'boardId', 'schedule']; const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k))); res.json(store.updateBrand(req.params.brandId, patch)); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/products', (req, res) => res.json(store.getProducts(req.query.brandId)));
app.post('/api/products', (req, res) => { try { const { brandId, name, link, keywords = [], boardId, descriptions = [] } = req.body; validateBrand(brandId); if (!name || !link) return res.status(400).json({ error: 'brandId, name and link are required' }); const product = store.addProduct({ brandId, name, link, keywords, boardId, descriptions }); addLog(`Product added: ${name}`, brandId); res.status(201).json(product); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/images', (req, res) => res.json(store.getImages(req.query.brandId)));
app.post('/api/images', (req, res) => { try { const { brandId, productId, product, url } = req.body; validateBrand(brandId); if (!url || (!productId && !product)) return res.status(400).json({ error: 'brandId, image URL and product are required' }); const image = store.addImage({ brandId, productId, product, url }); addLog('Product image added', brandId); res.status(201).json(image); } catch (err) { res.status(400).json({ error: err.message }); } });
app.get('/api/boards/:brandId', async (req, res) => { try { const brand = validateBrand(req.params.brandId); const boards = await getClient(brand.id).getBoards(); store.setBoards(brand.id, boards); res.json(boards); } catch (err) { res.status(502).json({ error: err.response?.data?.message || err.message }); } });
app.get('/api/pins', (req, res) => res.json(store.getAllPins(req.query.brandId).slice().reverse()));
app.post('/api/post-now/:brandId', async (req, res) => { try { res.status(201).json(await createAndPostPin(req.params.brandId, { manual: true })); } catch (err) { res.status(400).json({ error: err.response?.data?.message || err.message }); } });
app.get('/api/status', (req, res) => res.json({ armed: store.getState('armed', false), lastCheck: runtime.lastCheck, serverTime: new Date().toISOString(), londonTime: currentLondonTime(), runningJobs: Array.from(runtime.runningJobs) }));
app.post('/api/arm', (req, res) => { const armed = Boolean(req.body.armed); store.setState('armed', armed); addLog(`Scheduler ${armed ? 'ARMED' : 'PAUSED'}`); res.json({ armed }); });
app.get('/api/logs', (req, res) => { const brandId = req.query.brandId; const logs = brandId ? runtime.logs.filter(l => l.brandId === brandId || l.brandId === 'system') : runtime.logs; res.json({ logs: logs.slice(-100).reverse() }); });
cron.schedule('* * * * *', async () => { runtime.lastCheck = new Date().toISOString(); if (!store.getState('armed', false)) return; const currentTime = currentLondonTime(); for (const brand of store.getBrands()) { if (!brand.enabled) continue; const schedule = brand.schedule || {}; if (!(schedule.slots || []).includes(currentTime)) continue; if (store.countPinsToday(brand.id) >= (schedule.maxPerDay || 3)) continue; try { await createAndPostPin(brand.id); } catch (_) {} } });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { addLog(`Unhandled error: ${err.message}`); res.status(500).json({ error: 'Internal server error' }); });
app.listen(port, () => { addLog(`PinBot V2 running on port ${port}`); addLog('K.D.Publishing and ZeroBased UK profiles loaded'); });
