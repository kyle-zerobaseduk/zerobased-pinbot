class Pinterest {
    constructor(token) {
        this.token = token;
        this.baseUrl = 'https://api.pinterest.com/v5';
    }

    async getBoards() {
        try {
            const response = await fetch(`${this.baseUrl}/me/boards`, {
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Pinterest API error: ${response.status}`);
            }

            const data = await response.json();
            return data.items || [];
        } catch (err) {
            console.error('Error fetching boards:', err);
            throw err;
        }
    }

    async createPin(pinData) {
        try {
            const body = {
                title: pinData.title,
                description: pinData.description,
                image_url: pinData.imageUrl,
                link: pinData.link,
                board_id: pinData.boardId || 'default'
            };

            const response = await fetch(`${this.baseUrl}/pins`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                throw new Error(`Failed to create pin: ${response.status}`);
            }

            const data = await response.json();
            return data;
        } catch (err) {
            console.error('Error creating pin:', err);
            throw err;
        }
    }
}

module.exports = Pinterest;
