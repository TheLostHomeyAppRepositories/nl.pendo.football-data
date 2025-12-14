# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Homey Pro smart home app integrating with football-data.org API v4. Uses a driver-based architecture where each tracked team is a Homey device, providing flow cards for match event automations.

## Build Commands

```bash
npm install              # Install dependencies
homey app run           # Run locally on Homey
homey app install       # Install on Homey
homey app validate      # Validate app manifest
homey app publish       # Publish to Homey App Store
```

## Architecture

```
app.js
├── FootballAPI (lib/FootballAPI.js)     # Rate-limited API client
└── MatchManager (lib/MatchManager.js)   # Singleton polling, event emitter
         │
         └── Devices (drivers/team/device.js)
              └── Each team device registers with MatchManager
              └── Updates capabilities, triggers device-scoped flows
```

### Key Components

| File | Purpose |
|------|---------|
| `lib/constants.js` | Match statuses, competitions, polling intervals |
| `lib/FootballAPI.js` | Rate-limited API client (10 req/min free tier) |
| `lib/MatchManager.js` | Adaptive polling, event detection (goals, status changes) |
| `drivers/team/driver.js` | Team search during pairing |
| `drivers/team/device.js` | Device state, capability updates, flow triggers |
| `drivers/team/driver.compose.json` | Device capabilities and flow card definitions |

### Device Capabilities

- `match_status` - enum: idle, scheduled, live, halftime, finished
- `score` - string: "2-1"
- `next_match` - string: "PSV (T) - za 21 dec 20:00"
- `alarm_generic` - boolean: true when match is live

### Flow Cards (Device-Scoped)

**Triggers:** team_scored, team_conceded, match_kickoff, halftime_started, second_half_started, extra_time_started, team_won, team_lost, team_drew, match_starts_soon

**Conditions:** is_playing, is_winning, is_losing, is_drawing, has_match_today, match_within_hours

### Polling Strategy

| State | Interval | Condition |
|-------|----------|-----------|
| IDLE | 15 min | No matches within 2 hours |
| PRE_MATCH | 5 min | Match starting within 2 hours |
| LIVE | 30 sec | Match status is IN_PLAY |
| PAUSED | 2 min | Halftime |
| POST_MATCH | 5 min | Match ended within 15 minutes |

## API Reference

- Base URL: `https://api.football-data.org/v4`
- Free tier: 10 requests/minute
- Key endpoints: `/matches`, `/teams/{id}/matches`, `/competitions/{code}/teams`

## File Structure

```
nl.pendo.football-data/
├── .homeycompose/
│   ├── app.json                    # App manifest
│   └── capabilities/               # Custom capability definitions
├── drivers/team/
│   ├── driver.compose.json         # Driver config + flow cards
│   ├── driver.js                   # Pairing logic
│   └── device.js                   # Device state management
├── lib/
│   ├── constants.js
│   ├── FootballAPI.js
│   └── MatchManager.js
├── settings/index.html             # API key configuration
├── locales/{en,nl}.json
└── app.js                          # App initialization
```

## Specification Document

Full implementation details in `homey-football-app-spec.md`.
