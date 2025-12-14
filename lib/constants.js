'use strict';

// API Configuration
const API_BASE_URL = 'https://api.football-data.org/v4';
const RATE_LIMIT = 10; // requests per minute (free tier)
const RATE_LIMIT_BUFFER = 2; // reserve for high-priority requests

// Match Status Values from API
const MATCH_STATUS = {
  SCHEDULED: 'SCHEDULED',
  TIMED: 'TIMED',
  IN_PLAY: 'IN_PLAY',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
  SUSPENDED: 'SUSPENDED',
  POSTPONED: 'POSTPONED',
  CANCELLED: 'CANCELLED',
  AWARDED: 'AWARDED',
};

// Status groupings
const LIVE_STATUSES = ['IN_PLAY', 'PAUSED'];
const UPCOMING_STATUSES = ['SCHEDULED', 'TIMED'];
const COMPLETED_STATUSES = ['FINISHED', 'AWARDED'];

// Device capability status mapping
const DEVICE_MATCH_STATUS = {
  IDLE: 'idle',
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  HALFTIME: 'halftime',
  FINISHED: 'finished',
};

// Polling intervals in milliseconds
const POLLING_INTERVALS = {
  IDLE: 15 * 60 * 1000,      // 15 minutes - no matches soon
  PRE_MATCH: 5 * 60 * 1000,  // 5 minutes - match within 2 hours
  LIVE: 30 * 1000,           // 30 seconds - match in play
  PAUSED: 2 * 60 * 1000,     // 2 minutes - halftime
  POST_MATCH: 5 * 60 * 1000, // 5 minutes - match ended within 15 min
};

// Polling states
const POLLING_STATE = {
  IDLE: 'IDLE',
  PRE_MATCH: 'PRE_MATCH',
  LIVE: 'LIVE',
  PAUSED: 'PAUSED',
  POST_MATCH: 'POST_MATCH',
};

// Free tier competitions
const FREE_TIER_COMPETITIONS = [
  { code: 'PL', name: 'Premier League', country: 'England' },
  { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
  { code: 'SA', name: 'Serie A', country: 'Italy' },
  { code: 'PD', name: 'La Liga', country: 'Spain' },
  { code: 'FL1', name: 'Ligue 1', country: 'France' },
  { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
  { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
  { code: 'ELC', name: 'Championship', country: 'England' },
  { code: 'CL', name: 'Champions League', country: 'Europe' },
  { code: 'EC', name: 'European Championship', country: 'Europe' },
  { code: 'WC', name: 'World Cup', country: 'International' },
];

// Match starts soon thresholds (in minutes)
const MATCH_SOON_THRESHOLDS = [15, 30, 60, 120];

// Event names emitted by MatchManager
const EVENTS = {
  TEAM_SCORED: 'team_scored',
  TEAM_CONCEDED: 'team_conceded',
  MATCH_KICKOFF: 'match_kickoff',
  HALFTIME_STARTED: 'halftime_started',
  SECOND_HALF_STARTED: 'second_half_started',
  EXTRA_TIME_STARTED: 'extra_time_started',
  MATCH_FINISHED: 'match_finished',
  TEAM_WON: 'team_won',
  TEAM_LOST: 'team_lost',
  TEAM_DREW: 'team_drew',
  MATCH_STARTS_SOON: 'match_starts_soon',
  MATCH_RESULT_CHANGED: 'match_result_changed',
};

module.exports = {
  API_BASE_URL,
  RATE_LIMIT,
  RATE_LIMIT_BUFFER,
  MATCH_STATUS,
  LIVE_STATUSES,
  UPCOMING_STATUSES,
  COMPLETED_STATUSES,
  DEVICE_MATCH_STATUS,
  POLLING_INTERVALS,
  POLLING_STATE,
  FREE_TIER_COMPETITIONS,
  MATCH_SOON_THRESHOLDS,
  EVENTS,
};
