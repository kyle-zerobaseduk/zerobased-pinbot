'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

let state = null;
let brandId = localStorage.getItem('pinbot.brand') || 'kd';
let activeTab = 'products';
let openProductId = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(message, bad) {
  let node = el('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.className = bad ? 'bad' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Something went wrong.');
  return payload;
}

function tz() {
  return (state && state.settings.timezone) || 'Europe/London';
}

function fmtTime(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(), hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

function fmtDay(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz(), weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(iso));
}

function dayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date(iso));
}

// Trim to a word boundary so previews never cut a hashtag in half.
function preview(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

function imageSrc(image) {
  if (!image) return '';
  return image.file ? `/uploads/${image.file}` : image.url;
}

function brand() {
  return state.brands.find((b) => b.id === brandId) || state.brands[0];
}

function boardsForBrand() {
  return state.boards[brandId] || [];
}

function boardName(id) {
  const found = boardsForBrand().find((b) => b.id === id);
  return found ? found.name : '';
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async function boot() {
  const session = await api('/session');
  if (!session.passwordSet) {
    el('login').classList.remove('hidden');
    el('login-error').textContent = 'No dashboard password is set on the server yet.';
    return;
  }
  if (session.authed) return showApp();
  el('login').classList.remove('hidden');
}

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  el('login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: el('login-password').value } });
    el('login').classList.add('hidden');
    await showApp();
  } catch (err) {
    el('login-error').textContent = err.message;
  }
});

el('sign-out').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.reload();
});

async function showApp() {
  el('login').classList.add('hidden');
  el('app').classList.remove('hidden');
  el('tabs').classList.remove('hidden');
  await refresh();
  setInterval(refresh, 30000);
}

async function refresh() {
  try {
    state = await api('/state');
    render();
  } catch (err) {
    if (String(err.message).includes('sign in')) location.reload();
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

function render() {
  renderBrandSwitch();
  renderStatus();
  renderProducts();
  renderProductForm();
  renderQueue();
  renderBoards();
  renderSettings();
  renderLogs();
}

function renderBrandSwitch() {
  el('brand-switch').innerHTML = state.brands.map((b) => `
    <button data-brand="${b.id}" class="${b.id === brandId ? 'active' : ''}">
      ${esc(b.name)}<small>${b.marketplace === 'amazon' ? 'Amazon KDP' : 'Etsy'}</small>
    </button>`).join('');

  el('brand-switch').querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      brandId = button.dataset.brand;
      localStorage.setItem('pinbot.brand', brandId);
      openProductId = null;
      resetProductForm();
      render();
    });
  });
}

function renderStatus() {
  const b = brand();
  const running = !state.settings.paused && !b.paused;
  const queued = state.pins.filter((p) => p.brandId === brandId && p.status === 'queued');
  const next = queued.slice().sort((x, y) => Date.parse(x.scheduledFor) - Date.parse(y.scheduledFor))[0];

  el('stat-posting').innerHTML = running
    ? '<span class="pill ok">Running</span>'
    : '<span class="pill warn">Paused</span>';
  el('stat-mode').innerHTML = state.settings.liveMode
    ? '<span class="pill ok">Live</span>'
    : '<span class="pill mute">Practice</span>';
  el('stat-queued').textContent = queued.length;
  el('stat-next').textContent = next ? `${fmtDay(next.scheduledFor)} ${fmtTime(next.scheduledFor)}` : '—';
}

// ---------- products ----------

