'use strict';

const Homey = require('homey');
const FootballAPI = require('./lib/FootballAPI');
const MatchManager = require('./lib/MatchManager');

class FootballDataApp extends Homey.App {
  async onInit() {
    this.log('Football Data app starting...');

    // Initialize API client
    const apiKey = this.homey.settings.get('apiKey');
    this.api = new FootballAPI(apiKey, this.homey);

    // Initialize MatchManager (shared by all devices)
    this.matchManager = new MatchManager(this.api, this.homey);

    // Listen for API key changes in settings
    this.homey.settings.on('set', (key) => {
      if (key === 'apiKey') {
        const newApiKey = this.homey.settings.get('apiKey');
        this.log('API key updated');
        this.api.setApiKey(newApiKey);
      }
    });

    this.log('Football Data app initialized');
  }

  async onUninit() {
    // Stop polling when app is unloaded
    if (this.matchManager) {
      this.matchManager.stopPolling();
    }
    this.log('Football Data app stopped');
  }
}

module.exports = FootballDataApp;
