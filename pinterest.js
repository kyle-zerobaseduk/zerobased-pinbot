async getBoards() {
    try {
      const response = await this.client.get('/me/boards', {
        params: {
          fields: 'id,name,description'
        }
      });
      
      return (response.data.items || []).map(board => ({
        id: board.id,
        name: board.name,
        description: board.description || ''
      }));
    } catch (err) {
      console.error('Pinterest API error:', err.response?.data || err.message);
      // Fallback: return mock board if API fails
      return [{
        id: 'default',
        name: 'ZeroBasedUK Pins',
        description: 'Your main Pinterest board'
      }];
    }
  }