function renderProducts() {
  const products = state.products.filter((p) => p.brandId === brandId);
  const target = el('product-list');

  if (products.length === 0) {
    target.innerHTML = '<div class="empty-state">No products yet. Add your first one below.</div>';
    return;
  }

  target.innerHTML = products.map((product) => {
    const image = product.images[0];
    const open = product.id === openProductId;
    return `
    <div class="product">
      ${image
        ? `<img class="thumb" src="${esc(imageSrc(image))}" alt="">`
        : '<div class="thumb empty">No<br>image</div>'}
      <div class="info">
        <b>${esc(product.title)}</b>
        <div class="meta">
          ${product.active ? '' : '<span class="pill warn">Paused</span> '}
          ${product.images.length} image${product.images.length === 1 ? '' : 's'}
          &middot; ${product.pinCount} pin${product.pinCount === 1 ? '' : 's'} sent
          ${product.boardId ? `&middot; ${esc(boardName(product.boardId) || 'board set')}` : '&middot; no board'}
        </div>
        <div class="btn-row" style="margin-top:8px">
          <button class="btn-sm" data-open="${product.id}">${open ? 'Close' : 'Open'}</button>
          <button class="btn-sm" data-edit="${product.id}">Edit</button>
          <button class="btn-sm" data-toggle-active="${product.id}">${product.active ? 'Pause' : 'Resume'}</button>
        </div>
        ${open ? productDetail(product) : ''}
      </div>
    </div>`;
  }).join('');

  target.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', () => {
      openProductId = openProductId === button.dataset.open ? null : button.dataset.open;
      renderProducts();
    });
  });
  target.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => startEdit(button.dataset.edit));
  });
  target.querySelectorAll('[data-toggle-active]').forEach((button) => {
    button.addEventListener('click', async () => {
      const product = state.products.find((p) => p.id === button.dataset.toggleActive);
      await api(`/products/${product.id}`, { method: 'PATCH', body: { active: !product.active } });
      await refresh();
    });
  });

  wireProductDetail(target);
}

function productDetail(product) {
  return `
  <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
    <div class="thumbs">
      ${product.images.map((image) => `
        <figure>
          <img src="${esc(imageSrc(image))}" alt="">
          <button data-del-image="${image.id}" data-product="${product.id}" title="Remove">&times;</button>
        </figure>`).join('') || '<span class="note">No images yet.</span>'}
    </div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn-sm" data-upload="${product.id}">Upload image</button>
      <button class="btn-sm" data-image-url="${product.id}">Paste image link</button>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button class="btn-sm" data-preview="${product.id}">Preview pin text</button>
      <button class="btn-sm" data-pin-now="${product.id}">Pin now</button>
      <button class="btn-sm btn-danger" data-delete="${product.id}">Delete</button>
    </div>
    <div class="note" id="preview-${product.id}"></div>
  </div>`;
}

function wireProductDetail(root) {
  root.querySelectorAll('[data-del-image]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/products/${button.dataset.product}/images/${button.dataset.delImage}`, { method: 'DELETE' });
      await refresh();
    });
  });

  root.querySelectorAll('[data-upload]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            await api(`/products/${button.dataset.upload}/images`, { method: 'POST', body: { dataUrl: reader.result } });
            toast('Image added.');
            await refresh();
          } catch (err) {
            toast(err.message, true);
          }
        };
        reader.readAsDataURL(file);
      });
      input.click();
    });
  });

  root.querySelectorAll('[data-image-url]').forEach((button) => {
    button.addEventListener('click', async () => {
      const url = prompt('Paste the image link (https://...)');
      if (!url) return;
      try {
        await api(`/products/${button.dataset.imageUrl}/images`, { method: 'POST', body: { url } });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  root.querySelectorAll('[data-preview]').forEach((button) => {
    button.addEventListener('click', async () => {
      const box = el(`preview-${button.dataset.preview}`);
      box.textContent = 'Writing…';
      try {
        const text = await api(`/products/${button.dataset.preview}/generate`, {
          method: 'POST',
          body: { variant: Math.floor(Math.random() * 8) },
        });
        box.innerHTML = `<b style="color:var(--text)">${esc(text.title)}</b><br>${esc(text.description)}
          <br><span class="pill mute">${text.source === 'ai' ? 'AI written' : 'Built-in writer'}</span>`;
      } catch (err) {
        box.textContent = err.message;
      }
    });
  });

  root.querySelectorAll('[data-pin-now]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const pin = await api(`/products/${button.dataset.pinNow}/pin-now`, { method: 'POST', body: {} });
        toast(pin.status === 'posted' ? 'Posted to Pinterest.' : `Practice pin created (${pin.status}).`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
  });

  root.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Delete this product? Pins already sent are kept.')) return;
      await api(`/products/${button.dataset.delete}`, { method: 'DELETE' });
      openProductId = null;
      await refresh();
    });
  });
}

