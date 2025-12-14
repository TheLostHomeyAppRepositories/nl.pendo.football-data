'use strict';

const {
  API_BASE_URL,
  RATE_LIMIT,
  RATE_LIMIT_BUFFER,
  FREE_TIER_COMPETITIONS,
} = require('./constants');

class FootballAPI {
  constructor(apiKey, homey) {
    this.apiKey = apiKey;
    this.homey = homey;
    this.requestTimestamps = [];
    this.teamCache = null;
    this.teamCacheExpiry = null;
  }

  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Check if we can make a request without exceeding rate limit
   * @param {boolean} highPriority - High priority requests can use the buffer
   */
  canMakeRequest(highPriority = false) {
    this.cleanExpiredTimestamps();
    const limit = highPriority ? RATE_LIMIT : RATE_LIMIT - RATE_LIMIT_BUFFER;
    return this.requestTimestamps.length < limit;
  }

  /**
   * Remove timestamps older than 60 seconds
   */
  cleanExpiredTimestamps() {
    const oneMinuteAgo = Date.now() - 60000;
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);
  }

  /**
   * Make API request with rate limiting
   */
  async request(path, options = {}, highPriority = false) {
    if (!this.apiKey) {
      throw new Error('API key not configured');
    }

    // Wait for rate limit if needed
    while (!this.canMakeRequest(highPriority)) {
      const oldestTimestamp = this.requestTimestamps[0];
      const waitTime = oldestTimestamp + 60000 - Date.now() + 100;
      if (waitTime > 0) {
        this.homey.log(`Rate limit reached, waiting ${waitTime}ms`);
        await this.sleep(waitTime);
      }
      this.cleanExpiredTimestamps();
    }

    // Record this request
    this.requestTimestamps.push(Date.now());

    const url = `${API_BASE_URL}${path}`;
    this.homey.log(`API Request: ${url}`);

    try {
      const response = await fetch(url, {
        headers: {
          'X-Auth-Token': this.apiKey,
          'Content-Type': 'application/json',
        },
        ...options,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (response.status === 403) {
          throw new Error('Invalid API key or access denied');
        }
        throw new Error(`API error ${response.status}: ${errorBody}`);
      }

      return await response.json();
    } catch (error) {
      this.homey.error(`API Error: ${error.message}`);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test API connection
   */
  async testConnection() {
    const response = await this.request('/competitions');
    return {
      success: true,
      count: response.count,
    };
  }

  /**
   * Get all available competitions
   */
  async getCompetitions() {
    const response = await this.request('/competitions');
    const competitions = (response.competitions || []).map(comp => ({
      id: comp.id,
      code: comp.code,
      name: comp.name,
      area: comp.area?.name || '',
      emblem: comp.emblem,
    }));

    // Sort by name
    competitions.sort((a, b) => a.name.localeCompare(b.name));

    return competitions;
  }

  /**
   * Get matches with optional filters
   * @param {Object} filters - { date, status, competitions }
   */
  async getMatches(filters = {}) {
    const params = new URLSearchParams();
    if (filters.date) params.append('date', filters.date);
    if (filters.status) params.append('status', filters.status);
    if (filters.competitions) params.append('competitions', filters.competitions);
    if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.append('dateTo', filters.dateTo);

    const query = params.toString();
    const path = `/matches${query ? `?${query}` : ''}`;
    const response = await this.request(path, {}, filters.highPriority);
    return response.matches || [];
  }

  /**
   * Get matches for today (commonly used for live updates)
   */
  async getTodayMatches(highPriority = false) {
    const today = new Date().toISOString().split('T')[0];
    return this.getMatches({ date: today, highPriority });
  }

  /**
   * Get matches for a specific team
   */
  async getTeamMatches(teamId, filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.append('dateTo', filters.dateTo);
    if (filters.limit) params.append('limit', filters.limit);

    const query = params.toString();
    const path = `/teams/${teamId}/matches${query ? `?${query}` : ''}`;
    const response = await this.request(path);
    return response.matches || [];
  }

  /**
   * Get live matches for a specific team (IN_PLAY or PAUSED)
   */
  async getTeamLiveMatches(teamId) {
    return this.getTeamMatches(teamId, {
      status: 'IN_PLAY,PAUSED',
      limit: 1,
    });
  }

  /**
   * Get team details
   */
  async getTeam(teamId) {
    const response = await this.request(`/teams/${teamId}`);
    return response;
  }

  /**
   * Get teams for a competition
   */
  async getCompetitionTeams(competitionCode) {
    const response = await this.request(`/competitions/${competitionCode}/teams`);
    return {
      competition: response.competition,
      teams: response.teams || [],
    };
  }

  /**
   * Load and cache teams from all free tier competitions
   */
  async loadTeamCache() {
    // Check if cache is still valid (24 hours)
    if (this.teamCache && this.teamCacheExpiry && Date.now() < this.teamCacheExpiry) {
      return this.teamCache;
    }

    // If cache is currently loading, wait for it
    if (this.cacheLoadingPromise) {
      return this.cacheLoadingPromise;
    }

    this.cacheLoadingPromise = this.doLoadTeamCache();
    try {
      const result = await this.cacheLoadingPromise;
      return result;
    } finally {
      this.cacheLoadingPromise = null;
    }
  }

  async doLoadTeamCache() {
    this.homey.log('Loading team cache from all competitions...');
    this.teamCache = {};

    for (const competition of FREE_TIER_COMPETITIONS) {
      try {
        // Add delay between requests to respect rate limit (10 req/min = 6 sec between)
        if (Object.keys(this.teamCache).length > 0) {
          this.homey.log('Waiting 7 seconds before next API call...');
          await this.sleep(7000);
        }

        const response = await this.getCompetitionTeams(competition.code);
        for (const team of response.teams) {
          this.teamCache[team.id] = {
            id: team.id,
            name: team.name,
            shortName: team.shortName,
            tla: team.tla,
            crest: team.crest,
            competition: competition.name,
            competitionCode: competition.code,
          };
        }
        this.homey.log(`Loaded ${response.teams.length} teams from ${competition.name}`);
      } catch (error) {
        this.homey.error(`Failed to load teams for ${competition.code}: ${error.message}`);
        // If rate limited, stop loading more and use what we have
        if (error.message.includes('Rate limit')) {
          this.homey.log('Rate limited - using partial cache');
          break;
        }
      }
    }

    // Cache for 24 hours
    this.teamCacheExpiry = Date.now() + 24 * 60 * 60 * 1000;
    this.homey.log(`Team cache loaded: ${Object.keys(this.teamCache).length} teams`);
    return this.teamCache;
  }

  /**
   * Search teams by query - tries direct API first, falls back to cache
   */
  async searchTeams(query) {
    this.homey.log(`[FootballAPI] searchTeams called with: "${query}"`);

    if (!query || query.length < 2) {
      this.homey.log('[FootballAPI] Query too short, returning empty');
      return [];
    }

    // Try direct API search first (single request)
    try {
      this.homey.log('[FootballAPI] Trying direct /teams endpoint...');
      const response = await this.request(`/teams`);

      if (response.teams && response.teams.length > 0) {
        this.homey.log(`[FootballAPI] API returned ${response.teams.length} teams, filtering for "${query}"...`);

        const queryLower = query.toLowerCase();

        // Filter teams that match the query
        const filtered = response.teams.filter(team =>
          team.name.toLowerCase().includes(queryLower) ||
          (team.shortName && team.shortName.toLowerCase().includes(queryLower)) ||
          (team.tla && team.tla.toLowerCase() === queryLower)
        );

        this.homey.log(`[FootballAPI] Filtered to ${filtered.length} matching teams`);

        if (filtered.length > 0) {
          // Sort by relevance
          filtered.sort((a, b) => {
            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aExact = aName === queryLower;
            const bExact = bName === queryLower;
            const aStarts = aName.startsWith(queryLower);
            const bStarts = bName.startsWith(queryLower);

            if (aExact && !bExact) return -1;
            if (bExact && !aExact) return 1;
            if (aStarts && !bStarts) return -1;
            if (bStarts && !aStarts) return 1;
            return aName.localeCompare(bName);
          });

          const results = filtered.slice(0, 20).map(team => ({
            id: team.id,
            name: team.name,
            shortName: team.shortName,
            tla: team.tla,
            crest: team.crest,
            competition: team.runningCompetitions?.[0]?.name || '',
            competitionCode: team.runningCompetitions?.[0]?.code || '',
          }));

          this.homey.log(`[FootballAPI] Returning ${results.length} results, first: ${results[0]?.name}`);
          return results;
        }
      }
    } catch (error) {
      this.homey.log(`[FootballAPI] Direct search failed: ${error.message}, falling back to cache`);
    }

    // Fallback to cache-based search
    this.homey.log('[FootballAPI] Using cache-based search...');
    const cache = await this.loadTeamCache();
    this.homey.log(`[FootballAPI] Cache has ${Object.keys(cache).length} teams`);

    const queryLower = query.toLowerCase();
    const results = [];

    for (const team of Object.values(cache)) {
      if (
        team.name.toLowerCase().includes(queryLower) ||
        (team.shortName && team.shortName.toLowerCase().includes(queryLower)) ||
        (team.tla && team.tla.toLowerCase().includes(queryLower))
      ) {
        results.push(team);
      }
    }

    // Sort by relevance (exact match first, then starts with, then contains)
    results.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();
      const aExact = aName === queryLower;
      const bExact = bName === queryLower;
      const aStarts = aName.startsWith(queryLower);
      const bStarts = bName.startsWith(queryLower);

      if (aExact && !bExact) return -1;
      if (bExact && !aExact) return 1;
      if (aStarts && !bStarts) return -1;
      if (bStarts && !aStarts) return 1;
      return aName.localeCompare(bName);
    });

    const finalResults = results.slice(0, 20);
    this.homey.log(`[FootballAPI] Returning ${finalResults.length} results from cache`);
    return finalResults;
  }

  /**
   * Get team from cache by ID
   */
  async getTeamFromCache(teamId) {
    const cache = await this.loadTeamCache();
    return cache[teamId] || null;
  }
}

module.exports = FootballAPI;
