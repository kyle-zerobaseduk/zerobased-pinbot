const axios = require('axios');

class Writer {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://api.anthropic.com/v1';
    this.angles = [
      'Focus on how this solves financial stress and gives peace of mind',
      'Emphasize the time savings and productivity boost',
      'Highlight the UK-specific aspect and local relevance',
      'Focus on budget transparency and taking control of money',
      'Emphasize long-term financial goals and wealth building',
      'Focus on sustainability and responsible spending habits',
      'Highlight the simplicity and ease of use',
      'Emphasize breaking bad financial habits and starting fresh',
      'Focus on family financial planning and security',
      'Highlight the professional design and visual appeal'
    ];
  }

  async generatePinDescription(productName, keywords, angleIndex = 0) {
    try {
      const angle = this.angles[angleIndex % this.angles.length];
      
      const prompt = `You are a Pinterest expert copywriter for UK personal finance products. Create a compelling Pinterest pin description for this product:

Product: ${productName}
Keywords: ${keywords.join(', ')}
Angle: ${angle}

Guidelines:
- 2-3 sentences maximum
- Include 2-3 relevant hashtags
- Use action-oriented language
- Make it click-worthy and shareable
- Include a subtle call-to-action
- Keep it professional but friendly

Return ONLY the pin description, nothing else.`;

      const response = await axios.post(`${this.baseURL}/messages`, {
        model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      }, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      });

      const description = response.data.content[0].text.trim();
      return description;
    } catch (err) {
      console.error('Writer error:', err.message);
      // Fallback description if API fails
      return `Discover ${productName}. Perfect for UK budgeting. Take control of your finances today! 💰 #PersonalFinance #BudgetPlanning #MoneyTips`;
    }
  }
}

module.exports = Writer;