// ---------- product form ----------

function renderProductForm() {
  el('url-label').textContent = brand().marketplace === 'amazon' ? 'Amazon link' : 'Etsy link';
  const select = el('product-board');
  const current = select.value;
  select.innerHTML = '<option value="">— choose a board —</option>' +
    boardsForBrand().map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  select.value = current;
}

function startEdit(id) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  el('product-form-title').textContent = 'Edit product';
  el('product-id').value = product.id;
  el('product-title').value = product.title;
  el('product-url').value = product.url;
  el('product-kind').value = product.kind || '';
  el('product-keywords').value = (product.keywords || []).join(', ');
  el('product-notes').value = product.notes || '';
  el('product-board').value = product.boardId || '';
  el('product-cancel').classList.remove('hidden');
  el('product-form').scrollIntoView({ behavior: 'smooth' });
}

function resetProductForm() {
  el('product-form-title').textContent = 'Add a product';
  el('product-form').reset();
  el('product-id').value = '';
  el('product-cancel').classList.add('hidden');
}

el('product-cancel').addEventListener('click', resetProductForm);

el('product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    brandId,
    title: el('product-title').value,
    url: el('product-url').value,
    kind: el('product-kind').value,
    keywords: el('product-keywords').value,
    notes: el('product-notes').value,
    boardId: el('product-board').value,
  };
  const id = el('product-id').value;
  try {
    if (id) {
      await api(`/products/${id}`, { method: 'PATCH', body });
      toast('Product updated.');
    } else {
      await api('/products', { method: 'POST', body });
      toast('Product added.');
    }
    resetProductForm();
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- queue ----------

function pinCard(pin, showActions) {
  const product = state.products.find((p) => p.id === pin.productId);
  const statusPill = {
    queued: '<span class="pill mute">Queued</span>',
    posted: '<span class="pill ok">Posted</span>',
    simulated: '<span class="pill warn">Practice</span>',
    failed: '<span class="pill bad">Failed</span>',
  }[pin.status] || '';

  return `
  <div class="pin">
    <div class="top">
      <b>${esc(pin.title)}</b>
      <span class="when">${fmtTime(pin.scheduledFor)}</span>
    </div>
    <div class="desc">${esc(preview(pin.description, 150))}</div>
    <div class="meta" style="margin-top:6px">
      ${statusPill}
      ${product ? `<span class="note"> ${esc(product.title)}</span>` : '<span class="note"> (product removed)</span>'}
      ${pin.pinterestUrl ? ` <a href="${esc(pin.pinterestUrl)}" target="_blank" rel="noopener">view</a>` : ''}
    </div>
    ${pin.error ? `<div class="err">${esc(pin.error)}</div>` : ''}
    ${showActions ? `<div class="btn-row" style="margin-top:8px">
        ${pin.status === 'failed' ? `<button class="btn-sm" data-retry="${pin.id}">Try again</button>` : ''}
        ${pin.status !== 'posted' ? `<button class="btn-sm btn-danger" data-drop="${pin.id}">Remove</button>` : ''}
      </div>` : ''}
  </div>`;
}

function renderQueue() {
  const mine = state.pins.filter((p) => p.brandId === brandId);
  const queued = mine.filter((p) => p.status === 'queued')
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  const history = mine.filter((p) => p.status !== 'queued')
    .sort((a, b) => Date.parse(b.postedAt || b.scheduledFor) - Date.parse(a.postedAt || a.scheduledFor))
    .slice(0, 25);

  const groups = new Map();
  for (const pin of queued) {
    const key = dayKey(pin.scheduledFor);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pin);
  }

  el('queue-list').innerHTML = queued.length === 0
    ? '<div class="empty-state">Nothing queued. Add a product with an image, then tap “Refill the queue”.</div>'
    : [...groups.entries()].map(([, pins]) => `
        <div class="day-head">${fmtDay(pins[0].scheduledFor)}</div>
        ${pins.map((pin) => pinCard(pin, true)).join('')}`).join('');

  el('history-list').innerHTML = history.length === 0
    ? '<div class="empty-state">Nothing has been sent yet.</div>'
    : history.map((pin) => pinCard(pin, true)).join('');

  document.querySelectorAll('[data-drop]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/pins/${button.dataset.drop}`, { method: 'DELETE' });
      await refresh();
    });
  });
  document.querySelectorAll('[data-retry]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/pins/${button.dataset.retry}/retry`, { method: 'POST', body: {} });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

el('plan-now').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try {
    const result = await api('/plan', { method: 'POST', body: {} });
    toast(result.created ? `Queued ${result.created} pin(s).` : 'Queue is already full.');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  } finally {
    event.target.disabled = false;
  }
});

