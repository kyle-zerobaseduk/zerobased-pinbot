const axios = require('axios');

class Pinterest {
  constructor(accessToken = '') {
    this.accessToken = accessToken;
    this.client = axios.create({
      baseURL: 'https://api.pinterest.com/v5',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  isConfigured() {
    return Boolean(this.accessToken);
  }

  authHeaders() {
    if (!this.accessToken) {
      throw new Error('Pinterest access token is not configured');
    }
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async getBoards() {
    const response = await this.client.get('/boards', {
      headers: this.authHeaders(),
      params: { page_size: 100 }
    });

    return (response.data.items || []).map(board => ({
      id: board.id,
      name: board.name,
      description: board.description || '',
      privacy: board.privacy || 'PUBLIC'
    }));
  }

  async createPin({ title, description, imageUrl, link, boardId }) {
    if (!boardId) throw new Error('Pinterest board ID is required');
    if (!imageUrl) throw new Error('Pin image URL is required');

    const payload = {
      board_id: String(boardId),
      title: String(title || '').slice(0, 100),
      description: String(description || '').slice(0, 800),
      link,
      media_source: {
        source_type: 'image_url',
        url: imageUrl
      }
    };

    const response = await this.client.post('/pins', payload, {
      headers: this.authHeaders()
    });

    return response.data;
  }

  async getPin(pinId) {
    const response = await this.client.get(`/pins/${pinId}`, {
      headers: this.authHeaders()
    });
    return response.data;
  }
}

module.exports = Pinterest;
