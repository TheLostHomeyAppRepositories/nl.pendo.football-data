'use strict';

const { EventEmitter } = require('events');
const {
  MATCH_STATUS,
  LIVE_STATUSES,
  UPCOMING_STATUSES,
  COMPLETED_STATUSES,
  POLLING_INTERVALS,
  POLLING_STATE,
  MATCH_SOON_THRESHOLDS,
  EVENTS,
} = require('./constants');

class MatchManager extends EventEmitter {
  constructor(api, homey) {
    super();
    this.api = api;
    this.homey = homey;

    // Map of teamId -> Set of device instances
    this.trackedTeams = new Map();

    // Cache of match states: matchId -> { status, homeScore, awayScore, events }
    this.matchCache = new Map();

    // Current polling state
    this.pollingState = POLLING_STATE.IDLE;
    this.pollTimer = null;

    // Track which "match starts soon" thresholds have been triggered per match
    this.matchStartsSoonTriggered = new Map(); // matchId -> Set of minutes
  }

  /**
   * Register a device to track a team
   */
  registerDevice(teamId, device) {
    if (!this.trackedTeams.has(teamId)) {
      this.trackedTeams.set(teamId, new Set());
    }
    this.trackedTeams.get(teamId).add(device);
    this.homey.log(`Registered device for team ${teamId}, now tracking ${this.trackedTeams.size} teams`);

    // Start polling if this is the first device
    if (this.trackedTeams.size === 1 && !this.pollTimer) {
      this.startPolling();
    }
  }

  /**
   * Unregister a device
   */
  unregisterDevice(teamId, device) {
    const devices = this.trackedTeams.get(teamId);
    if (devices) {
      devices.delete(device);
      if (devices.size === 0) {
        this.trackedTeams.delete(teamId);
      }
    }
    this.homey.log(`Unregistered device for team ${teamId}, now tracking ${this.trackedTeams.size} teams`);

    // Stop polling if no more devices
    if (this.trackedTeams.size === 0) {
      this.stopPolling();
    }
  }

  /**
   * Get all tracked team IDs
   */
  getTrackedTeamIds() {
    return Array.from(this.trackedTeams.keys());
  }

  /**
   * Start polling
   */
  startPolling() {
    if (this.pollTimer) return;
    this.homey.log('Starting match polling');
    this.poll();
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.homey.log('Stopped match polling');
  }

  /**
   * Get polling interval for current state
   */
  getPollingInterval() {
    return POLLING_INTERVALS[this.pollingState] || POLLING_INTERVALS.IDLE;
  }

  /**
   * Determine polling state based on match data
   */
  determinePollingState(matches) {
    const now = new Date();

    // Check for live matches (IN_PLAY)
    const hasLiveMatch = matches.some(m => m.status === MATCH_STATUS.IN_PLAY);
    if (hasLiveMatch) return POLLING_STATE.LIVE;

    // Check for paused matches (halftime)
    const hasPausedMatch = matches.some(m => m.status === MATCH_STATUS.PAUSED);
    if (hasPausedMatch) return POLLING_STATE.PAUSED;

    // Check for matches that SHOULD be live (kickoff passed but API delayed)
    // If kickoff was within last 2 hours and status is still TIMED/SCHEDULED, treat as live
    const hasProbablyLive = matches.some(m => {
      if (!UPCOMING_STATUSES.includes(m.status)) return false;
      const matchDate = new Date(m.utcDate);
      const minutesSinceKickoff = (now - matchDate) / 1000 / 60;
      // Kickoff passed (0-120 min ago) but status not updated yet
      return minutesSinceKickoff > 0 && minutesSinceKickoff < 120;
    });
    if (hasProbablyLive) {
      this.homey.log('[Poll] Match probably live (API delayed), using LIVE polling');
      return POLLING_STATE.LIVE;
    }

    // Check for recently finished matches (within 15 min of end)
    const hasRecentlyFinished = matches.some(m => {
      if (!COMPLETED_STATUSES.includes(m.status)) return false;
      const matchDate = new Date(m.utcDate);
      // Assume match duration ~2 hours
      const estimatedEnd = new Date(matchDate.getTime() + 2 * 60 * 60 * 1000);
      const minutesSinceEnd = (now - estimatedEnd) / 1000 / 60;
      return minutesSinceEnd >= 0 && minutesSinceEnd < 15;
    });
    if (hasRecentlyFinished) return POLLING_STATE.POST_MATCH;

    // Check for upcoming matches within 2 hours
    const hasUpcoming = matches.some(m => {
      if (!UPCOMING_STATUSES.includes(m.status)) return false;
      const matchDate = new Date(m.utcDate);
      const hoursUntil = (matchDate - now) / 1000 / 60 / 60;
      return hoursUntil <= 2 && hoursUntil > 0;
    });
    if (hasUpcoming) return POLLING_STATE.PRE_MATCH;

    return POLLING_STATE.IDLE;
  }