// ---------- boards / pinterest ----------

function renderBoards() {
  const b = brand();
  const health = state.health;

  let status;
  if (b.pinterest.connected) {
    status = `<div class="row"><div class="label">Connected as @${esc(b.pinterest.username)}
      <small>${esc(b.name)}</small></div>
      <button class="btn-sm btn-danger" id="pin-disconnect">Disconnect</button></div>
      <div class="btn-row" style="margin-top:10px"><button id="board-refresh">Reload boards from Pinterest</button></div>`;
  } else if (!health.pinterestConfigured) {
    status = `<p class="note alert">Pinterest app credentials are not on the server yet.
      Until then PinBot runs in practice mode — everything else works normally.</p>`;
  } else if (!health.appUrlSet) {
    status = '<p class="note alert">Set APP_URL on the service so Pinterest knows where to send you back.</p>';
  } else {
    status = `<p class="note">Sign in to the Pinterest account for ${esc(b.name)}.</p>
      <a class="btn-primary" style="display:block;text-align:center;text-decoration:none;padding:12px"
         href="/oauth/pinterest/start/${b.id}">Connect ${esc(b.name)}</a>`;
  }
  el('pinterest-status').innerHTML = status;

  const disconnect = el('pin-disconnect');
  if (disconnect) {
    disconnect.addEventListener('click', async () => {
      if (!confirm('Remove the saved connection? Your Pinterest account itself is not touched.')) return;
      await fetch(`/oauth/pinterest/disconnect/${brandId}`, { method: 'POST' });
      await refresh();
    });
  }
  const reload = el('board-refresh');
  if (reload) {
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      try {
        const boards = await api(`/boards/${brandId}/refresh`, { method: 'POST', body: {} });
        toast(`Loaded ${boards.length} board(s).`);
        await refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        reload.disabled = false;
      }
    });
  }

  const boards = boardsForBrand();
  el('board-list').innerHTML = boards.length === 0
    ? '<div class="empty-state">No boards yet.</div>'
    : boards.map((board) => `
        <div class="row"><div class="label">${esc(board.name)}
        ${board.manual ? '<small>added by hand</small>' : ''}</div>
        <button class="btn-sm btn-danger" data-del-board="${esc(board.id)}">Remove</button></div>`).join('');

  el('board-list').querySelectorAll('[data-del-board]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/boards/${brandId}/${encodeURIComponent(button.dataset.delBoard)}`, { method: 'DELETE' });
      await refresh();
    });
  });
}

