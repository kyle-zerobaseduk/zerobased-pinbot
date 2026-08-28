const axios = require('axios');

class Writer {
  constructor(apiKey = '') {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.anthropic.com/v1';
  }

  fallback(product, brand) {
    const keywords = Array.isArray(product.keywords) ? product.keywords : [];
    const tags = keywords.slice(0, 3).map(k => `#${String(k).replace(/[^a-z0-9]/gi, '')}`).filter(Boolean);
    const destination = brand.destination === 'Amazon' ? 'Amazon' : 'Etsy';
    return `${product.name} — discover it on ${destination}. ${tags.join(' ')}`.trim();
  }

  async generateDescription(product, brand) {
    if (Array.isArray(product.descriptions) && product.descriptions.length) {
      return product.descriptions[Math.floor(Math.random() * product.descriptions.length)];
    }

    if (!this.apiKey) return this.fallback(product, brand);

    const keywords = Array.isArray(product.keywords) ? product.keywords.join(', ') : String(product.keywords || '');
    const businessContext = brand.id === 'kd-publishing'
      ? 'K.D.Publishing sells low-content books, journals and puzzle books on Amazon.'
      : 'ZeroBased UK sells UK budgeting and printable digital products on Etsy.';

    const prompt = `Write one Pinterest description for ${brand.name}.\n\n${businessContext}\nProduct: ${product.name}\nKeywords: ${keywords}\nDestination: ${brand.destination}\n\nRules:\n- Natural UK English\n- Maximum 3 short sentences\n- Useful, specific and not spammy\n- Include a gentle call to action\n- Add 2 or 3 relevant hashtags\n- Do not invent product features\n- Return only the description.`;

    try {
      const response = await axios.post(`${this.baseURL}/messages`, {
        model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 180,
        messages: [{ role: 'user', content: prompt }]
      }, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        timeout: 20000
      });

      return response.data.content?.[0]?.text?.trim() || this.fallback(product, brand);
    } catch (err) {
      console.error('Writer error:', err.response?.data || err.message);
      return this.fallback(product, brand);
    }
  }
}

module.exports = Writer;