  /**
   * Main polling function
   */
  async poll() {
    try {
      const trackedTeamIds = this.getTrackedTeamIds();
      this.homey.log(`[Poll] Starting poll for ${trackedTeamIds.length} tracked teams: ${trackedTeamIds.join(', ')}`);

      if (trackedTeamIds.length === 0) {
        this.homey.log('[Poll] No teams to track, skipping poll');
        this.scheduleNextPoll();
        return;
      }

      // Fetch today's matches (efficient: one request for all)
      const allMatches = await this.api.getTodayMatches(
        this.pollingState === POLLING_STATE.LIVE
      );
      this.homey.log(`[Poll] Fetched ${allMatches.length} matches for today`);

      // Filter to only tracked teams (convert to numbers for comparison since API returns numbers)
      const trackedTeamIdsNumeric = trackedTeamIds.map(id => Number(id));
      const relevantMatches = allMatches.filter(match =>
        trackedTeamIdsNumeric.includes(match.homeTeam.id) ||
        trackedTeamIdsNumeric.includes(match.awayTeam.id)
      );

      this.homey.log(`[Poll] Found ${relevantMatches.length} relevant matches for tracked teams`);
      for (const match of relevantMatches) {
        this.homey.log(`[Poll]   - ${match.homeTeam.name} vs ${match.awayTeam.name} (${match.status}) ${match.score?.fullTime?.home ?? 0}-${match.score?.fullTime?.away ?? 0}`);
      }

      // Process match updates and detect events
      this.processMatchUpdates(relevantMatches);

      // Check for "match starts soon" triggers
      this.checkMatchStartsSoon(relevantMatches);

      // Clean up old match cache entries and triggered thresholds
      this.cleanupOldMatches(relevantMatches);

      // Update polling state
      const newState = this.determinePollingState(relevantMatches);
      if (newState !== this.pollingState) {
        this.homey.log(`Polling state changed: ${this.pollingState} -> ${newState}`);
        this.pollingState = newState;
      }

      // Schedule next poll
      this.scheduleNextPoll();

    } catch (error) {
      this.homey.error('Polling error:', error.message);
      // On error, retry after 1 minute
      this.pollTimer = this.homey.setTimeout(() => this.poll(), 60000);
    }
  }

  /**
   * Schedule the next poll based on current state
   */
  scheduleNextPoll() {
    if (this.pollTimer) {
      this.homey.clearTimeout(this.pollTimer);
    }
    const interval = this.getPollingInterval();
    this.homey.log(`Next poll in ${interval / 1000}s (state: ${this.pollingState})`);
    this.pollTimer = this.homey.setTimeout(() => this.poll(), interval);
  }

