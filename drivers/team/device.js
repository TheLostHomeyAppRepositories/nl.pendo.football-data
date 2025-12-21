'use strict';

const Homey = require('homey');
const {
  MATCH_STATUS,
  LIVE_STATUSES,
  DEVICE_MATCH_STATUS,
  EVENTS,
} = require('../../lib/constants');

class TeamDevice extends Homey.Device {
  async onInit() {
    this.log('TeamDevice initializing:', this.getName());

    this.teamId = this.getData().id;
    this.teamName = this.getStoreValue('teamName') || this.getName();
    this.teamShortName = this.getStoreValue('teamShortName') || this.teamName;
    this.log(`Device data: teamId=${this.teamId}, name=${this.teamName}, store=`, this.getStore());

    // Get MatchManager and API from app
    this.matchManager = this.homey.app.matchManager;
    this.api = this.homey.app.api;

    if (!this.matchManager) {
      this.error('MatchManager not available');
      return;
    }

    // Register with MatchManager
    this.matchManager.registerDevice(this.teamId, this);

    // Set up event listeners
    this.setupEventListeners();

    // Set initial capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.IDLE).catch(this.error);
    await this.setCapabilityValue('score', '-').catch(this.error);

    // Check if team has a live match and restore state
    await this.checkAndRestoreLiveState();

    // Fetch and set next match
    this.updateNextMatch();

    this.log('TeamDevice initialized:', this.teamName);
  }

