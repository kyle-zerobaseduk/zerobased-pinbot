const axios = require('axios');

class PinterestAPI {
  constructor(accessToken) {
    this.token = accessToken;
    this.baseURL = 'https://api.pinterest.com/v5';
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
  }

  async getBoards() {
    try {
      const response = await this.client.get('/boards', {
        params: {
          fields: 'id,name,description,image'
        }
      });
      
      return response.data.items.map(board => ({
        id: board.id,
        name: board.name,
        description: board.description || '',
        image: board.image ? board.image.uri : null
      }));
    } catch (err) {
      throw new Error(`Failed to fetch boards: ${err.response?.data?.message || err.message}`);
    }
  }

  async createPin(options) {
    try {
      const { board_id, description, link, media_source } = options;
      
      const payload = {
        board_id,
        title: description.substring(0, 100),
        description,
        media_source: {
          source_type: 'image_url',
          url: media_source
        }
      };

      if (link) {
        payload.link = link;
      }

      const response = await this.client.post('/pins', payload);
      
      return {
        id: response.data.id,
        url: response.data.link,
        created_at: new Date()
      };
    } catch (err) {
      throw new Error(`Failed to create pin: ${err.response?.data?.message || err.message}`);
    }
  }

  async updatePin(pinId, options) {
    try {
      const { description, link } = options;
      
      const payload = {};
      if (description) payload.description = description;
      if (link) payload.link = link;

      const response = await this.client.patch(`/pins/${pinId}`, payload);
      return response.data;
    } catch (err) {
      throw new Error(`Failed to update pin: ${err.response?.data?.message || err.message}`);
    }
  }

  async deletePin(pinId) {
    try {
      await this.client.delete(`/pins/${pinId}`);
      return true;
    } catch (err) {
      throw new Error(`Failed to delete pin: ${err.response?.data?.message || err.message}`);
    }
  }
}

module.exports = PinterestAPI;