  /**
   * Process match updates and detect events
   */
  processMatchUpdates(matches) {
    for (const match of matches) {
      const cached = this.matchCache.get(match.id);

      if (!cached) {
        // New match - initialize cache
        const newState = this.createMatchState(match);
        this.matchCache.set(match.id, newState);

        // For newly discovered matches that are already IN_PLAY, emit kickoff event
        if (match.status === MATCH_STATUS.IN_PLAY) {
          this.homey.log(`New match discovered already live: ${match.homeTeam.name} vs ${match.awayTeam.name}`);
          const homeTeamId = match.homeTeam.id;
          const awayTeamId = match.awayTeam.id;
          this.emitForTeams([homeTeamId, awayTeamId], EVENTS.MATCH_KICKOFF, { match });
          newState.events.kickoffTriggered = true;
        }

        // For newly discovered matches that are PAUSED (halftime), emit halftime event
        if (match.status === MATCH_STATUS.PAUSED) {
          this.homey.log(`New match discovered at halftime: ${match.homeTeam.name} vs ${match.awayTeam.name}`);
          const homeTeamId = match.homeTeam.id;
          const awayTeamId = match.awayTeam.id;
          this.emitForTeams([homeTeamId, awayTeamId], EVENTS.HALFTIME_STARTED, { match });
          newState.events.halftimeTriggered = true;
        }

        // For newly discovered matches that are already finished, emit result events
        if (match.status === MATCH_STATUS.FINISHED || match.status === MATCH_STATUS.AWARDED) {
          this.homey.log(`New match discovered already finished: ${match.homeTeam.name} vs ${match.awayTeam.name}`);
          const homeTeamId = match.homeTeam.id;
          const awayTeamId = match.awayTeam.id;
          this.emitForTeams([homeTeamId, awayTeamId], EVENTS.MATCH_FINISHED, { match });
          this.emitMatchResult(match);
          newState.events.finishedTriggered = true;
        }
        continue;
      }

      // Detect status changes
      if (cached.status !== match.status) {
        this.handleStatusChange(match, cached);
      }

      // Detect score changes (only during live matches)
      if (LIVE_STATUSES.includes(match.status)) {
        const currentHome = match.score?.fullTime?.home ?? 0;
        const currentAway = match.score?.fullTime?.away ?? 0;

        if (currentHome !== cached.homeScore || currentAway !== cached.awayScore) {
          this.handleScoreChange(match, cached, currentHome, currentAway);
        }
      }

      // Update cache
      this.matchCache.set(match.id, this.createMatchState(match, cached.events));
    }
  }

  /**
   * Create a match state object for caching
   */
  createMatchState(match, existingEvents = null) {
    return {
      id: match.id,
      status: match.status,
      utcDate: match.utcDate,
      homeScore: match.score?.fullTime?.home ?? 0,
      awayScore: match.score?.fullTime?.away ?? 0,
      homeTeamId: match.homeTeam.id,
      awayTeamId: match.awayTeam.id,
      homeTeamName: match.homeTeam.name,
      awayTeamName: match.awayTeam.name,
      homeTeamShortName: match.homeTeam.shortName || match.homeTeam.name,
      awayTeamShortName: match.awayTeam.shortName || match.awayTeam.name,
      minute: match.minute || 0,
      competition: match.competition?.name || '',
      events: existingEvents || {
        kickoffTriggered: false,
        halftimeTriggered: false,
        secondHalfTriggered: false,
        extraTimeTriggered: false,
        finishedTriggered: false,
      },
    };
  }

  /**
   * Handle match status changes
   */
  handleStatusChange(match, cached) {
    const homeTeamId = match.homeTeam.id;
    const awayTeamId = match.awayTeam.id;

    switch (match.status) {
      case MATCH_STATUS.IN_PLAY:
        if (UPCOMING_STATUSES.includes(cached.status)) {
          // Match just kicked off
          if (!cached.events.kickoffTriggered) {
            this.emitForTeams([homeTeamId, awayTeamId], EVENTS.MATCH_KICKOFF, { match });
            cached.events.kickoffTriggered = true;
          }
        } else if (cached.status === MATCH_STATUS.PAUSED) {
          // Second half started
          if (!cached.events.secondHalfTriggered) {
            this.emitForTeams([homeTeamId, awayTeamId], EVENTS.SECOND_HALF_STARTED, { match });
            cached.events.secondHalfTriggered = true;
          }
        }
        break;

      case MATCH_STATUS.PAUSED:
        // Halftime
        if (!cached.events.halftimeTriggered) {
          this.emitForTeams([homeTeamId, awayTeamId], EVENTS.HALFTIME_STARTED, { match });
          cached.events.halftimeTriggered = true;
        }
        break;

      case MATCH_STATUS.FINISHED:
      case MATCH_STATUS.AWARDED:
        if (!cached.events.finishedTriggered) {
          this.emitForTeams([homeTeamId, awayTeamId], EVENTS.MATCH_FINISHED, { match });
          this.emitMatchResult(match);
          cached.events.finishedTriggered = true;
        }
        break;
    }
  }