  /**
   * Check if team has a live match and restore the correct state
   */
  async checkAndRestoreLiveState() {
    if (!this.api) {
      this.log('API not available, skipping live state check');
      return;
    }

    try {
      this.log(`Checking for live matches for team ${this.teamId}...`);
      const liveMatches = await this.api.getTeamLiveMatches(this.teamId);

      if (liveMatches.length > 0) {
        const match = liveMatches[0];
        this.log(`Found live match: ${match.homeTeam.name} vs ${match.awayTeam.name} (${match.status})`);

        // Set match status based on API status
        if (match.status === 'PAUSED') {
          await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.HALFTIME).catch(this.error);
        } else {
          await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.LIVE).catch(this.error);
        }

        // Set score
        const homeScore = match.score?.fullTime?.home ?? 0;
        const awayScore = match.score?.fullTime?.away ?? 0;
        const score = this.formatScore(homeScore, awayScore);
        await this.setCapabilityValue('score', score).catch(this.error);

        this.log(`Restored live state: ${match.status}, score: ${score}`);
      } else {
        this.log('No live matches found for team');
      }
    } catch (error) {
      this.error('Error checking live state:', error.message);
    }
  }

  async onDeleted() {
    this.log('TeamDevice deleted:', this.getName());

    // Unregister from MatchManager
    if (this.matchManager) {
      this.matchManager.unregisterDevice(this.teamId, this);
    }

    // Remove event listeners
    this.removeEventListeners();
  }

  setupEventListeners() {
    // Create bound event handlers so we can remove them later
    this.eventHandlers = {
      [EVENTS.TEAM_SCORED]: this.onTeamScored.bind(this),
      [EVENTS.TEAM_CONCEDED]: this.onTeamConceded.bind(this),
      [EVENTS.MATCH_KICKOFF]: this.onMatchKickoff.bind(this),
      [EVENTS.HALFTIME_STARTED]: this.onHalftimeStarted.bind(this),
      [EVENTS.SECOND_HALF_STARTED]: this.onSecondHalfStarted.bind(this),
      [EVENTS.EXTRA_TIME_STARTED]: this.onExtraTimeStarted.bind(this),
      [EVENTS.TEAM_WON]: this.onTeamWon.bind(this),
      [EVENTS.TEAM_LOST]: this.onTeamLost.bind(this),
      [EVENTS.TEAM_DREW]: this.onTeamDrew.bind(this),
      [EVENTS.MATCH_STARTS_SOON]: this.onMatchStartsSoon.bind(this),
      [EVENTS.MATCH_FINISHED]: this.onMatchFinished.bind(this),
      [EVENTS.MATCH_RESULT_CHANGED]: this.onMatchResultChanged.bind(this),
    };

    for (const [event, handler] of Object.entries(this.eventHandlers)) {
      this.matchManager.on(event, handler);
    }
  }

  removeEventListeners() {
    if (!this.eventHandlers || !this.matchManager) return;

    for (const [event, handler] of Object.entries(this.eventHandlers)) {
      this.matchManager.off(event, handler);
    }
  }

  /**
   * Filter events for this device's team
   */
  isMyEvent(data) {
    return Number(data.teamId) === Number(this.teamId);
  }

  /**
   * Get opponent info from match
   */
  getOpponentInfo(match) {
    const isHome = match.homeTeam.id === Number(this.teamId);
    const opponent = isHome ? match.awayTeam : match.homeTeam;
    return {
      opponent: opponent.shortName || opponent.name,
      isHome,
    };
  }

  /**
   * Format score string
   */
  formatScore(home, away) {
    return `${home}-${away}`;
  }

  // Event Handlers

  async onTeamScored(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Team scored:', data.newScore);

    const { match, newScore } = data;
    const { opponent } = this.getOpponentInfo(match);
    const score = this.formatScore(newScore.home, newScore.away);

    // Update capabilities
    await this.setCapabilityValue('score', score).catch(this.error);

    // Trigger flow card
    const tokens = {
      score,
      minute: match.minute || 0,
      opponent,
      home_score: newScore.home,
      away_score: newScore.away,
    };
    await this.triggerFlow('team_scored', tokens);
  }

  async onTeamConceded(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Team conceded:', data.newScore);

    const { match, scoringTeam, newScore } = data;
    const score = this.formatScore(newScore.home, newScore.away);

    // Update capabilities
    await this.setCapabilityValue('score', score).catch(this.error);

    // Trigger flow card
    const tokens = {
      score,
      minute: match.minute || 0,
      scoring_team: scoringTeam.shortName || scoringTeam.name,
      home_score: newScore.home,
      away_score: newScore.away,
    };
    await this.triggerFlow('team_conceded', tokens);
  }

  async onMatchKickoff(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Match kicked off');

    const { match } = data;
    const { opponent, isHome } = this.getOpponentInfo(match);

    // Update capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.LIVE).catch(this.error);
    await this.setCapabilityValue('score', '0-0').catch(this.error);

    // Trigger flow card
    const tokens = {
      opponent,
      competition: match.competition?.name || '',
      is_home: isHome,
    };
    await this.triggerFlow('match_kickoff', tokens);
  }

  async onHalftimeStarted(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Halftime started');

    const { match } = data;
    const { opponent } = this.getOpponentInfo(match);
    const homeScore = match.score?.halfTime?.home ?? match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.halfTime?.away ?? match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);

    // Update capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.HALFTIME).catch(this.error);

    // Trigger flow card
    const tokens = {
      halftime_score: score,
      opponent,
      home_score: homeScore,
      away_score: awayScore,
    };
    await this.triggerFlow('halftime_started', tokens);
  }

  async onSecondHalfStarted(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Second half started');

    const { match } = data;
    const { opponent } = this.getOpponentInfo(match);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);

    // Update capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.LIVE).catch(this.error);

    // Trigger flow card
    const tokens = {
      score,
      opponent,
    };
    await this.triggerFlow('second_half_started', tokens);
  }

  async onExtraTimeStarted(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Extra time started');

    const { match } = data;
    const { opponent } = this.getOpponentInfo(match);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);

    // Trigger flow card
    const tokens = {
      score,
      opponent,
      competition: match.competition?.name || '',
    };
    await this.triggerFlow('extra_time_started', tokens);
  }

  async onTeamWon(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Team won');

    const { match } = data;
    const { opponent, isHome } = this.getOpponentInfo(match);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);
    const teamGoals = isHome ? homeScore : awayScore;
    const opponentGoals = isHome ? awayScore : homeScore;

    // Trigger flow card
    const tokens = {
      final_score: score,
      opponent,
      competition: match.competition?.name || '',
      team_goals: teamGoals,
      opponent_goals: opponentGoals,
    };
    await this.triggerFlow('team_won', tokens);
  }

  async onTeamLost(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Team lost');

    const { match } = data;
    const { opponent, isHome } = this.getOpponentInfo(match);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);
    const teamGoals = isHome ? homeScore : awayScore;
    const opponentGoals = isHome ? awayScore : homeScore;

    // Trigger flow card
    const tokens = {
      final_score: score,
      opponent,
      competition: match.competition?.name || '',
      team_goals: teamGoals,
      opponent_goals: opponentGoals,
    };
    await this.triggerFlow('team_lost', tokens);
  }

  async onTeamDrew(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Team drew');

    const { match } = data;
    const { opponent } = this.getOpponentInfo(match);
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);

    // Trigger flow card
    const tokens = {
      final_score: score,
      opponent,
      competition: match.competition?.name || '',
      goals: homeScore,
    };
    await this.triggerFlow('team_drew', tokens);
  }

  async onMatchFinished(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Match finished');

    const { match } = data;
    const homeScore = match.score?.fullTime?.home ?? 0;
    const awayScore = match.score?.fullTime?.away ?? 0;
    const score = this.formatScore(homeScore, awayScore);

    // Update capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.FINISHED).catch(this.error);
    await this.setCapabilityValue('score', score).catch(this.error);

    // Update next match after a delay
    this.homey.setTimeout(() => this.updateNextMatch(), 60000);
  }

  async onMatchStartsSoon(data) {
    this.log(`onMatchStartsSoon received: teamId=${data.teamId}, myTeamId=${this.teamId}, match=${data.match?.homeTeam?.name} vs ${data.match?.awayTeam?.name}`);
    if (!this.isMyEvent(data)) {
      this.log('Not my event, skipping');
      return;
    }
    this.log('Match starts soon:', data.minutes, 'minutes');

    const { match, minutes } = data;
    const { opponent, isHome } = this.getOpponentInfo(match);
    this.log(`Calculated opponent: ${opponent}, isHome: ${isHome}`);
    const matchDate = new Date(match.utcDate);
    const timezone = this.homey.clock.getTimezone();
    const kickoffTime = matchDate.toLocaleTimeString('nl-NL', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    });

    // Update capabilities
    await this.setCapabilityValue('match_status', DEVICE_MATCH_STATUS.SCHEDULED).catch(this.error);

    // Trigger flow card with minutes filter
    const tokens = {
      opponent,
      kickoff_time: kickoffTime,
      competition: match.competition?.name || '',
      is_home: isHome,
    };
    this.log(`Triggering match_starts_soon with tokens:`, tokens);
    await this.triggerFlow('match_starts_soon', tokens, { minutes: String(minutes) });
  }

  async onMatchResultChanged(data) {
    if (!this.isMyEvent(data)) return;
    this.log('Match result changed:', data.state, data.score);

    const tokens = {
      state: data.state,
      score: data.score,
      opponent: data.opponent,
      minute: data.minute,
      team_goals: data.teamGoals,
      opponent_goals: data.opponentGoals,
    };
    await this.triggerFlow('match_result_changed', tokens);
  }

  /**
   * Trigger a flow card
   */
  async triggerFlow(cardId, tokens, state = {}) {
    this.log(`Triggering flow card: ${cardId}`, tokens);
    const card = this.homey.flow.getDeviceTriggerCard(cardId);
    if (card) {
      await card.trigger(this, tokens, state).catch(err => {
        this.error(`Error triggering ${cardId}:`, err.message);
      });
      this.log(`Flow card ${cardId} triggered successfully`);
    } else {
      this.error(`Flow card not found: ${cardId}`);
    }
  }

  /**
   * Check if team is currently winning
   */
  isWinning() {
    // Get live match from cache (works even if capabilities not updated)
    const cached = this.matchManager.getTeamLiveMatch(this.teamId);

    // Also check for "probably live" matches (API delayed)
    const matchToday = cached || this.matchManager.getTeamMatchToday(this.teamId);
    if (!matchToday) return false;

    // Check if match is actually live or probably live
    const kickoffTime = new Date(matchToday.utcDate || matchToday.kickoffTime);
    const now = new Date();
    const minutesSinceKickoff = (now - kickoffTime) / 1000 / 60;
    const isLive = cached || (minutesSinceKickoff > 0 && minutesSinceKickoff < 120);
    if (!isLive) return false;

    const homeScore = matchToday.homeScore ?? 0;
    const awayScore = matchToday.awayScore ?? 0;
    const isHome = matchToday.homeTeamId === Number(this.teamId);

    return isHome ? homeScore > awayScore : awayScore > homeScore;
  }

  /**
   * Check if team is currently losing
   */
  isLosing() {
    const cached = this.matchManager.getTeamLiveMatch(this.teamId);
    const matchToday = cached || this.matchManager.getTeamMatchToday(this.teamId);
    if (!matchToday) return false;

    const kickoffTime = new Date(matchToday.utcDate || matchToday.kickoffTime);
    const now = new Date();
    const minutesSinceKickoff = (now - kickoffTime) / 1000 / 60;
    const isLive = cached || (minutesSinceKickoff > 0 && minutesSinceKickoff < 120);
    if (!isLive) return false;

    const homeScore = matchToday.homeScore ?? 0;
    const awayScore = matchToday.awayScore ?? 0;
    const isHome = matchToday.homeTeamId === Number(this.teamId);

    return isHome ? homeScore < awayScore : awayScore < homeScore;
  }

  /**
   * Check if match is currently a draw
   */
  isDrawing() {
    const cached = this.matchManager.getTeamLiveMatch(this.teamId);
    const matchToday = cached || this.matchManager.getTeamMatchToday(this.teamId);
    if (!matchToday) return false;

    const kickoffTime = new Date(matchToday.utcDate || matchToday.kickoffTime);
    const now = new Date();
    const minutesSinceKickoff = (now - kickoffTime) / 1000 / 60;
    const isLive = cached || (minutesSinceKickoff > 0 && minutesSinceKickoff < 120);
    if (!isLive) return false;

    const homeScore = matchToday.homeScore ?? 0;
    const awayScore = matchToday.awayScore ?? 0;

    return homeScore === awayScore;
  }

  /**
   * Update the next_match capability
   */
  async updateNextMatch() {
    try {
      this.log(`Fetching next match for teamId: ${this.teamId} (${this.teamName})`);
      const nextMatch = await this.matchManager.getTeamNextMatch(this.teamId);
      this.log(`Next match result:`, nextMatch ? `${nextMatch.homeTeam.name} vs ${nextMatch.awayTeam.name} on ${nextMatch.utcDate}` : 'none');
      if (nextMatch) {
        const { opponent, isHome } = this.getOpponentInfo(nextMatch);
        const matchDate = new Date(nextMatch.utcDate);
        const timezone = this.homey.clock.getTimezone();
        const dateStr = matchDate.toLocaleDateString('nl-NL', {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          timeZone: timezone,
        });
        const timeStr = matchDate.toLocaleTimeString('nl-NL', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
        });
        const venue = isHome ? '(T)' : '(U)';
        const nextMatchStr = `${opponent} ${venue} - ${dateStr} ${timeStr}`;
        await this.setCapabilityValue('next_match', nextMatchStr).catch(this.error);
      } else {
        await this.setCapabilityValue('next_match', '-').catch(this.error);
      }
    } catch (error) {
      this.error('Error updating next match:', error.message);
    }
  }
}

module.exports = TeamDevice;
