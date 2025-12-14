'use strict';

module.exports = {
  async getTest({ homey }) {
    try {
      const result = await homey.app.api.testConnection();
      return result;
    } catch (error) {
      throw new Error(error.message);
    }
  },

  async getSearch({ homey, query }) {
    try {
      const searchQuery = query.query || '';
      homey.log(`[API] Search request: "${searchQuery}"`);
      const results = await homey.app.api.searchTeams(searchQuery);
      return results;
    } catch (error) {
      homey.error(`[API] Search error: ${error.message}`);
      throw new Error(error.message);
    }
  },
};