  /**
   * Emit win/loss/draw events based on final score
   */
  emitMatchResult(match) {
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const homeTeamId = match.homeTeam.id;
    const awayTeamId = match.awayTeam.id;

    if (homeScore > awayScore) {
      // Home team won
      this.emitForTeam(homeTeamId, EVENTS.TEAM_WON, { match });
      this.emitForTeam(awayTeamId, EVENTS.TEAM_LOST, { match });
    } else if (awayScore > homeScore) {
      // Away team won
      this.emitForTeam(awayTeamId, EVENTS.TEAM_WON, { match });
      this.emitForTeam(homeTeamId, EVENTS.TEAM_LOST, { match });
    } else {
      // Draw
      this.emitForTeams([homeTeamId, awayTeamId], EVENTS.TEAM_DREW, { match });
    }
  }

  /**
   * Handle score changes (goals)
   */
  handleScoreChange(match, cached, newHome, newAway) {
    const homeTeamId = match.homeTeam.id;
    const awayTeamId = match.awayTeam.id;

    // Calculate old and new result states
    const oldHomeState = this.getResultState(cached.homeScore, cached.awayScore);
    const oldAwayState = this.getResultState(cached.awayScore, cached.homeScore);
    const newHomeState = this.getResultState(newHome, newAway);
    const newAwayState = this.getResultState(newAway, newHome);

    // Determine who scored
    if (newHome > cached.homeScore) {
      // Home team scored
      this.emitForTeam(homeTeamId, EVENTS.TEAM_SCORED, {
        match,
        newScore: { home: newHome, away: newAway },
      });
      this.emitForTeam(awayTeamId, EVENTS.TEAM_CONCEDED, {
        match,
        scoringTeam: match.homeTeam,
        newScore: { home: newHome, away: newAway },
      });
    }

    if (newAway > cached.awayScore) {
      // Away team scored
      this.emitForTeam(awayTeamId, EVENTS.TEAM_SCORED, {
        match,
        newScore: { home: newHome, away: newAway },
      });
      this.emitForTeam(homeTeamId, EVENTS.TEAM_CONCEDED, {
        match,
        scoringTeam: match.awayTeam,
        newScore: { home: newHome, away: newAway },
      });
    }

    // Emit result state change events
    this.emitResultStateChange(match, homeTeamId, oldHomeState, newHomeState, newHome, newAway, true);
    this.emitResultStateChange(match, awayTeamId, oldAwayState, newAwayState, newHome, newAway, false);
  }

  /**
   * Get result state: 'winning', 'losing', or 'drawing'
   */
  getResultState(teamScore, opponentScore) {
    if (teamScore > opponentScore) return 'winning';
    if (teamScore < opponentScore) return 'losing';
    return 'drawing';
  }

  /**
   * Emit result state change event
   */
  emitResultStateChange(match, teamId, oldState, newState, homeScore, awayScore, isHomeTeam) {
    if (oldState === newState) return;

    const opponent = isHomeTeam ? match.awayTeam : match.homeTeam;
    const teamGoals = isHomeTeam ? homeScore : awayScore;
    const opponentGoals = isHomeTeam ? awayScore : homeScore;
    const score = `${homeScore}-${awayScore}`;

    const eventData = {
      match,
      teamId,
      state: newState, // 'winning', 'losing', or 'drawing'
      score,
      opponent: opponent.shortName || opponent.name,
      minute: match.minute || 0,
      teamGoals,
      opponentGoals,
    };

    this.emitForTeam(teamId, EVENTS.MATCH_RESULT_CHANGED, eventData);
  }

