# MLB Watcher

Live MLB game tracker with a customisable display buffer.
Made by HarveyOC (@hxoxcx) for Orioles BirdWatcher.
Powered by Orioles Magic.

## What does it look like?
- Current public release - https://mlbwatcher.netlify.app
- Beta release - https://harveyoc.github.io/MLB-Watcher/#/ 

## How it works

Three views, all hash-routed so the browser back / forward buttons just work:

| Route | View |
|---|---|
| `#/` | Home — date selector + a card per game (plus a Carousel card) |
| `#/carousel` | Auto-rotating live carousel of every game on today's slate |
| `#/game/{gamePk}` | Single-game view: scorebug · box score · play-by-play |

The home page updates as soon as MLB Stats API data is pulled (no buffer).
**Every other view shows data on a delay.** Each game has its
own buffered feed: API responses are queued with timestamps, and the
carousel / game pages only display snapshots that have been buffered.
While the buffer is filling, you'll see a "Building buffer" screen with
a progress bar.

## Data source

[MLB Stats API](https://statsapi.mlb.com/) — public, no key needed:

- Schedule: `GET https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=team,linescore`
- Live game feed: `GET https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`
- Team logos: `https://www.mlbstatic.com/team-logos/{teamId}.svg`

## Why the buffer?

The buffer exists so that this app can be used alongside a live broadcast.
If the broadcast is itself delayed, and we want to avoid spoiling plays
before they air. The home page is exempt because it shows top-line scores
that you'd already see on any scoreboard.

## Testing changes

You can append the following flags to the URL for testing changes to match screens and the play-by-play view. They will force the app to display the most recent time these states were shown, or display them with empty data if they haven't occured yet. Best practice is to use a completed game from a previous day.

`https://mlbwatcher.netlify.app/?force=flag#/game/99999`

- Active: The strikezone view, with balls and strikes and pitch sequence
- Inactive: Mid-inning view, showing next three batters
- Pregame: Probable pitchers and start time
- Final: Winning and losing pitchers, notable batters

## CORS fallback

`statsapi.mlb.com` normally allows browser requests. If you hit a CORS
error in production, flip `USE_PROXY` to `true` in `app.js`. The site
will then route requests through the included Netlify Function at
`/api/mlb` (`netlify/functions/mlb.mjs`), which forwards to the MLB API
and adds the right headers. No code changes anywhere else.

## Files

- `index.html` — entry point, loads fonts + assets
- `styles.css` — full theme, dark with orange accents and glow effects
- `app.js` — router, buffered feed, all three views