el('board-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api(`/boards/${brandId}/manual`, { method: 'POST', body: { name: el('board-name').value } });
    el('board-name').value = '';
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- settings ----------

function setToggle(node, on) {
  node.classList.toggle('on', Boolean(on));
}

function renderSettings() {
  const b = brand();
  setToggle(el('toggle-paused'), !state.settings.paused);
  setToggle(el('toggle-live'), state.settings.liveMode);
  setToggle(el('toggle-brand'), !b.paused);
  el('brand-pause-label').innerHTML = `${esc(b.name)}<small>Off pauses this brand only</small>`;

  el('slot-note').textContent = `${b.name} posts at these times (${tz()}).`;
  el('slot-list').innerHTML = b.slots.map((slot) => `
    <div class="row"><div class="label">${esc(slot)}</div>
    <button class="btn-sm btn-danger" data-del-slot="${esc(slot)}">Remove</button></div>`).join('')
    || '<div class="empty-state">No posting times set.</div>';

  el('slot-list').querySelectorAll('[data-del-slot]').forEach((button) => {
    button.addEventListener('click', async () => {
      const slots = b.slots.filter((s) => s !== button.dataset.delSlot);
      try {
        await api(`/brands/${brandId}`, { method: 'POST', body: { slots } });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  el('max-per-day').value = state.settings.maxPerDay;
  el('plan-ahead').value = state.settings.planAheadDays;
  el('timezone').value = state.settings.timezone;

  const h = state.health;
  el('health').innerHTML = `
    <div class="row"><div class="label">Pinterest app keys</div>${h.pinterestConfigured ? '<span class="pill ok">Set</span>' : '<span class="pill mute">Not yet</span>'}</div>
    <div class="row"><div class="label">AI copywriter</div>${h.aiConfigured ? '<span class="pill ok">On</span>' : '<span class="pill mute">Built-in writer</span>'}</div>
    <div class="row"><div class="label">Public address</div>${h.appUrlSet ? '<span class="pill ok">Set</span>' : '<span class="pill mute">Not yet</span>'}</div>
    ${h.redirectUri ? `<p class="note" style="margin-top:10px">Pinterest redirect URI:<br><code>${esc(h.redirectUri)}</code></p>` : ''}`;
}

el('toggle-paused').addEventListener('click', async () => {
  await api('/settings', { method: 'POST', body: { paused: !state.settings.paused } });
  await refresh();
});

el('toggle-live').addEventListener('click', async () => {
  try {
    await api('/settings', { method: 'POST', body: { liveMode: !state.settings.liveMode } });
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

el('toggle-brand').addEventListener('click', async () => {
  await api(`/brands/${brandId}`, { method: 'POST', body: { paused: !brand().paused } });
  await refresh();
});

el('slot-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const slots = [...new Set([...brand().slots, el('slot-input').value])];
  try {
    await api(`/brands/${brandId}`, { method: 'POST', body: { slots } });
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

el('save-limits').addEventListener('click', async () => {
  try {
    await api('/settings', {
      method: 'POST',
      body: {
        maxPerDay: el('max-per-day').value,
        planAheadDays: el('plan-ahead').value,
        timezone: el('timezone').value,
      },
    });
    toast('Saved.');
    await refresh();
  } catch (err) {
    toast(err.message, true);
  }
});

// ---------- activity ----------

function renderLogs() {
  el('log-list').innerHTML = state.logs.map((entry) => `
    <div class="${esc(entry.level)}">${fmtTime(entry.t)} ${esc(entry.message)}</div>`).join('')
    || '<div class="empty-state">Nothing has happened yet.</div>';
}

// ---------- tabs ----------

document.querySelectorAll('nav.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    document.querySelectorAll('nav.tabs button').forEach((other) => {
      other.classList.toggle('active', other.dataset.tab === activeTab);
    });
    document.querySelectorAll('main .tab').forEach((section) => {
      section.classList.toggle('hidden', section.id !== `tab-${activeTab}`);
    });
    window.scrollTo({ top: 0 });
  });
});
document.querySelector('nav.tabs button').classList.add('active');

boot();