  /**
   * Check for "match starts soon" events
   */
  checkMatchStartsSoon(matches) {
    const now = new Date();

    for (const match of matches) {
      if (!UPCOMING_STATUSES.includes(match.status)) continue;

      const matchDate = new Date(match.utcDate);
      const minutesUntil = (matchDate - now) / 1000 / 60;

      this.homey.log(`[Poll] Checking match_starts_soon: ${match.homeTeam.name} vs ${match.awayTeam.name} - ${Math.round(minutesUntil)} minutes until kickoff`);

      for (const threshold of MATCH_SOON_THRESHOLDS) {
        // Trigger if within threshold but not yet triggered
        if (minutesUntil <= threshold && minutesUntil > 0) {
          const triggeredSet = this.matchStartsSoonTriggered.get(match.id) || new Set();
          if (!triggeredSet.has(threshold)) {
            this.homey.log(`[Poll] Triggering match_starts_soon (${threshold} min) for ${match.homeTeam.name} vs ${match.awayTeam.name}`);
            triggeredSet.add(threshold);
            this.matchStartsSoonTriggered.set(match.id, triggeredSet);

            const homeTeamId = match.homeTeam.id;
            const awayTeamId = match.awayTeam.id;
            this.emitForTeams([homeTeamId, awayTeamId], EVENTS.MATCH_STARTS_SOON, {
              match,
              minutes: threshold,
            });
          }
        }
      }
    }
  }

  /**
   * Clean up old match data from caches
   */
  cleanupOldMatches(currentMatches) {
    const currentMatchIds = new Set(currentMatches.map(m => m.id));

    // Clean up matchStartsSoonTriggered for matches no longer in today's list
    for (const matchId of this.matchStartsSoonTriggered.keys()) {
      if (!currentMatchIds.has(matchId)) {
        this.matchStartsSoonTriggered.delete(matchId);
      }
    }

    // Clean up matchCache for finished matches older than 2 hours
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    for (const [matchId, cached] of this.matchCache) {
      if (COMPLETED_STATUSES.includes(cached.status)) {
        const matchDate = new Date(cached.utcDate);
        // Assume match is ~2 hours after kickoff
        const estimatedEnd = matchDate.getTime() + 2 * 60 * 60 * 1000;
        if (estimatedEnd < twoHoursAgo) {
          this.matchCache.delete(matchId);
        }
      }
    }
  }

  /**
   * Emit event for a single team
   */
  emitForTeam(teamId, eventName, data) {
    // Convert to string since trackedTeams keys are strings from device data
    const teamIdStr = String(teamId);
    if (this.trackedTeams.has(teamIdStr)) {
      this.emit(eventName, { ...data, teamId });
    }
  }

  /**
   * Emit event for multiple teams
   */
  emitForTeams(teamIds, eventName, data) {
    for (const teamId of teamIds) {
      this.emitForTeam(teamId, eventName, data);
    }
  }

  /**
   * Get current live match for a team
   */
  getTeamLiveMatch(teamId) {
    const numericTeamId = Number(teamId);
    for (const [matchId, cached] of this.matchCache) {
      if (LIVE_STATUSES.includes(cached.status)) {
        if (cached.homeTeamId === numericTeamId || cached.awayTeamId === numericTeamId) {
          return cached;
        }
      }
    }
    return null;
  }

  /**
   * Get today's match for a team
   */
  getTeamMatchToday(teamId) {
    const numericTeamId = Number(teamId);
    for (const [matchId, cached] of this.matchCache) {
      if (cached.homeTeamId === numericTeamId || cached.awayTeamId === numericTeamId) {
        return cached;
      }
    }
    return null;
  }

  /**
   * Fetch next scheduled match for a team (may require API call)
   */
  async getTeamNextMatch(teamId) {
    const today = new Date().toISOString().split('T')[0];
    // dateTo required by API - set to 6 months from now
    const futureDate = new Date();
    futureDate.setMonth(futureDate.getMonth() + 6);
    const dateTo = futureDate.toISOString().split('T')[0];

    this.homey.log(`getTeamNextMatch: teamId=${teamId}, dateFrom=${today}, dateTo=${dateTo}`);

    const matches = await this.api.getTeamMatches(teamId, {
      status: 'SCHEDULED,TIMED',
      dateFrom: today,
      dateTo: dateTo,
    });

    this.homey.log(`getTeamNextMatch: got ${matches.length} matches for team ${teamId}`);
    if (matches.length > 0) {
      this.homey.log(`First match: ${matches[0].homeTeam?.name} vs ${matches[0].awayTeam?.name} on ${matches[0].utcDate}`);
    }

    // Sort by date ascending to get the next match
    matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

    return matches[0] || null;
  }
}

module.exports = MatchManager;
