/* ============================================
   BirdWatcher — MLB live tracker
   Powered by Orioles Magic
   ============================================ */

(() => {
  'use strict';

  // ============================================
  //  STATIC ASSETS
  // ============================================
  // Cached batter SVG path data for strike zone overlay.
  // Loaded once at startup; subsequent strikeZoneSvg renders use the cached path.
  let batterPathData = null;
  let batterPathTransform = null;
  let batterViewBox = '0 0 960 1914';
  (function loadBatterSvg() {
    fetch('./batter.svg')
      .then(r => r.text())
      .then(text => {
        // Parse out the path's d attribute and transform
        const dMatch = text.match(/<path[^>]*\bd="([^"]*)"/);
        const tMatch = text.match(/<path[^>]*\btransform="([^"]*)"/);
        const vbMatch = text.match(/<svg[^>]*\bviewBox="([^"]*)"/);
        const wMatch = text.match(/<svg[^>]*\bwidth="(\d+)"/);
        const hMatch = text.match(/<svg[^>]*\bheight="(\d+)"/);
        if (dMatch) batterPathData = dMatch[1];
        if (tMatch) batterPathTransform = tMatch[1];
        if (vbMatch) batterViewBox = vbMatch[1];
        else if (wMatch && hMatch) batterViewBox = `0 0 ${wMatch[1]} ${hMatch[1]}`;
      })
      .catch(() => { /* silhouette will be skipped if load fails */ });
  })();
  const API_BASE = 'https://statsapi.mlb.com/api';
  // If you ever see CORS errors, set USE_PROXY = true. This routes requests
  // through the bundled Netlify Function at /api/mlb instead of hitting
  // statsapi.mlb.com directly. The Function adds CORS headers and forwards.
  const USE_PROXY = false;
  const PROXY_BASE = '/api/mlb?path=';
  const LOGO_URL = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;
  // MLB player headshot — official cutout-style portrait. Falls back to a generic silhouette.
  const PLAYER_HEADSHOT_URL = (playerId, width = 213) =>
    `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${width},q_auto:best/v1/people/${playerId}/headshot/67/current`;

  // Logo overrides — render these teams as a single-color silhouette using a CSS mask.
  // The map's value is the solid color the silhouette should use.
  const LOGO_TINT_OVERRIDES = {
    115: '#33006F', // COL Rockies — all purple
    135: '#FFC425'  // SD Padres — all yellow
  };
  // Build an element representing a team's logo. Returns an <img> by default;
  // for tint-override teams, returns a masked <div> that renders the SVG silhouette
  // in a single solid color.
  const teamLogoEl = (teamId, { className = '', alt = '', onError } = {}) => {
    const tint = LOGO_TINT_OVERRIDES[teamId];
    if (tint) {
      const url = LOGO_URL(teamId);
      const div = el('div', {
        class: `team-logo-tint ${className}`,
        role: 'img',
        'aria-label': alt,
        style: {
          backgroundColor: tint,
          '-webkit-mask': `url(${url}) no-repeat center / contain`,
          'mask': `url(${url}) no-repeat center / contain`
        }
      });
      return div;
    }
    return el('img', {
      class: className,
      src: LOGO_URL(teamId),
      alt,
      onerror: onError || function () { this.style.opacity = '0.3'; }
    });
  };
  const DEFAULT_BUFFER_MS = 80 * 1000; // 80 seconds
  const DEFAULT_ACCENT_HEX = '#ff7a1a';
  const SCHEDULE_POLL_MS = 30 * 1000;
  const LIVE_FEED_POLL_MS = 8 * 1000;
  const ROTATING_STAT_INTERVAL_MS = 60 * 1000;
  const CAROUSEL_ROTATION_MS = 12 * 1000;

  // ============================================
  //  USER SETTINGS — persisted to localStorage
  // ============================================
  const Settings = (() => {
    const STORAGE_KEY = 'mlbwatcher.settings.v1';
    const subs = new Set();
    let cache = null;

    const safeGet = () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    };
    const safeSet = (obj) => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(obj)); }
      catch { /* private mode / quota; in-memory cache still works for the session */ }
    };

    const defaults = () => ({
      bufferMs: DEFAULT_BUFFER_MS,
      accentHex: DEFAULT_ACCENT_HEX
    });

    const load = () => {
      if (cache) return cache;
      cache = Object.assign(defaults(), safeGet() || {});
      return cache;
    };

    const get = (key) => load()[key];
    const set = (patch) => {
      cache = Object.assign(load(), patch);
      safeSet(cache);
      subs.forEach(fn => { try { fn(cache); } catch {} });
    };
    const reset = () => {
      cache = defaults();
      safeSet(cache);
      subs.forEach(fn => { try { fn(cache); } catch {} });
    };
    const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };

    return { get, set, reset, subscribe, defaults };
  })();

  // Convert "#rrggbb" → "r, g, b" string for use inside rgba(...)
  const accentHexToRgbCsv = (hex) => {
    const h = (hex || DEFAULT_ACCENT_HEX).replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return '255, 122, 26';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  };
  // Lighten / darken hex by a percentage (-100..100). Used to derive bright/deep variants.
  const adjustHex = (hex, percent) => {
    const h = (hex || DEFAULT_ACCENT_HEX).replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return hex;
    const amt = Math.round((percent / 100) * 255);
    const ch = (s) => {
      const v = Math.max(0, Math.min(255, parseInt(s, 16) + amt));
      return v.toString(16).padStart(2, '0');
    };
    return `#${ch(h.slice(0, 2))}${ch(h.slice(2, 4))}${ch(h.slice(4, 6))}`;
  };
  // Apply the current accent to :root CSS variables so the entire UI re-themes.
  const applyAccent = (hex) => {
    const root = document.documentElement;
    const base = hex || DEFAULT_ACCENT_HEX;
    const bright = adjustHex(base, 16);
    const deep = adjustHex(base, -22);
    root.style.setProperty('--accent-rgb', accentHexToRgbCsv(base));
    root.style.setProperty('--accent-bright-rgb', accentHexToRgbCsv(bright));
    root.style.setProperty('--accent-deep-rgb', accentHexToRgbCsv(deep));
  };
  // Apply on load and any settings change
  applyAccent(Settings.get('accentHex'));
  Settings.subscribe(s => applyAccent(s.accentHex));

  // Buffer length is read live from settings, so changes take effect on next mount.
  const getBufferMs = () => {
    const v = Settings.get('bufferMs');
    return (typeof v === 'number' && v >= 0) ? v : DEFAULT_BUFFER_MS;
  };

  const ROTATING_STATS = [
    { key: 'hits', label: 'Hits' },
    { key: 'homeRuns', label: 'Home Runs' },
    { key: 'rbi', label: 'RBI' },
    { key: 'stolenBases', label: 'Stolen Bases' },
    { key: 'caughtStealing', label: 'Caught Stealing' },
    { key: 'baseOnBalls', label: 'Walks' },
    { key: 'leftOnBase', label: 'Left On Base' },
    { key: 'groundIntoDoublePlay', label: 'GIDP' },
    { key: 'strikeOuts', label: 'Strikeouts' },
    { key: 'errors', label: 'Errors' },
    { key: 'xbh', label: 'XBHs', calc: true },
    { key: 'totalBases', label: 'Total Bases' }
  ];

  // Team colors keyed by MLB team ID. Primary first, secondary second.
  // Sourced from common references (jimniels/teamcolors and team-color-codes).
  const TEAM_COLORS = {
    108: { primary: '#BA0021', secondary: '#003263' }, // LAA Angels
    109: { primary: '#A71930', secondary: '#000000' }, // ARI Diamondbacks
    110: { primary: '#DF4601', secondary: '#000000' }, // BAL Orioles
    111: { primary: '#BD3039', secondary: '#0C2340' }, // BOS Red Sox
    112: { primary: '#0E3386', secondary: '#CC3433' }, // CHC Cubs
    113: { primary: '#C6011F', secondary: '#000000' }, // CIN Reds
    114: { primary: '#E50022', secondary: '#00385D' }, // CLE Guardians
    115: { primary: '#33006F', secondary: '#C4CED4' }, // COL Rockies
    116: { primary: '#0C2340', secondary: '#FA4616' }, // DET Tigers
    117: { primary: '#EB6E1F', secondary: '#002D62' }, // HOU Astros
    118: { primary: '#004687', secondary: '#BD9B60' }, // KC Royals
    119: { primary: '#005A9C', secondary: '#EF3E42' }, // LAD Dodgers
    120: { primary: '#AB0003', secondary: '#14225A' }, // WSH Nationals
    121: { primary: '#002D72', secondary: '#FF5910' }, // NYM Mets
    133: { primary: '#003831', secondary: '#EFB21E' }, // OAK Athletics (still ID 133)
    134: { primary: '#FDB827', secondary: '#27251F' }, // PIT Pirates
    135: { primary: '#FFC425', secondary: '#2F241D' }, // SD Padres
    136: { primary: '#005C5C', secondary: '#0C2C56' }, // SEA Mariners
    137: { primary: '#FD5A1E', secondary: '#27251F' }, // SF Giants
    138: { primary: '#C41E3A', secondary: '#0C2340' }, // STL Cardinals
    139: { primary: '#092C5C', secondary: '#8FBCE6' }, // TB Rays
    140: { primary: '#003278', secondary: '#C0111F' }, // TEX Rangers
    141: { primary: '#134A8E', secondary: '#1D2D5C' }, // TOR Blue Jays
    142: { primary: '#002B5C', secondary: '#D31145' }, // MIN Twins
    143: { primary: '#E81828', secondary: '#002D72' }, // PHI Phillies
    144: { primary: '#CE1141', secondary: '#13274F' }, // ATL Braves
    145: { primary: '#FFFFFF', secondary: '#27251F' }, // CHW White Sox
    146: { primary: '#00A3E0', secondary: '#EF3340' }, // MIA Marlins
    147: { primary: '#FFFFFF', secondary: '#0C2340' }, // NYY Yankees
    158: { primary: '#FFC52F', secondary: '#12284B' }  // MIL Brewers
  };
  const teamColor = (teamId, slot = 'primary') => {
    const t = TEAM_COLORS[teamId];
    if (!t) return slot === 'primary' ? '#888888' : '#444444';
    return t[slot];
  };

  // Stadium images keyed by team ID, used as a faded backdrop on the pre-game screen.
  // Set the value to a stable, hotlinkable image URL (e.g. from your own CDN, Unsplash,
  // or a verified Wikimedia URL). An empty string means "no image yet" — the pre-game
  // backdrop falls back to a plain dark gradient for that team.
  const STADIUM_IMAGES = {
    // ----- AL East -----
    110: '', // BAL · Camden Yards
    111: '', // BOS · Fenway Park
    139: '', // TB  · Tropicana Field (Steinbrenner Field 2025)
    141: '', // TOR · Rogers Centre
    147: '', // NYY · Yankee Stadium

    // ----- AL Central -----
    114: '', // CLE · Progressive Field
    116: '', // DET · Comerica Park
    118: '', // KC  · Kauffman Stadium
    142: '', // MIN · Target Field
    145: '', // CHW · Rate Field

    // ----- AL West -----
    108: '', // LAA · Angel Stadium
    117: '', // HOU · Daikin Park
    133: '', // OAK · Sutter Health Park (West Sacramento)
    136: '', // SEA · T-Mobile Park
    140: '', // TEX · Globe Life Field

    // ----- NL East -----
    120: '', // WSH · Nationals Park
    121: '', // NYM · Citi Field
    143: '', // PHI · Citizens Bank Park
    144: '', // ATL · Truist Park
    146: '', // MIA · loanDepot park

    // ----- NL Central -----
    112: '', // CHC · Wrigley Field
    113: '', // CIN · Great American Ball Park
    134: '', // PIT · PNC Park
    138: '', // STL · Busch Stadium
    158: '', // MIL · American Family Field

    // ----- NL West -----
    109: '', // ARI · Chase Field
    115: '', // COL · Coors Field
    119: '', // LAD · Dodger Stadium
    135: '', // SD  · Petco Park
    137: ''  // SF  · Oracle Park
  };
  const stadiumImage = (teamId) => STADIUM_IMAGES[teamId] || null;
  // Convert hex (#RRGGBB) to "r, g, b" string for use in rgba()
  const hexToRgbCsv = (hex) => {
    const h = (hex || '').replace('#', '');
    if (h.length !== 6) return '136, 136, 136';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `${r}, ${g}, ${b}`;
  };

  // ============================================
  //  UTILITIES
  // ============================================

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const el = (tag, props = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) e.style.setProperty(sk, sv);
          else e.style[sk] = sv;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') e.innerHTML = v;
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

  // Eastern Time helpers — derive a YYYY-MM-DD string for a given Date in ET
  const ET_TZ = 'America/New_York';
  const fmtETDate = (d) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${day}`;
  };
  const todayET = () => fmtETDate(new Date());
  const addDaysET = (yyyymmdd, delta) => {
    // Treat date as noon ET to avoid DST edge cases
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 17, 0, 0)); // ~noon ET (UTC-5 typical)
    dt.setUTCDate(dt.getUTCDate() + delta);
    return fmtETDate(dt);
  };
  const prettyDate = (yyyymmdd) => {
    const [y, m, d] = yyyymmdd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d, 17, 0, 0));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
    return formatter.format(dt);
  };

  const fmtTime = (isoStr, tz) => {
    if (!isoStr) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
      }).format(new Date(isoStr));
    } catch (e) { return ''; }
  };

  const localTzAbbrev = () => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date());
      const p = parts.find(x => x.type === 'timeZoneName');
      return p ? p.value : '';
    } catch (e) { return ''; }
  };

  const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  // ============================================
  //  BUFFERED DATA STORE
  //  All non-schedule data goes through this 80s delay.
  //  We poll the API, push timestamped snapshots into a queue,
  //  and only "release" snapshots whose age >= 80s.
  // ============================================

  class BufferedFeed {
    constructor(fetchFn, key) {
      this.fetchFn = fetchFn;
      this.key = key;
      this.queue = []; // {timestamp, data}
      this.released = null; // most recent released snapshot
      this.listeners = new Set();
      this.firstFetchAt = null;
      this.pollTimer = null;
      this.releaseTimer = null;
      this.pollInterval = LIVE_FEED_POLL_MS;
    }

    start() {
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), this.pollInterval);
      // Tick releases ~4x/sec for smooth countdown / progress
      this.releaseTimer = setInterval(() => this.tryRelease(), 250);
    }

    stop() {
      clearInterval(this.pollTimer);
      clearInterval(this.releaseTimer);
      this.pollTimer = null;
      this.releaseTimer = null;
    }

    async poll() {
      try {
        const data = await this.fetchFn();
        if (data == null) return;
        const ts = Date.now();
        if (this.firstFetchAt == null) this.firstFetchAt = ts;
        this.queue.push({ timestamp: ts, data });
        // Cap queue (keep ~5 minutes worth)
        if (this.queue.length > 60) this.queue.shift();
        this.tryRelease();
      } catch (e) {
        console.warn('[BufferedFeed] poll failed:', e);
      }
    }

    tryRelease() {
      const now = Date.now();
      // Find the latest snapshot that is at least getBufferMs() old
      let releaseIdx = -1;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (now - this.queue[i].timestamp >= getBufferMs()) {
          releaseIdx = i;
          break;
        }
      }
      if (releaseIdx >= 0) {
        const snap = this.queue[releaseIdx];
        // Drop everything before this (we only show in pulled order, latest released)
        this.queue = this.queue.slice(releaseIdx + 1);
        if (this.released !== snap.data) {
          this.released = snap.data;
          this.listeners.forEach(fn => { try { fn(snap.data); } catch (e) { console.error(e); } });
        }
      }
      // Notify listeners every tick about buffer progress (for "Building buffer" UI)
      this.listeners.forEach(fn => {
        if (fn._wantsProgress) {
          const elapsed = this.firstFetchAt ? now - this.firstFetchAt : 0;
          fn._wantsProgress({
            ready: this.released != null,
            progress: Math.min(1, elapsed / getBufferMs()),
            remainingMs: Math.max(0, getBufferMs() - elapsed)
          });
        }
      });
    }

    subscribe(fn) {
      this.listeners.add(fn);
      if (this.released != null) fn(this.released);
      return () => this.listeners.delete(fn);
    }

    onProgress(fn) {
      // Progress-only handler. Will not be called with data; use subscribe() for that.
      const wrapped = () => {}; // no-op for data
      wrapped._wantsProgress = ({ ready, progress, remainingMs }) => {
        fn({ ready, progress, remainingMs });
      };
      this.listeners.add(wrapped);
      this.tryRelease();
      return () => this.listeners.delete(wrapped);
    }
  }

  // ============================================
  //  API CALLS
  // ============================================

  async function jsonFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  function fetchSchedule(dateStr) {
    const path = `/v1/schedule?sportId=1&date=${dateStr}&hydrate=team,linescore`;
    const url = USE_PROXY ? `${PROXY_BASE}${encodeURIComponent(path)}` : `${API_BASE}${path}`;
    return jsonFetch(url);
  }

  function fetchLiveFeed(gamePk) {
    const path = `/v1.1/game/${gamePk}/feed/live`;
    const url = USE_PROXY ? `${PROXY_BASE}${encodeURIComponent(path)}` : `${API_BASE}${path}`;
    return jsonFetch(url);
  }

  // ============================================
  //  ROUTER (hash-based)
  //   #/                home
  //   #/carousel        carousel
  //   #/game/{gamePk}   single game
  //   #/settings        user settings
  // ============================================

  const Router = {
    current: { name: 'home', params: {} },
    listeners: new Set(),

    parse(hash) {
      const h = (hash || '').replace(/^#\/?/, '');
      if (!h || h === '') return { name: 'home', params: {} };
      const parts = h.split('/');
      if (parts[0] === 'carousel') return { name: 'carousel', params: {} };
      if (parts[0] === 'game' && parts[1]) return { name: 'game', params: { gamePk: parts[1] } };
      if (parts[0] === 'settings') return { name: 'settings', params: {} };
      return { name: 'home', params: {} };
    },

    init() {
      window.addEventListener('hashchange', () => this.handleChange());
      this.handleChange();
    },

    handleChange() {
      this.current = this.parse(window.location.hash);
      this.listeners.forEach(fn => fn(this.current));
    },

    navigate(hash) {
      // Use real navigation so browser back/forward works
      if (window.location.hash !== hash) window.location.hash = hash;
    },

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
  };

  // ============================================
  //  STATS COMPUTATION
  // ============================================

  function deriveTeamStats(teamBoxscore) {
    if (!teamBoxscore) return {};
    const bat = (teamBoxscore.teamStats && teamBoxscore.teamStats.batting) || {};
    const fld = (teamBoxscore.teamStats && teamBoxscore.teamStats.fielding) || {};
    const doubles = num(bat.doubles);
    const triples = num(bat.triples);
    const homeRuns = num(bat.homeRuns);
    return {
      hits: num(bat.hits),
      homeRuns: homeRuns,
      rbi: num(bat.rbi),
      stolenBases: num(bat.stolenBases),
      caughtStealing: num(bat.caughtStealing),
      baseOnBalls: num(bat.baseOnBalls),
      leftOnBase: num(bat.leftOnBase),
      groundIntoDoublePlay: num(bat.groundIntoDoublePlay),
      strikeOuts: num(bat.strikeOuts),
      errors: num(fld.errors),
      xbh: doubles + triples + homeRuns,
      totalBases: (num(bat.hits) - doubles - triples - homeRuns) + (doubles * 2) + (triples * 3) + (homeRuns * 4)
    };
  }
  function num(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }

  // ============================================
  //  SVG COMPONENTS
  // ============================================

  function diamondSvg({ size, runners = {}, opts = {} }) {
    // runners: { first: bool, second: bool, third: bool }
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.classList.add('diamond');

    const baseSize = opts.baseSize || 16;
    const cx = 50, cy = 50;
    // Base centers - rotate diamond so home is at bottom, second at top
    const positions = {
      home: { x: cx, y: 88 },
      first: { x: 82, y: cy },
      second: { x: cx, y: 12 },
      third: { x: 18, y: cy }
    };

    // Connect lines
    const linePath = document.createElementNS(NS, 'path');
    linePath.setAttribute('d', `M ${positions.home.x} ${positions.home.y}
                                L ${positions.first.x} ${positions.first.y}
                                L ${positions.second.x} ${positions.second.y}
                                L ${positions.third.x} ${positions.third.y} Z`);
    linePath.setAttribute('fill', 'none');
    linePath.setAttribute('stroke', 'rgba(255,255,255,0.08)');
    linePath.setAttribute('stroke-width', '1');
    svg.appendChild(linePath);

    // Bases (diamond rotated squares)
    const bases = ['first', 'second', 'third'];
    bases.forEach(name => {
      const pos = positions[name];
      const occupied = !!runners[name];
      const rect = document.createElementNS(NS, 'rect');
      const half = baseSize / 2;
      rect.setAttribute('x', String(pos.x - half));
      rect.setAttribute('y', String(pos.y - half));
      rect.setAttribute('width', String(baseSize));
      rect.setAttribute('height', String(baseSize));
      rect.setAttribute('transform', `rotate(45 ${pos.x} ${pos.y})`);
      rect.setAttribute('fill', occupied ? 'var(--accent)' : 'transparent');
      rect.setAttribute('stroke', occupied ? 'var(--accent-bright)' : 'rgba(255,255,255,0.25)');
      rect.setAttribute('stroke-width', '1.5');
      if (occupied) {
        rect.setAttribute('filter', 'drop-shadow(0 0 4px var(--accent-glow-strong))');
      }
      svg.appendChild(rect);
    });

    // Home plate (pentagon-ish)
    const hp = document.createElementNS(NS, 'polygon');
    const hx = positions.home.x, hy = positions.home.y;
    hp.setAttribute('points', `${hx-5},${hy-3} ${hx+5},${hy-3} ${hx+5},${hy+2} ${hx},${hy+5} ${hx-5},${hy+2}`);
    hp.setAttribute('fill', 'rgba(255,255,255,0.4)');
    svg.appendChild(hp);

    return svg;
  }

  function strikeZoneSvg({ pitches = [], width = 220, batSide = '' }) {
    const NS = 'http://www.w3.org/2000/svg';
    // Strike zone in MLB pitchData uses px,pz (feet from center of plate, height in feet)
    // Standard zone: x in [-0.83, 0.83], z in [sz_bot, sz_top] (~1.5 to 3.5)
    // Display viewBox: 7 ft wide × 5 ft tall, centered. Wider than the zone so the batter
    // silhouette can sit fully outside the strike zone box.
    const W = 7, H = 5;
    const renderWidth = width * (W / 4); // preserve original strike-zone visual size
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `${-W/2} 0 ${W} ${H}`);
    svg.setAttribute('width', String(renderWidth));
    svg.setAttribute('height', String(renderWidth * H / W));
    svg.setAttribute('class', 'strike-zone');
    // Flip Y so 0 is at bottom
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(0, ${H}) scale(1, -1)`);
    svg.appendChild(g);

    // Background plate area
    const plateRect = document.createElementNS(NS, 'rect');
    plateRect.setAttribute('x', String(-W/2));
    plateRect.setAttribute('y', '0');
    plateRect.setAttribute('width', String(W));
    plateRect.setAttribute('height', String(H));
    plateRect.setAttribute('fill', 'rgba(255,255,255,0.02)');
    plateRect.setAttribute('rx', '0.05');
    g.appendChild(plateRect);

    // Strike zone box (typical: -0.83 to 0.83 horizontally, 1.5 to 3.5 vertically)
    const szLeft = -0.83, szRight = 0.83, szBot = 1.5, szTop = 3.5;
    const sz = document.createElementNS(NS, 'rect');
    sz.setAttribute('x', String(szLeft));
    sz.setAttribute('y', String(szBot));
    sz.setAttribute('width', String(szRight - szLeft));
    sz.setAttribute('height', String(szTop - szBot));
    sz.setAttribute('fill', 'rgba(255,255,255,0.04)');
    sz.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    sz.setAttribute('stroke-width', '0.025');
    g.appendChild(sz);

    // Inner thirds (light grid)
    for (let i = 1; i < 3; i++) {
      const x = szLeft + (szRight - szLeft) * i / 3;
      const v = document.createElementNS(NS, 'line');
      v.setAttribute('x1', x); v.setAttribute('x2', x);
      v.setAttribute('y1', szBot); v.setAttribute('y2', szTop);
      v.setAttribute('stroke', 'rgba(255,255,255,0.08)');
      v.setAttribute('stroke-width', '0.015');
      g.appendChild(v);

      const y = szBot + (szTop - szBot) * i / 3;
      const h = document.createElementNS(NS, 'line');
      h.setAttribute('y1', y); h.setAttribute('y2', y);
      h.setAttribute('x1', szLeft); h.setAttribute('x2', szRight);
      h.setAttribute('stroke', 'rgba(255,255,255,0.08)');
      h.setAttribute('stroke-width', '0.015');
      g.appendChild(h);
    }

    // Plate at bottom (small triangle)
    const plate = document.createElementNS(NS, 'path');
    plate.setAttribute('d', `M ${-0.7} 0 L 0.7 0 L 0.7 0.05 L 0 0.18 L ${-0.7} 0.05 Z`);
    plate.setAttribute('fill', 'rgba(255,255,255,0.35)');
    g.appendChild(plate);

    // Batter silhouette (drawn from the pitcher's perspective, matching the flipped pitch coords).
    // The uploaded batter.svg faces left; that orientation = RHB.
    // For LHB we mirror horizontally so the figure faces right.
    const code = String(batSide || '').toUpperCase();
    if ((code === 'L' || code === 'R') && batterPathData) {
      // Parse viewBox (e.g. "0 0 960 1914") to know native dimensions
      const vbParts = batterViewBox.split(/\s+/).map(Number);
      const vbW = vbParts[2] || 960;
      const vbH = vbParts[3] || 1914;
      const aspect = vbW / vbH;
      // Figure is as tall as the whole viewBox (5 ft), positioned with the base just
      // slightly above the bottom of the box (feet at z≈0.15).
      // Figure spans z ∈ [0.15, 5.15]; top clips at z=5.
      const imgHeight = H; // 5 ft
      const imgWidth = imgHeight * aspect; // ~2.51 ft for 960×1914
      const baseZ = 0.15;
      // Image rendered top-down, so y attr = screen-y of figure's top edge:
      // top of figure in zone-coords = baseZ + imgHeight; screen-y = H - that.
      const imageY = H - (baseZ + imgHeight); // = -0.15
      // Anchor figure flush outside the strike zone box (zone right edge at x=0.83, gap 0.05).
      //   RHB → figure x ∈ [0.88, 0.88 + imgWidth]
      //   LHB → figure x ∈ [-0.88 - imgWidth, -0.88]
      const sign = code === 'R' ? 1 : -1;
      const innerEdge = 0.88;

      // Scale factors: convert source SVG coords to viewBox feet
      const sx = imgWidth / vbW;
      const sy = imgHeight / vbH;

      const sil = document.createElementNS(NS, 'g');
      sil.setAttribute('class', 'batter-silhouette');
      sil.setAttribute('opacity', '0.32');

      // Composition (RHB):
      //   path is in source-space, possibly with batterPathTransform pre-applied (innermost).
      //   After source transform, path lies in [0, vbW] × [0, vbH].
      //   scale(sx, sy) → [0, imgWidth] × [0, imgHeight]
      //   translate(innerEdge, imageY) → [innerEdge, innerEdge + imgWidth] × [imageY, imageY + imgHeight]
      // For LHB: mirror horizontally with scale(-sx, sy), then translate.
      //   After scale(-sx, sy): [-imgWidth, 0] × [0, imgHeight]
      //   translate(-innerEdge, imageY) → [-innerEdge - imgWidth, -innerEdge] × [imageY, imageY + imgHeight]
      const tx = sign === 1 ? innerEdge : -innerEdge;
      const scaleX = sign * sx;
      const transforms = [
        `translate(${tx}, ${imageY})`,
        `scale(${scaleX}, ${sy})`
      ];
      if (batterPathTransform) transforms.push(batterPathTransform);
      sil.setAttribute('transform', transforms.join(' '));

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', batterPathData);
      path.setAttribute('fill', 'rgba(255,255,255,0.95)');
      path.setAttribute('stroke', 'none');
      sil.appendChild(path);

      // Insert behind the flipped g so the silhouette renders behind any zone overlays
      svg.insertBefore(sil, svg.firstChild);
    }

    // Pitches
    pitches.forEach((p, idx) => {
      if (p.x == null || p.z == null) return;
      const fillByType = {
        ball: 'var(--ball)',
        strike: 'var(--strike)',
        inplay: 'var(--inplay)'
      }[p.type] || 'var(--text-fade)';

      // Horizontal flip: mirror around x=0 so left side of zone shows on the right
      const fx = -p.x;

      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(fx));
      c.setAttribute('cy', String(p.z));
      c.setAttribute('r', '0.18');
      c.setAttribute('fill', fillByType);
      c.setAttribute('stroke', 'rgba(0,0,0,0.5)');
      c.setAttribute('stroke-width', '0.02');
      g.appendChild(c);
      // Number
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', String(fx));
      t.setAttribute('y', String(p.z));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('font-size', '0.18');
      t.setAttribute('font-family', 'JetBrains Mono, monospace');
      t.setAttribute('font-weight', '700');
      t.setAttribute('fill', '#0a0a12');
      t.setAttribute('transform', `translate(${fx}, ${p.z}) scale(1, -1) translate(${-fx}, ${-p.z})`);
      t.textContent = String(p.num);
      g.appendChild(t);
    });

    return svg;
  }

  function outsIndicator(outs) {
    const wrap = el('div', { class: 'outs-indicator' });
    for (let i = 0; i < 3; i++) {
      wrap.appendChild(el('div', { class: 'out-dot' + (i < outs ? ' active' : '') }));
    }
    return wrap;
  }

  // ============================================
  //  HOME PAGE
  // ============================================

  const HomeView = (() => {
    let scheduleData = null;
    let liveScoreCache = {}; // gamePk -> { score, inning } from schedule (for live updates without buffer)
    let currentDate = todayET();
    let pollTimer = null;
    let liveGamePolls = {}; // gamePk -> intervalId for live updates
    let liveGameData = {}; // gamePk -> { home, away, inning, half }
    let mounted = false;

    function render(root) {
      mounted = true;
      clear(root);
      const page = el('div', { class: 'home fade-in' });

      // Header (date selector only — no titles per spec)
      const header = el('div', { class: 'home-header' });
      const selector = el('div', { class: 'date-selector' });
      const left = el('button', {
        class: 'date-arrow',
        'aria-label': 'Previous day',
        onclick: () => changeDate(addDaysET(currentDate, -1))
      }, '‹');
      const right = el('button', {
        class: 'date-arrow',
        'aria-label': 'Next day',
        onclick: () => changeDate(addDaysET(currentDate, 1))
      }, '›');

      const dateInput = el('input', {
        type: 'date',
        class: 'date-input-hidden',
        value: currentDate
      });
      dateInput.addEventListener('change', (ev) => {
        if (ev.target.value) changeDate(ev.target.value);
      });
      const display = el('div', { class: 'date-display', onclick: () => dateInput.showPicker ? dateInput.showPicker() : dateInput.click() },
        el('div', { class: 'date-display-day' }, prettyDate(currentDate)),
        el('div', { class: 'date-display-tz' }, 'Eastern Time')
      );

      selector.appendChild(left);
      selector.appendChild(display);
      selector.appendChild(right);
      selector.appendChild(dateInput);
      header.appendChild(selector);
      page.appendChild(header);

      // Games grid
      const grid = el('div', { class: 'games-grid', id: 'games-grid' });
      page.appendChild(grid);

      // Footer
      const footer = el('div', { class: 'home-footer' });
      footer.appendChild(el('div', {}, el('span', { class: 'powered' }, 'Powered by Orioles Magic')));
      footer.appendChild(el('div', {}, 'Made by Harvey @hxoxcx for Orioles BirdWatcher'));
      footer.appendChild(el('div', { class: 'home-footer-attrib' },
        el('a', {
          href: 'https://www.flaticon.com/free-icons/binoculars',
          title: 'binoculars icons',
          target: '_blank',
          rel: 'noopener noreferrer'
        }, 'Binocular icon created by Gregor Cresnar - Flaticon')
      ));
      page.appendChild(footer);

      root.appendChild(page);

      renderGrid();
      startPolling();
    }

    function renderGrid() {
      const grid = $('#games-grid');
      if (!grid) return;
      clear(grid);

      // Carousel card always first
      const carouselCard = el('div', {
        class: 'game-card carousel-card',
        onclick: () => Router.navigate('#/carousel')
      });
      carouselCard.appendChild(el('div', { class: 'carousel-card-text' }, 'Carousel'));
      carouselCard.appendChild(el('div', { class: 'carousel-card-sub' }, 'all games · live'));
      grid.appendChild(carouselCard);

      const games = (scheduleData && scheduleData.dates && scheduleData.dates[0]) ?
        scheduleData.dates[0].games : [];

      // Sort by start time
      const sorted = games.slice().sort((a, b) =>
        new Date(a.gameDate || 0) - new Date(b.gameDate || 0));

      if (sorted.length === 0) {
        grid.appendChild(el('div', { class: 'no-games' }, `No games scheduled for ${prettyDate(currentDate)}`));
      } else {
        sorted.forEach(g => grid.appendChild(renderGameCard(g)));
      }

      // Settings card always last
      const settingsCard = el('div', {
        class: 'game-card settings-card',
        onclick: () => Router.navigate('#/settings')
      });
      // Gear icon (inline SVG so we don't need an asset)
      settingsCard.appendChild(el('div', { class: 'settings-card-icon', html:
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
      }));
      settingsCard.appendChild(el('div', { class: 'carousel-card-text' }, 'Settings'));
      settingsCard.appendChild(el('div', { class: 'carousel-card-sub' }, 'buffer · accent color'));
      grid.appendChild(settingsCard);
    }

    function renderGameCard(game) {
      const home = game.teams && game.teams.home;
      const away = game.teams && game.teams.away;
      if (!home || !away) return el('div');

      const status = (game.status && game.status.abstractGameState) || 'Preview'; // Preview / Live / Final
      const detailedState = (game.status && game.status.detailedState) || '';
      const live = liveGameData[game.gamePk];

      const isLive = status === 'Live' || detailedState === 'In Progress' || detailedState === 'Manager challenge' || detailedState === 'Warmup';
      const isFinal = status === 'Final' || detailedState.includes('Final') || detailedState === 'Game Over' || detailedState === 'Completed Early';

      const card = el('div', {
        class: 'game-card' + (isLive ? ' live' : ''),
        onclick: () => Router.navigate(`#/game/${game.gamePk}`)
      });

      const teamsRow = el('div', { class: 'game-card-teams' });

      // Away team (left)
      const awayColor = teamColor(away.team.id, 'primary');
      const awayBox = el('div', {
        class: 'gc-team gc-team-away',
        style: { '--team-color': awayColor, '--team-rgb': hexToRgbCsv(awayColor) }
      });
      awayBox.appendChild(teamLogoEl(away.team.id, { alt: away.team.name || '' }));
      awayBox.appendChild(el('div', { class: 'gc-team-abbrev' }, getAbbrev(away.team)));
      if (away.leagueRecord) {
        awayBox.appendChild(el('div', { class: 'gc-team-record' },
          `${away.leagueRecord.wins}-${away.leagueRecord.losses}`));
      }

      // Compute scores once (used by both the score row and the FINAL status text)
      const awayR = (live && live.away != null) ? live.away :
        (away.score != null ? away.score : (game.linescore && game.linescore.teams && game.linescore.teams.away && game.linescore.teams.away.runs) || 0);
      const homeR = (live && live.home != null) ? live.home :
        (home.score != null ? home.score : (game.linescore && game.linescore.teams && game.linescore.teams.home && game.linescore.teams.home.runs) || 0);

      // Score / vs
      let middleEl;
      if (isLive || isFinal) {
        middleEl = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('div', { class: 'gc-score' }, String(awayR)),
          el('div', { class: 'gc-vs' }, '–'),
          el('div', { class: 'gc-score' }, String(homeR))
        );
      } else {
        middleEl = el('div', { class: 'gc-vs' }, '@');
      }

      // Home team (right)
      const homeColor = teamColor(home.team.id, 'primary');
      const homeBox = el('div', {
        class: 'gc-team gc-team-home',
        style: { '--team-color': homeColor, '--team-rgb': hexToRgbCsv(homeColor) }
      });
      homeBox.appendChild(teamLogoEl(home.team.id, { alt: home.team.name || '' }));
      homeBox.appendChild(el('div', { class: 'gc-team-abbrev' }, getAbbrev(home.team)));
      if (home.leagueRecord) {
        homeBox.appendChild(el('div', { class: 'gc-team-record' },
          `${home.leagueRecord.wins}-${home.leagueRecord.losses}`));
      }

      teamsRow.appendChild(awayBox);
      teamsRow.appendChild(middleEl);
      teamsRow.appendChild(homeBox);
      card.appendChild(teamsRow);

      // Status row
      const statusEl = el('div', { class: 'gc-status' });
      if (isLive) {
        const ls = (live && live.inningOrdinal) ? live :
                   (game.linescore || { currentInningOrdinal: '', inningHalf: '', currentInning: '' });
        const half = (ls.inningHalf || ls.half || '').toLowerCase();
        const arrow = half === 'top' ? '▲' : (half === 'bottom' ? '▼' : '');
        const inn = ls.inningOrdinal || ls.currentInningOrdinal || ls.currentInning || '';
        statusEl.appendChild(el('div', { class: 'gc-inning' }, `${arrow} ${inn}`.trim()));
      } else if (isFinal) {
        // FINAL — [WINNERS] WIN, with the team's abbreviation tinted in their primary color.
        // Tie games (rare in MLB but possible in spring training/exhibition) just show "FINAL".
        if (awayR > homeR) {
          const winColor = teamColor(away.team.id, 'primary');
          const winAbbrev = (getAbbrev(away.team) || '').toUpperCase();
          statusEl.appendChild(el('div', { class: 'gc-final' },
            'FINAL — ',
            el('span', { class: 'gc-final-winner', style: { color: winColor } }, `${winAbbrev} WIN`)
          ));
        } else if (homeR > awayR) {
          const winColor = teamColor(home.team.id, 'primary');
          const winAbbrev = (getAbbrev(home.team) || '').toUpperCase();
          statusEl.appendChild(el('div', { class: 'gc-final' },
            'FINAL — ',
            el('span', { class: 'gc-final-winner', style: { color: winColor } }, `${winAbbrev} WIN`)
          ));
        } else {
          statusEl.appendChild(el('div', { class: 'gc-final' }, detailedState || 'Final'));
        }
      } else {
        // Scheduled
        const etTime = fmtTime(game.gameDate, ET_TZ);
        const localTime = fmtTime(game.gameDate, localTz());
        const localAbbrev = localTzAbbrev();
        statusEl.appendChild(el('div', { class: 'gc-time' }, `${etTime} ET`));
        if (etTime !== localTime || (localAbbrev !== 'EST' && localAbbrev !== 'EDT')) {
          statusEl.appendChild(el('div', { class: 'gc-time gc-time-local' }, `${localTime} ${localAbbrev}`));
        }
      }
      card.appendChild(statusEl);

      // Spin up live polling for this game (if live, no 80s delay for home)
      if (isLive && !liveGamePolls[game.gamePk]) {
        startLiveGameUpdate(game.gamePk);
      }
      return card;
    }

    function getAbbrev(team) {
      // Use clubName (short) first, fall back to teamName, then abbreviation
      return team.clubName || team.teamName || team.abbreviation || team.name || '';
    }

    function startLiveGameUpdate(gamePk) {
      const update = async () => {
        try {
          const data = await fetchLiveFeed(gamePk);
          const lin = data && data.liveData && data.liveData.linescore;
          if (lin) {
            liveGameData[gamePk] = {
              home: lin.teams && lin.teams.home && lin.teams.home.runs,
              away: lin.teams && lin.teams.away && lin.teams.away.runs,
              inningOrdinal: lin.currentInningOrdinal,
              inningHalf: lin.inningHalf,
              currentInning: lin.currentInning
            };
            if (mounted) renderGrid();
          }
        } catch (e) { console.warn('live update failed', e); }
      };
      update();
      liveGamePolls[gamePk] = setInterval(update, LIVE_FEED_POLL_MS);
    }

    function stopAllLiveGamePolls() {
      Object.values(liveGamePolls).forEach(id => clearInterval(id));
      liveGamePolls = {};
      liveGameData = {};
    }

    function changeDate(newDate) {
      currentDate = newDate;
      stopAllLiveGamePolls();
      scheduleData = null;
      renderGrid();
      // Refresh display
      const dd = $('.date-display-day');
      if (dd) dd.textContent = prettyDate(currentDate);
      const di = document.querySelector('.date-input-hidden');
      if (di) di.value = currentDate;
      loadSchedule();
    }

    async function loadSchedule() {
      try {
        const data = await fetchSchedule(currentDate);
        scheduleData = data;
        if (mounted) renderGrid();
      } catch (e) {
        console.error('schedule load failed', e);
        const grid = $('#games-grid');
        if (grid) {
          // Keep carousel card and add error
          const errEl = el('div', { class: 'no-games' }, 'Could not load schedule. Retrying…');
          grid.appendChild(errEl);
        }
      }
    }

    function startPolling() {
      loadSchedule();
      pollTimer = setInterval(loadSchedule, SCHEDULE_POLL_MS);
    }

    function unmount() {
      mounted = false;
      clearInterval(pollTimer);
      stopAllLiveGamePolls();
    }

    return { render, unmount };
  })();

  // ============================================
  //  CAROUSEL PAGE
  // ============================================

  const CarouselView = (() => {
    let scheduleData = null;
    let feeds = {}; // gamePk -> BufferedFeed
    let games = []; // sorted, only live/upcoming from today
    let currentIdx = 0;
    let rotationTimer = null;
    let stage = null;
    let mounted = false;

    function render(root) {
      mounted = true;
      clear(root);
      const page = el('div', { class: 'carousel-page' });
      stage = el('div', { class: 'carousel-stage' });
      page.appendChild(stage);
      root.appendChild(page);

      const bufSec = Math.round(getBufferMs() / 1000);
      const sub = bufSec === 0 ? 'Loading…' : `Holding ${bufSec} seconds of plays before display`;
      showLoading('Building buffer', sub);
      loadGames();
    }

    function showLoading(text, sub) {
      clear(stage);
      const wrap = el('div', { class: 'loading-screen' });
      wrap.appendChild(el('div', { class: 'loading-spinner' }));
      wrap.appendChild(el('div', { class: 'loading-text' }, text));
      if (sub) wrap.appendChild(el('div', { class: 'loading-sub' }, sub));
      const progress = el('div', { class: 'buffer-progress' });
      const fill = el('div', { class: 'buffer-progress-fill', style: { width: '0%' } });
      progress.appendChild(fill);
      wrap.appendChild(progress);
      stage.appendChild(wrap);
      stage._progressFill = fill;
      stage._loadingSub = wrap.querySelector('.loading-sub');
    }

    async function loadGames() {
      try {
        scheduleData = await fetchSchedule(todayET());
        const allGames = (scheduleData.dates && scheduleData.dates[0] && scheduleData.dates[0].games) || [];

        // Filter: live or completed games (anything with data) + show all games for the day
        // Sort by start time (earliest first)
        games = allGames
          .filter(g => g.gamePk)
          .sort((a, b) => new Date(a.gameDate || 0) - new Date(b.gameDate || 0));

        if (games.length === 0) {
          clear(stage);
          stage.appendChild(el('div', { class: 'loading-screen' },
            el('div', { class: 'loading-text' }, 'No games today'),
            el('div', { class: 'loading-sub' }, 'Check back later')
          ));
          return;
        }

        // Start a buffered feed for each game
        games.forEach(g => {
          if (!feeds[g.gamePk]) {
            const feed = new BufferedFeed(() => fetchLiveFeed(g.gamePk), `game-${g.gamePk}`);
            feed.start();
            feeds[g.gamePk] = feed;
          }
        });

        // Wait for at least one feed to release
        const checkReady = () => {
          if (!mounted) return;
          const anyReady = games.some(g => feeds[g.gamePk] && feeds[g.gamePk].released != null);
          if (anyReady) {
            startCarousel();
          } else {
            // Update progress
            let maxProgress = 0;
            games.forEach(g => {
              const f = feeds[g.gamePk];
              if (f && f.firstFetchAt) {
                const elapsed = Date.now() - f.firstFetchAt;
                const p = Math.min(1, elapsed / getBufferMs());
                if (p > maxProgress) maxProgress = p;
              }
            });
            if (stage && stage._progressFill) {
              stage._progressFill.style.width = `${(maxProgress * 100).toFixed(1)}%`;
            }
            if (stage && stage._loadingSub) {
              const bufSec = Math.round(getBufferMs() / 1000);
              const remaining = Math.ceil(bufSec * (1 - maxProgress));
              stage._loadingSub.textContent = bufSec === 0
                ? 'Loading…'
                : `Holding ${bufSec} seconds of plays · ${remaining}s remaining`;
            }
            setTimeout(checkReady, 250);
          }
        };
        checkReady();
      } catch (e) {
        console.error('Carousel load failed', e);
        clear(stage);
        stage.appendChild(el('div', { class: 'loading-screen' },
          el('div', { class: 'loading-text' }, 'Connection error'),
          el('div', { class: 'loading-sub' }, 'Retrying…')
        ));
        setTimeout(loadGames, 5000);
      }
    }

    function startCarousel() {
      if (!mounted) return;
      clear(stage);
      // Build pager
      const pager = el('div', { class: 'cs-pager' });
      games.forEach((_, i) => pager.appendChild(el('div', { class: 'cs-pager-dot', 'data-i': i })));
      stage.appendChild(pager);

      // Show first slide
      currentIdx = 0;
      showSlide(currentIdx, null);

      // Start rotation
      rotationTimer = setInterval(() => {
        const prev = currentIdx;
        currentIdx = (currentIdx + 1) % games.length;
        showSlide(currentIdx, prev);
      }, CAROUSEL_ROTATION_MS);

      // Subscribe to all feeds — when current slide's feed updates, re-render
      games.forEach((g, idx) => {
        const f = feeds[g.gamePk];
        if (f) {
          f.subscribe(() => {
            if (idx === currentIdx && mounted) {
              showSlide(currentIdx, null, /*refresh*/ true);
            }
          });
        }
      });
    }

    function showSlide(idx, prevIdx, refresh = false) {
      const game = games[idx];
      if (!game) return;
      const data = feeds[game.gamePk] && feeds[game.gamePk].released;

      // Update pager
      Array.from(stage.querySelectorAll('.cs-pager-dot')).forEach((d, i) => {
        d.classList.toggle('active', i === idx);
      });

      const slide = buildSlide(game, data);
      slide.classList.add('carousel-slide');

      if (refresh) {
        // Replace existing active slide quickly without transition
        const existing = stage.querySelector('.carousel-slide.active');
        if (existing) existing.replaceWith(slide);
        slide.classList.add('active');
      } else {
        // Animate in
        const existing = stage.querySelector('.carousel-slide.active');
        stage.appendChild(slide);
        // Trigger reflow then activate
        // eslint-disable-next-line no-unused-expressions
        slide.offsetWidth;
        slide.classList.add('active');

        if (existing) {
          existing.classList.add('exiting');
          existing.classList.remove('active');
          setTimeout(() => { if (existing.parentNode) existing.parentNode.removeChild(existing); }, 800);
        }
      }
    }

    function buildSlide(game, data) {
      const slide = el('div', { class: 'carousel-slide' });
      const home = game.teams.home.team;
      const away = game.teams.away.team;

      let awayName = away.clubName || away.teamName || away.name;
      let homeName = home.clubName || home.teamName || home.name;
      let awayScore = 0, homeScore = 0;
      let inningOrdinal = '', inningHalf = '', outs = 0;
      let runners = {};

      if (data && data.liveData) {
        const ls = data.liveData.linescore;
        if (ls) {
          awayScore = (ls.teams && ls.teams.away && ls.teams.away.runs) || 0;
          homeScore = (ls.teams && ls.teams.home && ls.teams.home.runs) || 0;
          inningOrdinal = ls.currentInningOrdinal || '';
          inningHalf = (ls.inningHalf || '').toLowerCase();
          outs = ls.outs || 0;
          if (ls.offense) {
            runners.first = !!ls.offense.first;
            runners.second = !!ls.offense.second;
            runners.third = !!ls.offense.third;
          }
        }
      } else {
        // Pre-game: just show 0-0, no inning
        const status = data && data.gameData && data.gameData.status;
        if (status && status.detailedState) {
          inningOrdinal = status.detailedState;
        } else {
          inningOrdinal = fmtTime(game.gameDate, ET_TZ) + ' ET';
        }
      }

      // Left: away team (logo + name + score)
      const leftCol = el('div', { class: 'cs-team cs-team-left' });
      leftCol.appendChild(teamLogoEl(away.id, { alt: awayName }));
      leftCol.appendChild(el('div', { class: 'cs-team-name' }, awayName));
      leftCol.appendChild(el('div', { class: 'cs-score' }, String(awayScore)));
      slide.appendChild(leftCol);

      // Center: inning + diamond + outs
      const center = el('div', { class: 'cs-center' });

      const inningArrow = inningHalf === 'top' ? '▲' : (inningHalf === 'bottom' ? '▼' : '');
      center.appendChild(el('div', { class: 'cs-inning-display' },
        inningArrow ? `${inningArrow} ${inningOrdinal}` : inningOrdinal
      ));

      const diamondSize = Math.min(window.innerWidth, window.innerHeight) * 0.22;
      const diamondWrap = el('div', { class: 'cs-diamond-wrap' });
      diamondWrap.appendChild(diamondSvg({ size: Math.max(120, diamondSize), runners, opts: { baseSize: 14 } }));
      diamondWrap.appendChild(outsIndicator(outs));
      center.appendChild(diamondWrap);

      slide.appendChild(center);

      // Right: home team (logo + name + score)
      const rightCol = el('div', { class: 'cs-team cs-team-right' });
      rightCol.appendChild(teamLogoEl(home.id, { alt: homeName }));
      rightCol.appendChild(el('div', { class: 'cs-team-name' }, homeName));
      rightCol.appendChild(el('div', { class: 'cs-score' }, String(homeScore)));
      slide.appendChild(rightCol);

      return slide;
    }

    function unmount() {
      mounted = false;
      clearInterval(rotationTimer);
      Object.values(feeds).forEach(f => f.stop());
      feeds = {};
      games = [];
      stage = null;
    }

    return { render, unmount };
  })();

  // ============================================
  //  GAME PAGE
  // ============================================

  const GameView = (() => {
    let feed = null;
    let gamePk = null;
    let mounted = false;
    let lastBatterId = null;
    let lastInningKey = null;
    let lastModeWasActive = null;
    let rotatingStatIdx = 0;
    let rotatingTimer = null;
    let lastReleasedData = null;

    function render(root, params) {
      mounted = true;
      gamePk = params.gamePk;
      lastBatterId = null;
      lastInningKey = null;
      lastModeWasActive = null;
      rotatingStatIdx = 0;

      clear(root);
      const page = el('div', { class: 'game-page', id: 'game-page' });
      root.appendChild(page);

      showLoading();

      feed = new BufferedFeed(() => fetchLiveFeed(gamePk), `game-${gamePk}`);
      feed.start();

      feed.onProgress((info) => {
        if (info.ready) return; // ready data comes via subscribe()
        // Update loading progress
        const fill = $('.buffer-progress-fill');
        if (fill) fill.style.width = `${(info.progress * 100).toFixed(1)}%`;
        const sub = $('.loading-sub');
        if (sub) {
          const bufSec = Math.round(getBufferMs() / 1000);
          sub.textContent = bufSec === 0
            ? 'Loading…'
            : `Holding ${bufSec} seconds of plays · ${Math.ceil(info.remainingMs / 1000)}s remaining`;
        }
      });

      feed.subscribe((data) => {
        if (mounted) {
          lastReleasedData = data;
          renderGame(data);
        }
      });

      // Rotating stats (every minute)
      rotatingTimer = setInterval(() => {
        rotatingStatIdx = (rotatingStatIdx + 1) % ROTATING_STATS.length;
        if (lastReleasedData && mounted) updateRotatingStats(lastReleasedData);
      }, ROTATING_STAT_INTERVAL_MS);
    }

    function showLoading() {
      const page = $('#game-page');
      if (!page) return;
      clear(page);
      const wrap = el('div', { class: 'loading-screen' });
      wrap.appendChild(el('div', { class: 'loading-spinner' }));
      wrap.appendChild(el('div', { class: 'loading-text' }, 'Building buffer'));
      const bufSec = Math.round(getBufferMs() / 1000);
      const subText = bufSec === 0
        ? 'Loading…'
        : `Holding ${bufSec} seconds of plays before display`;
      wrap.appendChild(el('div', { class: 'loading-sub' }, subText));
      const progress = el('div', { class: 'buffer-progress' });
      progress.appendChild(el('div', { class: 'buffer-progress-fill', style: { width: '0%' } }));
      wrap.appendChild(progress);
      page.appendChild(wrap);
    }

    function renderGame(data) {
      if (!data || !data.gameData) return;
      const page = $('#game-page');
      if (!page) return;

      const gd = data.gameData;
      const ld = data.liveData || {};
      const ls = ld.linescore || {};
      const box = ld.boxscore || {};

      // Determine if first render or update
      const existingScorebug = page.querySelector('.scorebug');
      if (!existingScorebug) {
        clear(page);
        page.appendChild(buildScorebug(gd, ld, ls, box));
        page.appendChild(buildBoxScore(ls, gd));
        page.appendChild(buildPbp(gd, ld, ls, box));
      } else {
        // Update in place to avoid flicker / animation re-trigger
        updateScorebug(page, gd, ld, ls, box);
        updateBoxScore(page, ls, gd);
        updatePbp(page, gd, ld, ls, box);
      }
    }

    // ---------- Scorebug ----------

    function buildScorebug(gd, ld, ls, box) {
      const homeTeam = gd.teams.home;
      const awayTeam = gd.teams.away;
      const awayScore = (ls.teams && ls.teams.away && ls.teams.away.runs) || 0;
      const homeScore = (ls.teams && ls.teams.home && ls.teams.home.runs) || 0;
      const awayRecord = box.teams && box.teams.away && box.teams.away.team && box.teams.away.team.record;
      const homeRecord = box.teams && box.teams.home && box.teams.home.team && box.teams.home.team.record;

      const awayColorPrimary = teamColor(awayTeam.id, 'primary');
      const homeColorPrimary = teamColor(homeTeam.id, 'primary');
      const sb = el('div', {
        class: 'scorebug',
        style: {
          '--away-team-rgb': hexToRgbCsv(awayColorPrimary),
          '--home-team-rgb': hexToRgbCsv(homeColorPrimary)
        }
      });

      sb.appendChild(buildSbTeam('away', awayTeam, awayScore, awayRecord, box));
      sb.appendChild(buildSbCenter(ls, gd));
      sb.appendChild(buildSbTeam('home', homeTeam, homeScore, homeRecord, box));
      return sb;
    }

    function buildSbTeam(side, team, score, record, box) {
      const wrap = el('div', { class: `sb-team ${side}` });

      const logoEl = teamLogoEl(team.id, { className: 'sb-logo', alt: team.name });

      const info = el('div', { class: 'sb-info' });
      info.appendChild(el('div', { class: 'sb-name' }, team.clubName || team.teamName || team.name));
      const recStr = record ? `${record.wins || 0}-${record.losses || 0}` : '';
      info.appendChild(el('div', { class: 'sb-record' }, recStr));
      const teamBoxKey = side; // 'away' or 'home'
      const teamBox = box.teams && box.teams[teamBoxKey];
      const stats = deriveTeamStats(teamBox);
      const rotStat = ROTATING_STATS[rotatingStatIdx];
      info.appendChild(el('div', { class: `sb-rotating`, 'data-side': side },
        el('div', { class: 'sb-rotating-label' }, rotStat.label),
        el('div', { class: 'sb-rotating-value' }, String(stats[rotStat.key] != null ? stats[rotStat.key] : 0))
      ));

      const scoreEl = el('div', { class: 'sb-score' }, String(score));

      // Order for grid columns:
      //   away: [logo, info, score]   (logo at page edge, score at diamond)
      //   home: [score, info, logo]   (score at diamond, logo at page edge)
      if (side === 'away') {
        wrap.appendChild(logoEl);
        wrap.appendChild(info);
        wrap.appendChild(scoreEl);
      } else {
        wrap.appendChild(scoreEl);
        wrap.appendChild(info);
        wrap.appendChild(logoEl);
      }
      return wrap;
    }

    function buildSbCenter(ls, gd) {
      const center = el('div', { class: 'sb-center' });
      const isFinal = isFinalMode(gd);
      const runners = isFinal ? { first: false, second: false, third: false } : {
        first: !!(ls.offense && ls.offense.first),
        second: !!(ls.offense && ls.offense.second),
        third: !!(ls.offense && ls.offense.third)
      };
      const outs = isFinal ? 0 : (ls.outs || 0);
      const half = (ls.inningHalf || '').toLowerCase();
      const inn = ls.currentInning || '';

      const diamondHolder = el('div', { style: { position: 'relative' } });
      diamondHolder.appendChild(diamondSvg({ size: 88, runners, opts: { baseSize: 12 } }));

      const innInside = el('div', { class: 'sb-diamond-inning' });
      if (isFinal) {
        innInside.appendChild(el('div', { class: 'sb-final-label' }, 'Final'));
      } else {
        if (half) {
          innInside.appendChild(el('div', { class: `sb-inning-arrow ${half === 'top' ? 'top' : ''}` }));
        }
        innInside.appendChild(el('div', { class: 'sb-inning-num' }, String(inn || '-')));
        if (half === 'bottom') {
          innInside.appendChild(el('div', { class: 'sb-inning-arrow bottom' }));
        }
      }
      diamondHolder.appendChild(innInside);

      center.appendChild(diamondHolder);
      if (!isFinal) {
        center.appendChild(outsIndicator(outs));
      }
      return center;
    }

    function updateScorebug(page, gd, ld, ls, box) {
      const sb = page.querySelector('.scorebug');
      if (!sb) return;
      const newSb = buildScorebug(gd, ld, ls, box);
      sb.replaceWith(newSb);
    }

    function updateRotatingStats(data) {
      const ld = data.liveData || {};
      const box = ld.boxscore || {};
      const rotStat = ROTATING_STATS[rotatingStatIdx];

      ['away', 'home'].forEach(side => {
        const wrap = document.querySelector(`.sb-rotating[data-side="${side}"]`);
        if (!wrap) return;
        const teamBox = box.teams && box.teams[side];
        const stats = deriveTeamStats(teamBox);
        const labelEl = wrap.querySelector('.sb-rotating-label');
        const valEl = wrap.querySelector('.sb-rotating-value');
        if (labelEl) labelEl.textContent = rotStat.label;
        if (valEl) valEl.textContent = String(stats[rotStat.key] != null ? stats[rotStat.key] : 0);
        wrap.classList.remove('fade');
        // Force reflow
        // eslint-disable-next-line no-unused-expressions
        wrap.offsetWidth;
        wrap.classList.add('fade');
      });
    }

    // ---------- Box score ----------

    function buildBoxScore(ls, gd) {
      const wrap = el('div', { class: 'box-score' });
      const innings = ls.innings || [];
      const currentInning = ls.currentInning || 0;
      const awayTeam = gd && gd.teams && gd.teams.away ? gd.teams.away : {};
      const homeTeam = gd && gd.teams && gd.teams.home ? gd.teams.home : {};

      // Determine how many inning columns to show (at least 9, more if extras)
      let maxInning = 9;
      innings.forEach(x => { if (x.num > maxInning) maxInning = x.num; });

      const inningsToShow = [];
      for (let i = 1; i <= maxInning; i++) inningsToShow.push(i);

      const table = el('div', { class: 'box-score-table' });
      table.style.gridTemplateColumns = `auto repeat(${maxInning}, minmax(40px, 1fr))`;

      // ---- Header row: blank corner | inning numbers ----
      table.appendChild(el('div', { class: 'bs-corner' }));
      inningsToShow.forEach(i => {
        const isCurrent = i === currentInning;
        table.appendChild(el('div', { class: `bs-header-inning${isCurrent ? ' current' : ''}` }, String(i)));
      });

      // ---- Helper to build a team row ----
      function buildRow(side, team) {
        const labelCell = el('div', { class: `bs-label bs-label-${side}` });
        labelCell.appendChild(teamLogoEl(team.id, { className: 'bs-label-logo', alt: team.name || '' }));
        labelCell.appendChild(el('span', { class: 'bs-label-abbrev' }, team.abbreviation || team.teamCode || (team.name || '').slice(0, 3).toUpperCase()));
        table.appendChild(labelCell);

        inningsToShow.forEach(i => {
          const innData = innings.find(x => x.num === i);
          let runs = null;
          if (innData && innData[side] && innData[side].runs != null) {
            runs = innData[side].runs;
          }
          const classes = ['bs-runs'];
          if (i === currentInning) classes.push('current');
          if (runs != null && runs > 0) classes.push('has-runs');
          else if (runs == null) classes.push('empty');
          const display = runs == null ? '·' : String(runs);
          table.appendChild(el('div', { class: classes.join(' ') }, display));
        });
      }

      buildRow('away', awayTeam);
      buildRow('home', homeTeam);

      wrap.appendChild(table);
      return wrap;
    }

    function updateBoxScore(page, ls, gd) {
      const existing = page.querySelector('.box-score');
      if (!existing) return;
      existing.replaceWith(buildBoxScore(ls, gd));
    }

    // ---------- Play-by-play ----------

    function buildPbp(gd, ld, ls, box) {
      const wrap = el('div', { class: 'pbp' });
      const card = buildPbpCard(gd, ld, ls, box);
      wrap.appendChild(card);
      return wrap;
    }

    function updatePbp(page, gd, ld, ls, box) {
      const existing = page.querySelector('.pbp');
      if (!existing) return;
      const existingCard = existing.querySelector('.pbp-card');

      // Final state is terminal — once we're rendering it, skip subsequent rebuilds.
      // This prevents the fade animation re-playing on every poll.
      if (existingCard && existingCard.classList.contains('pbp-final') && isFinalMode(gd)) {
        return;
      }

      const newCard = buildPbpCard(gd, ld, ls, box);

      // Detect mode change for fade transition
      const wasActive = lastModeWasActive;
      const nowActive = newCard.classList.contains('pbp-active');

      const oldBatter = lastBatterId;
      const oldInning = lastInningKey;

      if (existingCard) existingCard.replaceWith(newCard);
      else existing.appendChild(newCard);

      // Trigger fade only if mode changed OR batter changed OR inning half changed
      const newBatterId = newCard.dataset.batterId || null;
      const newInningKey = newCard.dataset.inningKey || null;
      const changed =
        wasActive !== nowActive ||
        oldBatter !== newBatterId ||
        oldInning !== newInningKey;

      if (changed) {
        const sections = newCard.querySelectorAll('.pbp-section');
        sections.forEach(s => {
          s.classList.remove('fade');
          // eslint-disable-next-line no-unused-expressions
          s.offsetWidth;
          s.classList.add('fade');
        });
      }

      lastModeWasActive = nowActive;
      lastBatterId = newBatterId;
      lastInningKey = newInningKey;
    }

    function getInningKey(ls) {
      return `${ls.currentInning || 0}-${ls.inningHalf || ''}`;
    }

    function isFinalMode(gd) {
      const status = (gd && gd.status) || {};
      const abstract = (status.abstractGameState || '').toLowerCase();
      const detailed = (status.detailedState || '').toLowerCase();
      return abstract === 'final' || detailed === 'final' || detailed === 'game over' || detailed === 'completed early';
    }

    function isPreGameMode(gd) {
      const status = (gd && gd.status) || {};
      const abstract = (status.abstractGameState || '').toLowerCase();
      const detailed = (status.detailedState || '').toLowerCase();
      // Pre-game: scheduled, pre-game, warmup, delayed start, postponed
      return abstract === 'preview' ||
             detailed === 'scheduled' ||
             detailed === 'pre-game' ||
             detailed === 'warmup' ||
             detailed.includes('delayed start') ||
             detailed === 'postponed';
    }

    function isInactiveMode(ls, ld) {
      // Inactive: end of half-inning. Heuristic: inningState is "End" or "Middle"
      const state = (ls.inningState || '').toLowerCase();
      return state === 'end' || state === 'middle' || ld.plays && ld.plays.currentPlay && ld.plays.currentPlay.about && ld.plays.currentPlay.about.isComplete && (ls.outs === 3);
    }

    function buildPbpCard(gd, ld, ls, box) {
      const final = isFinalMode(gd);
      const pregame = !final && isPreGameMode(gd);
      const inactive = !final && !pregame && isInactiveMode(ls, ld);
      const mode = final ? 'final' : (pregame ? 'pregame' : (inactive ? 'inactive' : 'active'));
      const cardProps = { class: `pbp-card pbp-${mode}` };

      if (final) {
        // Determine the winning team and embed their primary color as a CSS var
        const aR = (ls.teams && ls.teams.away && ls.teams.away.runs) || 0;
        const hR = (ls.teams && ls.teams.home && ls.teams.home.runs) || 0;
        const winnerTeam = aR > hR ? (gd.teams && gd.teams.away) :
                           hR > aR ? (gd.teams && gd.teams.home) : null;
        if (winnerTeam && winnerTeam.id) {
          const winColor = teamColor(winnerTeam.id, 'primary');
          cardProps.style = { '--winner-team-rgb': hexToRgbCsv(winColor) };
        }
      }

      const card = el('div', cardProps);

      if (final) {
        const content = buildFinalPbp(gd, ld, ls, box);
        card.appendChild(content);
        card.dataset.batterId = '';
        card.dataset.inningKey = 'final';
      } else if (pregame) {
        const content = buildPreGamePbp(gd, ld, ls, box);
        card.appendChild(content);
        card.dataset.batterId = '';
        card.dataset.inningKey = 'pregame';
      } else if (inactive) {
        const { left, right } = buildInactivePbp(gd, ld, ls, box);
        card.appendChild(left);
        card.appendChild(el('div', { class: 'pbp-divider' }));
        card.appendChild(right);
        card.dataset.batterId = '';
        card.dataset.inningKey = getInningKey(ls);
      } else {
        const { left, right, batterId } = buildActivePbp(gd, ld, ls, box);
        card.appendChild(left);
        card.appendChild(el('div', { class: 'pbp-divider' }));
        card.appendChild(right);
        card.dataset.batterId = String(batterId || '');
        card.dataset.inningKey = getInningKey(ls);
      }
      return card;
    }

    function buildActivePbp(gd, ld, ls, box) {
      // Active mode: hitter on left, pitcher on right
      const half = (ls.inningHalf || 'Top').toLowerCase();
      const battingTeamSide = half === 'top' ? 'away' : 'home';
      const pitchingTeamSide = half === 'top' ? 'home' : 'away';

      const battingTeam = gd.teams[battingTeamSide];
      const pitchingTeam = gd.teams[pitchingTeamSide];

      const offense = ls.offense || {};
      const defense = ls.defense || {};

      const batter = offense.batter; // { id, fullName, ... }
      const onDeck = offense.onDeck;
      const pitcher = defense.pitcher;

      const currentPlay = (ld.plays && ld.plays.currentPlay) || null;

      // Batter stats this game from boxscore
      const batterGameStats = getBatterGameStats(box, battingTeamSide, batter && batter.id);
      const batterSeason = getBatterSeasonAvg(box, battingTeamSide, batter && batter.id);

      // Pitcher stats this game
      const pitcherGameStats = getPitcherGameStats(box, pitchingTeamSide, pitcher && pitcher.id);

      // Pitches in current at-bat
      const pitches = extractCurrentAtBatPitches(currentPlay);

      // Batter handedness from current play matchup; 'L', 'R', or 'S' (switch)
      const matchup = (currentPlay && currentPlay.matchup) || {};
      const batSide = (matchup.batSide && matchup.batSide.code) || '';

      // Current count (balls/strikes) — pull from currentPlay.count, fall back to linescore
      let balls = 0, strikes = 0;
      if (currentPlay && currentPlay.count) {
        balls = typeof currentPlay.count.balls === 'number' ? currentPlay.count.balls : 0;
        strikes = typeof currentPlay.count.strikes === 'number' ? currentPlay.count.strikes : 0;
      } else if (ls && typeof ls.balls === 'number') {
        balls = ls.balls;
        strikes = ls.strikes || 0;
      }
      // Cap displayed values
      balls = Math.max(0, Math.min(4, balls));
      strikes = Math.max(0, Math.min(3, strikes));

      // ----- LEFT (batter) -----
      const left = el('div', { class: 'pbp-section' });
      left.appendChild(buildPbpHeader(battingTeam, batter ? batter.fullName : '—', 'Now batting', batter && batter.id));

      const batterStatsRow = el('div', { class: 'pbp-stats-row' });
      batterStatsRow.appendChild(stat('Game', `${batterGameStats.hits} for ${batterGameStats.atBats}`));
      batterStatsRow.appendChild(stat('Avg', batterSeason));
      batterStatsRow.appendChild(buildCountIndicator(balls, strikes));
      left.appendChild(batterStatsRow);

      // Strike zone
      const szWrap = el('div', { class: 'strike-zone-wrap' });
      szWrap.appendChild(strikeZoneSvg({ pitches, width: 220, batSide }));
      left.appendChild(szWrap);

      // Next batter
      if (onDeck) {
        const onDeckGameStats = getBatterGameStats(box, battingTeamSide, onDeck.id);
        const next = el('div', { class: 'pbp-next-batter' });
        const onDeckPhoto = el('img', {
          class: 'pbp-next-photo',
          src: PLAYER_HEADSHOT_URL(onDeck.id, 90),
          alt: onDeck.fullName,
          onerror: function () { this.style.opacity = '0.3'; }
        });
        next.appendChild(onDeckPhoto);
        const nextText = el('div', { class: 'pbp-next-text' });
        nextText.appendChild(el('div', { class: 'pbp-next-label' }, 'On deck'));
        nextText.appendChild(el('div', { class: 'pbp-next-name' }, onDeck.fullName));
        nextText.appendChild(el('div', { class: 'pbp-next-record' }, `${onDeckGameStats.hits} for ${onDeckGameStats.atBats}`));
        next.appendChild(nextText);
        left.appendChild(next);
      }

      // ----- RIGHT (pitcher) -----
      const right = el('div', { class: 'pbp-section' });
      right.appendChild(buildPbpHeader(pitchingTeam, pitcher ? pitcher.fullName : '—', 'Pitching', pitcher && pitcher.id));

      const pitcherStatsRow = el('div', { class: 'pbp-stats-row' });
      pitcherStatsRow.appendChild(stat('IP', pitcherGameStats.ip));
      pitcherStatsRow.appendChild(stat('K', String(pitcherGameStats.k)));
      pitcherStatsRow.appendChild(stat('OB', String(pitcherGameStats.ob)));
      right.appendChild(pitcherStatsRow);

      // Pitch sequence
      const seq = el('div', { class: 'pitch-seq' });
      seq.appendChild(el('div', { class: 'pitch-seq-title' }, 'Pitch Sequence'));
      if (pitches.length === 0) {
        seq.appendChild(el('div', { class: 'pbp-empty' }, 'No pitches yet'));
      } else {
        pitches.forEach(p => {
          seq.appendChild(buildPitchRow(p));
        });
      }
      right.appendChild(seq);

      return { left, right, batterId: batter && batter.id };
    }

    function buildInactivePbp(gd, ld, ls, box) {
      // Inactive: next half inning. Show next batting team's lineup (next 3) on left, current/next pitcher on right.
      const currentHalf = (ls.inningHalf || '').toLowerCase();
      // After top -> bottom; after bottom -> next inning's top
      const nextHalf = currentHalf === 'top' ? 'bottom' : 'top';
      const nextBattingSide = nextHalf === 'top' ? 'away' : 'home';
      const nextPitchingSide = nextHalf === 'top' ? 'home' : 'away';

      const battingTeam = gd.teams[nextBattingSide];
      const pitchingTeam = gd.teams[nextPitchingSide];

      // Determine next 3 batters: use battingOrder + lineup position
      const next3 = getNextThreeBatters(box, ld, ls, nextBattingSide);

      // Current pitcher = current defense.pitcher OR next inning's pitcher (we don't know, use current)
      const pitcher = (ls.defense && ls.defense.pitcher) || null;
      // If next half inning is on the other team, the current ls.defense is current pitching team — that's the previous side. 
      // For inactive mode, use the pitcher of the team that will pitch next.
      const pitcherFromBox = getCurrentPitcher(box, nextPitchingSide);
      const finalPitcher = pitcherFromBox || pitcher;

      const left = el('div', { class: 'pbp-section' });
      left.appendChild(buildPbpHeader(battingTeam, battingTeam.clubName || battingTeam.teamName, 'Up next'));
      const lineup = el('div', { class: 'lineup-list' });
      if (next3.length === 0) {
        lineup.appendChild(el('div', { class: 'pbp-empty' }, 'Lineup unavailable'));
      } else {
        next3.forEach(b => {
          const row = el('div', { class: 'lineup-row' });
          const photo = el('img', {
            class: 'lineup-photo',
            src: PLAYER_HEADSHOT_URL(b.id, 90),
            alt: b.name,
            onerror: function () { this.style.opacity = '0.3'; }
          });
          row.appendChild(photo);
          row.appendChild(el('span', { class: 'name' }, b.name));
          row.appendChild(el('span', { class: 'rec' }, `${b.hits} for ${b.atBats}`));
          lineup.appendChild(row);
        });
      }
      left.appendChild(lineup);

      const right = el('div', { class: 'pbp-section' });
      right.appendChild(buildPbpHeader(pitchingTeam, finalPitcher ? finalPitcher.name : '—', 'Pitching', finalPitcher && finalPitcher.id));
      const stats = finalPitcher ? finalPitcher.stats : null;
      if (stats) {
        const statsRow = el('div', { class: 'pbp-stats-row' });
        statsRow.appendChild(stat('Pitches', String(stats.pitches || 0)));
        statsRow.appendChild(stat('K', String(stats.k || 0)));
        statsRow.appendChild(stat('H', String(stats.h || 0)));
        statsRow.appendChild(stat('BB', String(stats.bb || 0)));
        statsRow.appendChild(stat('ER', String(stats.er || 0)));
        statsRow.appendChild(stat('HR', String(stats.hr || 0)));
        right.appendChild(statsRow);
      } else {
        right.appendChild(el('div', { class: 'pbp-empty' }, 'Pitcher data unavailable'));
      }

      return { left, right };
    }

    function buildPreGamePbp(gd, ld, ls, box) {
      // Pre-game: scheduled start with countdown, probable pitchers, team records, venue.
      const wrap = el('div', { class: 'pbp-pregame-content' });

      const awayTeam = (gd.teams && gd.teams.away) || {};
      const homeTeam = (gd.teams && gd.teams.home) || {};
      const status = (gd.status && gd.status.detailedState) || 'Scheduled';
      const gameDate = gd.datetime && gd.datetime.dateTime;

      // Stadium backdrop using the home team's venue image (if known).
      const stadiumUrl = stadiumImage(homeTeam.id);
      if (stadiumUrl) {
        wrap.appendChild(el('div', {
          class: 'pbp-pregame-stadium',
          style: { backgroundImage: `url("${stadiumUrl}")` },
          'aria-hidden': 'true'
        }));
      }

      // ---- Top banner: status + countdown / time ----
      const banner = el('div', { class: 'pbp-pregame-banner' });
      banner.appendChild(el('div', { class: 'pbp-pregame-status' }, status));

      if (gameDate) {
        const target = new Date(gameDate);
        const tzAbbrev = localTzAbbrev();
        const localTime = fmtTime(gameDate, localTz());
        const etTime = fmtTime(gameDate, ET_TZ);

        const timeRow = el('div', { class: 'pbp-pregame-time' });
        timeRow.appendChild(el('div', { class: 'pbp-pregame-time-main' }, `${localTime} ${tzAbbrev}`));
        if (localTime !== etTime || (tzAbbrev !== 'EST' && tzAbbrev !== 'EDT')) {
          timeRow.appendChild(el('div', { class: 'pbp-pregame-time-sub' }, `${etTime} ET`));
        }
        banner.appendChild(timeRow);

        // Countdown — only meaningful for not-yet-started, not for postponed
        const detailedLower = (gd.status && gd.status.detailedState || '').toLowerCase();
        if (!detailedLower.includes('postponed')) {
          const countdownEl = el('div', { class: 'pbp-pregame-countdown' });
          const renderCountdown = () => {
            const now = Date.now();
            const diff = target.getTime() - now;
            if (diff <= 0) {
              countdownEl.textContent = 'First pitch imminent';
              return;
            }
            const totalSec = Math.floor(diff / 1000);
            const days = Math.floor(totalSec / 86400);
            const hours = Math.floor((totalSec % 86400) / 3600);
            const mins = Math.floor((totalSec % 3600) / 60);
            const parts = [];
            if (days > 0) parts.push(`${days}d`);
            if (hours > 0 || days > 0) parts.push(`${hours}h`);
            parts.push(`${mins}m`);
            countdownEl.textContent = `First pitch in ${parts.join(' ')}`;
          };
          renderCountdown();
          banner.appendChild(countdownEl);
        }
      }
      wrap.appendChild(banner);

      // ---- Probable pitchers row ----
      const probables = (gd.probablePitchers) || {};
      const awayProb = probables.away || null;
      const homeProb = probables.home || null;

      if (awayProb || homeProb) {
        const probRow = el('div', { class: 'pbp-pregame-probables' });

        const buildProbCard = (side, team, prob) => {
          const c = el('div', { class: 'pbp-pregame-prob' });
          // Team header (logo + name)
          const teamHeader = el('div', { class: 'pbp-pregame-prob-team' });
          teamHeader.appendChild(teamLogoEl(team.id, { className: 'pbp-pregame-prob-logo', alt: team.name || '' }));
          teamHeader.appendChild(el('div', { class: 'pbp-pregame-prob-team-name' },
            team.clubName || team.teamName || team.name || ''
          ));
          c.appendChild(teamHeader);

          // Pitcher with photo, "Probable starter" label
          const pitcherBox = el('div', { class: 'pbp-pregame-prob-pitcher' });
          if (prob && prob.id) {
            pitcherBox.appendChild(el('img', {
              class: 'pbp-pregame-prob-photo',
              src: PLAYER_HEADSHOT_URL(prob.id, 120),
              alt: prob.fullName || '',
              onerror: function () { this.style.opacity = '0.3'; }
            }));
          }
          const ptxt = el('div', { class: 'pbp-pregame-prob-text' });
          ptxt.appendChild(el('div', { class: 'pbp-pregame-prob-label' }, 'Probable starter'));
          ptxt.appendChild(el('div', { class: 'pbp-pregame-prob-name' },
            prob ? prob.fullName : 'TBD'
          ));
          pitcherBox.appendChild(ptxt);
          c.appendChild(pitcherBox);

          return c;
        };

        probRow.appendChild(buildProbCard('away', awayTeam, awayProb));
        probRow.appendChild(buildProbCard('home', homeTeam, homeProb));
        wrap.appendChild(probRow);
      }

      // ---- Team records & venue ----
      const meta = el('div', { class: 'pbp-pregame-meta' });

      // Records row
      const awayRec = (gd.teams && gd.teams.away && gd.teams.away.record) || null;
      const homeRec = (gd.teams && gd.teams.home && gd.teams.home.record) || null;
      if (awayRec || homeRec) {
        const recRow = el('div', { class: 'pbp-pregame-records' });
        const fmtRec = (r) => r ? `${r.wins || 0}–${r.losses || 0}` : '—';
        recRow.appendChild(el('div', { class: 'pbp-pregame-record' },
          el('div', { class: 'pbp-pregame-record-label' }, awayTeam.abbreviation || 'Away'),
          el('div', { class: 'pbp-pregame-record-val' }, fmtRec(awayRec))
        ));
        recRow.appendChild(el('div', { class: 'pbp-pregame-record' },
          el('div', { class: 'pbp-pregame-record-label' }, homeTeam.abbreviation || 'Home'),
          el('div', { class: 'pbp-pregame-record-val' }, fmtRec(homeRec))
        ));
        meta.appendChild(recRow);
      }

      // Venue
      const venue = (gd.venue && gd.venue.name) || '';
      if (venue) {
        meta.appendChild(el('div', { class: 'pbp-pregame-venue' }, venue));
      }

      if (meta.children.length > 0) {
        wrap.appendChild(meta);
      }

      return wrap;
    }

    function buildFinalPbp(gd, ld, ls, box) {
      // Final mode: show winner banner, decisions (W/L/SV), and top performers per team
      const wrap = el('div', { class: 'pbp-final-content' });

      const awayRuns = (ls.teams && ls.teams.away && ls.teams.away.runs) || 0;
      const homeRuns = (ls.teams && ls.teams.home && ls.teams.home.runs) || 0;
      const awayTeam = (gd.teams && gd.teams.away) || {};
      const homeTeam = (gd.teams && gd.teams.home) || {};
      const winnerSide = awayRuns > homeRuns ? 'away' : (homeRuns > awayRuns ? 'home' : null);
      const winnerTeam = winnerSide === 'away' ? awayTeam : (winnerSide === 'home' ? homeTeam : null);

      // ---- Winner banner ----
      const banner = el('div', { class: 'pbp-final-banner' });
      if (winnerTeam) {
        banner.appendChild(teamLogoEl(winnerTeam.id, { className: 'pbp-final-logo', alt: winnerTeam.name || '' }));
        const text = el('div', { class: 'pbp-final-text' });
        text.appendChild(el('div', { class: 'pbp-final-label' }, 'Final'));
        text.appendChild(el('div', { class: 'pbp-final-headline' },
          `${winnerTeam.clubName || winnerTeam.teamName || winnerTeam.name} win, ${Math.max(awayRuns, homeRuns)}–${Math.min(awayRuns, homeRuns)}`
        ));
        banner.appendChild(text);
      } else {
        banner.appendChild(el('div', { class: 'pbp-final-text' },
          el('div', { class: 'pbp-final-label' }, 'Final'),
          el('div', { class: 'pbp-final-headline' }, `Tied, ${awayRuns}–${homeRuns}`)
        ));
      }
      wrap.appendChild(banner);

      // ---- Decisions row (W / L / SV) ----
      const decisions = (ld && ld.decisions) || {};
      if (decisions.winner || decisions.loser || decisions.save) {
        const row = el('div', { class: 'pbp-decisions' });
        const addDecision = (label, person) => {
          if (!person) return;
          const cell = el('div', { class: 'pbp-decision' });
          if (person.id) {
            cell.appendChild(el('img', {
              class: 'pbp-decision-photo',
              src: PLAYER_HEADSHOT_URL(person.id, 90),
              alt: person.fullName || '',
              onerror: function () { this.style.opacity = '0.3'; }
            }));
          }
          const txt = el('div', { class: 'pbp-decision-text' });
          txt.appendChild(el('div', { class: 'pbp-decision-label' }, label));
          txt.appendChild(el('div', { class: 'pbp-decision-name' }, person.fullName || ''));
          cell.appendChild(txt);
          row.appendChild(cell);
        };
        addDecision('Win', decisions.winner);
        addDecision('Loss', decisions.loser);
        addDecision('Save', decisions.save);
        wrap.appendChild(row);
      }

      // ---- Top performers ----
      const performers = el('div', { class: 'pbp-performers' });

      function buildPerformerColumn(side, team) {
        const col = el('div', { class: 'pbp-performer-col' });
        const header = el('div', { class: 'pbp-performer-header' });
        header.appendChild(teamLogoEl(team.id, { className: 'pbp-performer-logo', alt: team.name || '' }));
        header.appendChild(el('div', { class: 'pbp-performer-team' },
          team.clubName || team.teamName || team.name || ''
        ));
        col.appendChild(header);

        const top = getTopBatter(box, side);
        if (top) {
          const card = el('div', { class: 'pbp-performer-card' });
          if (top.id) {
            card.appendChild(el('img', {
              class: 'pbp-performer-photo',
              src: PLAYER_HEADSHOT_URL(top.id, 120),
              alt: top.name,
              onerror: function () { this.style.opacity = '0.3'; }
            }));
          }
          const cardText = el('div', { class: 'pbp-performer-card-text' });
          cardText.appendChild(el('div', { class: 'pbp-performer-label' }, 'Top batter'));
          cardText.appendChild(el('div', { class: 'pbp-performer-name' }, top.name));
          const lineParts = [`${top.hits} for ${top.atBats}`];
          if (top.hr > 0) lineParts.push(`${top.hr} HR`);
          if (top.rbi > 0) lineParts.push(`${top.rbi} RBI`);
          if (top.runs > 0 && top.hr === 0) lineParts.push(`${top.runs} R`);
          cardText.appendChild(el('div', { class: 'pbp-performer-line' }, lineParts.join(' · ')));
          card.appendChild(cardText);
          col.appendChild(card);
        } else {
          col.appendChild(el('div', { class: 'pbp-empty' }, 'No data'));
        }
        return col;
      }

      performers.appendChild(buildPerformerColumn('away', awayTeam));
      performers.appendChild(buildPerformerColumn('home', homeTeam));
      wrap.appendChild(performers);

      return wrap;
    }

    function getTopBatter(box, side) {
      const players = box && box.teams && box.teams[side] && box.teams[side].players;
      if (!players) return null;
      let best = null;
      Object.keys(players).forEach(key => {
        const p = players[key];
        const b = p && p.stats && p.stats.batting;
        if (!b) return;
        const atBats = num(b.atBats);
        const hits = num(b.hits);
        const hr = num(b.homeRuns);
        const rbi = num(b.rbi);
        const runs = num(b.runs);
        if (atBats === 0 && hits === 0) return;
        // Score: hits weighted, HR and RBI bonuses, runs minor
        const score = hits * 10 + hr * 8 + rbi * 4 + runs * 2;
        if (!best || score > best.score) {
          best = {
            id: (p.person && p.person.id) || null,
            name: (p.person && p.person.fullName) || '',
            atBats, hits, hr, rbi, runs, score
          };
        }
      });
      return best;
    }

    function buildPbpHeader(team, mainText, label, playerId) {
      const header = el('div', { class: 'pbp-header' });
      if (playerId) {
        // Player headshot (cutout-style PNG with transparent background)
        const headshot = el('img', {
          class: 'pbp-headshot',
          src: PLAYER_HEADSHOT_URL(playerId),
          alt: mainText,
          // If headshot is missing, gracefully fall back to the team logo
          onerror: function () {
            const fallback = teamLogoEl(team.id, { className: 'pbp-logo', alt: team.name });
            this.replaceWith(fallback);
          }
        });
        // Tinted backdrop using the player's team color
        const headshotWrap = el('div', {
          class: 'pbp-headshot-wrap',
          style: {
            '--headshot-tint-rgb': hexToRgbCsv(teamColor(team.id, 'primary'))
          }
        });
        headshotWrap.appendChild(headshot);
        header.appendChild(headshotWrap);
      } else {
        header.appendChild(teamLogoEl(team.id, { className: 'pbp-logo', alt: team.name }));
      }
      header.appendChild(el('div', { class: 'pbp-name' },
        el('div', { class: 'pbp-name-label' }, label),
        el('div', { class: 'pbp-name-main' }, mainText)
      ));
      return header;
    }

    function stat(label, val) {
      return el('div', { class: 'pbp-stat' },
        el('div', { class: 'pbp-stat-label' }, label),
        el('div', { class: 'pbp-stat-val' }, String(val))
      );
    }

    function buildPitchRow(p) {
      const row = el('div', { class: `pitch-row ${p.type}` });
      row.appendChild(el('div', { class: 'pitch-num' }, String(p.num)));
      row.appendChild(el('div', { class: 'pitch-result' }, p.result || '—'));
      const meta = p.pitchType ? `${p.pitchType}${p.speed ? ' · ' + p.speed.toFixed(1) + ' mph' : ''}` : '';
      row.appendChild(el('div', { class: 'pitch-meta' }, meta));
      return row;
    }

    function buildCountIndicator(balls, strikes) {
      const wrap = el('div', { class: 'count-indicator' });

      const ballsGroup = el('div', { class: 'count-group' });
      ballsGroup.appendChild(el('div', { class: 'count-label' }, 'Balls'));
      const ballsDots = el('div', { class: 'count-dots' });
      for (let i = 0; i < 3; i++) {
        ballsDots.appendChild(el('div', {
          class: `count-dot count-dot-ball ${i < balls ? 'filled' : ''}`
        }));
      }
      ballsGroup.appendChild(ballsDots);
      wrap.appendChild(ballsGroup);

      const strikesGroup = el('div', { class: 'count-group' });
      strikesGroup.appendChild(el('div', { class: 'count-label' }, 'Strikes'));
      const strikesDots = el('div', { class: 'count-dots' });
      for (let i = 0; i < 2; i++) {
        strikesDots.appendChild(el('div', {
          class: `count-dot count-dot-strike ${i < strikes ? 'filled' : ''}`
        }));
      }
      strikesGroup.appendChild(strikesDots);
      wrap.appendChild(strikesGroup);

      return wrap;
    }

    // ---------- Data extraction helpers ----------

    function extractCurrentAtBatPitches(currentPlay) {
      if (!currentPlay) return [];
      const events = currentPlay.playEvents || [];
      const pitches = [];
      let pitchNum = 0;
      events.forEach(ev => {
        if (ev.isPitch || ev.type === 'pitch') {
          pitchNum += 1;
          const code = (ev.details && (ev.details.code || ev.details.callDescription || '')).toString().toUpperCase();
          const desc = (ev.details && ev.details.description) || '';
          // Determine type: ball / strike / inplay
          let type = 'strike';
          // pitchData call code: B = ball, S = strike, C = called strike, F = foul, X = in play, D = in play (no out), E = in play (run), etc.
          if (code === 'B' || code === 'BD' || code === 'IB' || code === 'PO' || code === 'P' || /BALL/i.test(desc)) type = 'ball';
          else if (code === 'X' || code === 'D' || code === 'E' || code === 'H' || /IN PLAY/i.test(desc) || /HIT/i.test(desc)) type = 'inplay';
          else type = 'strike';

          const pd = ev.pitchData;
          const coords = (pd && pd.coordinates) || {};
          // Prefer Statcast-style feet coords (pX/pZ), fall back to legacy 250×250 pixel grid (x/y).
          // Legacy mapping: x in [0,250] left-to-right (catcher's view), y in [0,250] top-to-bottom.
          // Approx strike zone in legacy: x ∈ [79, 171], y ∈ [121, 224]. Plate width 17in ≈ 1.42ft.
          // Convert: pX = (x - 125) * (1.42 / (171 - 79)) ≈ (x - 125) / 64.78
          //          pZ = (224 - y) * (2.0 / (224 - 121)) + 1.5 ≈ (224 - y) / 51.5 + 1.5  (z grows upward)
          const numOrNull = (v) => {
            if (typeof v === 'number' && !isNaN(v)) return v;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(parseFloat(v))) return parseFloat(v);
            return null;
          };
          let x = numOrNull(coords.pX);
          let z = numOrNull(coords.pZ);
          if (x == null || z == null) {
            const legacyX = numOrNull(coords.x);
            const legacyY = numOrNull(coords.y);
            if (legacyX != null && legacyY != null) {
              x = (legacyX - 125) / 64.78;
              z = (224 - legacyY) / 51.5 + 1.5;
            }
          }
          const speed = pd && typeof pd.startSpeed === 'number' ? pd.startSpeed : null;
          const ptype = (ev.details && ev.details.type && ev.details.type.description) || '';

          pitches.push({
            num: pitchNum,
            type,
            x,
            z,
            speed,
            pitchType: ptype,
            result: desc
          });
        }
      });
      return pitches;
    }

    function getBatterGameStats(box, side, playerId) {
      if (!playerId) return { hits: 0, atBats: 0 };
      const players = box.teams && box.teams[side] && box.teams[side].players;
      if (!players) return { hits: 0, atBats: 0 };
      const p = players[`ID${playerId}`];
      if (!p || !p.stats || !p.stats.batting) return { hits: 0, atBats: 0 };
      const b = p.stats.batting;
      return { hits: num(b.hits), atBats: num(b.atBats) };
    }

    function getBatterSeasonAvg(box, side, playerId) {
      if (!playerId) return '.---';
      const players = box.teams && box.teams[side] && box.teams[side].players;
      if (!players) return '.---';
      const p = players[`ID${playerId}`];
      if (!p) return '.---';
      const ss = p.seasonStats && p.seasonStats.batting;
      if (ss && ss.avg) return ss.avg;
      return '.---';
    }

    function getPitcherGameStats(box, side, playerId) {
      if (!playerId) return { ip: '0.0', k: 0, ob: 0 };
      const players = box.teams && box.teams[side] && box.teams[side].players;
      if (!players) return { ip: '0.0', k: 0, ob: 0 };
      const p = players[`ID${playerId}`];
      if (!p || !p.stats || !p.stats.pitching) return { ip: '0.0', k: 0, ob: 0 };
      const pi = p.stats.pitching;
      const ip = pi.inningsPitched || '0.0';
      const k = num(pi.strikeOuts);
      const h = num(pi.hits);
      const bb = num(pi.baseOnBalls);
      const hbp = num(pi.hitByPitch);
      // OB = on bases allowed = hits + walks + HBP (approx — doesn't include errors but close enough)
      return { ip, k, ob: h + bb + hbp };
    }

    function getCurrentPitcher(box, side) {
      const teamBox = box.teams && box.teams[side];
      if (!teamBox) return null;
      // Find pitcher who is currently active — usually the one with most recent stats / last in pitcher list
      const pitchers = teamBox.pitchers || [];
      if (pitchers.length === 0) return null;
      const lastPitcherId = pitchers[pitchers.length - 1];
      const p = teamBox.players && teamBox.players[`ID${lastPitcherId}`];
      if (!p) return null;
      const pi = p.stats && p.stats.pitching ? p.stats.pitching : {};
      return {
        id: lastPitcherId,
        name: (p.person && p.person.fullName) || p.name || '',
        stats: {
          pitches: num(pi.numberOfPitches || pi.pitchesThrown),
          k: num(pi.strikeOuts),
          h: num(pi.hits),
          bb: num(pi.baseOnBalls),
          er: num(pi.earnedRuns),
          hr: num(pi.homeRuns)
        }
      };
    }

    function getNextThreeBatters(box, ld, ls, side) {
      const teamBox = box.teams && box.teams[side];
      if (!teamBox) return [];
      const battingOrder = teamBox.battingOrder || []; // array of player IDs in order
      if (battingOrder.length === 0) return [];

      // Determine next batter: who's currently due up
      const offense = ls.offense || {};
      const currentBatter = offense.batter;
      let startIdx = 0;
      const inactive = isInactiveMode(ls, ld);

      if (inactive) {
        // For the next half-inning's team, scan allPlays for the most recent
        // completed at-bat on the side that matches "side".
        // The "halfInning" value indicates the batting team's side: top -> away, bottom -> home
        const allPlays = (ld.plays && ld.plays.allPlays) || [];
        const targetHalf = side === 'away' ? 'top' : 'bottom';
        let lastBatterId = null;
        for (let i = allPlays.length - 1; i >= 0; i--) {
          const play = allPlays[i];
          const ph = (play.about && play.about.halfInning && play.about.halfInning.toLowerCase()) || '';
          if (ph === targetHalf && play.matchup && play.matchup.batter) {
            lastBatterId = play.matchup.batter.id;
            break;
          }
        }
        if (lastBatterId != null) {
          const idx = battingOrder.indexOf(lastBatterId);
          if (idx >= 0) startIdx = (idx + 1) % battingOrder.length;
        }
      } else if (currentBatter) {
        const idx = battingOrder.indexOf(currentBatter.id);
        if (idx >= 0) startIdx = idx;
      }

      const result = [];
      for (let i = 0; i < 3; i++) {
        const pid = battingOrder[(startIdx + i) % battingOrder.length];
        const p = teamBox.players && teamBox.players[`ID${pid}`];
        if (!p) continue;
        const bs = (p.stats && p.stats.batting) || {};
        result.push({
          id: pid,
          name: (p.person && p.person.fullName) || p.name || '',
          hits: num(bs.hits),
          atBats: num(bs.atBats)
        });
      }
      return result;
    }

    function unmount() {
      mounted = false;
      if (feed) { feed.stop(); feed = null; }
      if (rotatingTimer) clearInterval(rotatingTimer);
      lastReleasedData = null;
    }

    return { render, unmount };
  })();

  // ============================================
  //  SETTINGS VIEW
  // ============================================

  const SettingsView = (() => {
    let pageEl = null;

    function render(root) {
      clear(root);
      const page = el('div', { class: 'settings fade-in', id: 'settings-page' });
      pageEl = page;

      // Header — back button + title
      const header = el('div', { class: 'settings-header' });
      const back = el('button', {
        class: 'settings-back',
        onclick: () => Router.navigate('#/'),
        'aria-label': 'Back to home'
      }, '←');
      header.appendChild(back);
      header.appendChild(el('div', { class: 'settings-title' }, 'Settings'));
      page.appendChild(header);

      const wrap = el('div', { class: 'settings-content' });

      // ---- Buffer length ----
      const bufSection = el('div', { class: 'settings-section' });
      bufSection.appendChild(el('div', { class: 'settings-section-label' }, 'Buffer length'));
      bufSection.appendChild(el('div', { class: 'settings-section-desc' },
        'Carousel and game pages display data on this delay so you can sync with a delayed broadcast. The home page is unaffected.'
      ));

      const bufRow = el('div', { class: 'settings-slider-row' });
      const initialSec = Math.round(Settings.get('bufferMs') / 1000);
      const valLabel = el('div', { class: 'settings-slider-value' }, `${initialSec}s`);

      const slider = el('input', {
        type: 'range',
        min: '0',
        max: '180',
        step: '10',
        value: String(initialSec),
        class: 'settings-slider'
      });
      // Set initial fill position
      slider.style.setProperty('--val', String(initialSec));
      slider.addEventListener('input', () => {
        const sec = parseInt(slider.value, 10) || 0;
        valLabel.textContent = `${sec}s`;
        slider.style.setProperty('--val', String(sec));
        Settings.set({ bufferMs: sec * 1000 });
      });

      bufRow.appendChild(slider);
      bufRow.appendChild(valLabel);
      bufSection.appendChild(bufRow);

      // Tick marks for context
      const ticks = el('div', { class: 'settings-slider-ticks' });
      ['0s', '60s', '120s', '180s'].forEach(t =>
        ticks.appendChild(el('span', {}, t))
      );
      bufSection.appendChild(ticks);

      wrap.appendChild(bufSection);

      // ---- Accent color ----
      const accSection = el('div', { class: 'settings-section' });
      accSection.appendChild(el('div', { class: 'settings-section-label' }, 'Accent color'));
      accSection.appendChild(el('div', { class: 'settings-section-desc' },
        'Used across the entire app — buttons, glows, highlights, the box score, and progress bars. Pick a color or paste a hex code.'
      ));

      const accRow = el('div', { class: 'settings-color-row' });

      const colorInput = el('input', {
        type: 'color',
        value: Settings.get('accentHex') || DEFAULT_ACCENT_HEX,
        class: 'settings-color-input',
        'aria-label': 'Accent color picker'
      });

      const hexInput = el('input', {
        type: 'text',
        value: Settings.get('accentHex') || DEFAULT_ACCENT_HEX,
        maxlength: '7',
        class: 'settings-hex-input',
        'aria-label': 'Accent hex code',
        spellcheck: 'false',
        autocapitalize: 'none',
        autocomplete: 'off'
      });

      const isValidHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v);

      colorInput.addEventListener('input', () => {
        const v = colorInput.value;
        hexInput.value = v;
        hexInput.classList.remove('invalid');
        Settings.set({ accentHex: v });
      });

      hexInput.addEventListener('input', () => {
        let v = hexInput.value.trim();
        if (v && v[0] !== '#') v = '#' + v;
        hexInput.value = v;
        if (isValidHex(v)) {
          hexInput.classList.remove('invalid');
          colorInput.value = v;
          Settings.set({ accentHex: v });
        } else {
          hexInput.classList.add('invalid');
        }
      });

      accRow.appendChild(colorInput);
      accRow.appendChild(hexInput);

      // Reset accent button
      const resetBtn = el('button', {
        class: 'settings-reset-accent',
        onclick: () => {
          colorInput.value = DEFAULT_ACCENT_HEX;
          hexInput.value = DEFAULT_ACCENT_HEX;
          hexInput.classList.remove('invalid');
          Settings.set({ accentHex: DEFAULT_ACCENT_HEX });
        }
      }, 'Reset');
      accRow.appendChild(resetBtn);

      accSection.appendChild(accRow);
      wrap.appendChild(accSection);

      // ---- Reset all ----
      const resetAllRow = el('div', { class: 'settings-reset-all-row' });
      const resetAll = el('button', {
        class: 'settings-reset-all',
        onclick: () => {
          if (confirm('Reset all settings to defaults?')) {
            Settings.reset();
            Router.navigate('#/settings');
            // Force re-render to show updated values
            setTimeout(() => render(root), 0);
          }
        }
      }, 'Reset all settings');
      resetAllRow.appendChild(resetAll);
      wrap.appendChild(resetAllRow);

      page.appendChild(wrap);
      root.appendChild(page);
    }

    function unmount() {
      pageEl = null;
    }

    return { render, unmount };
  })();

  // ============================================
  //  APP MOUNTING
  // ============================================

  let activeView = null;

  function mount(route) {
    const root = $('#app');
    if (!root) return;

    // Unmount previous
    if (activeView && activeView.unmount) {
      activeView.unmount();
    }

    if (route.name === 'home') {
      HomeView.render(root);
      activeView = HomeView;
    } else if (route.name === 'carousel') {
      CarouselView.render(root);
      activeView = CarouselView;
    } else if (route.name === 'game') {
      GameView.render(root, route.params);
      activeView = GameView;
    } else if (route.name === 'settings') {
      SettingsView.render(root);
      activeView = SettingsView;
    } else {
      Router.navigate('#/');
    }
  }

  // Init
  Router.onChange(mount);
  Router.init();

  // Handle window resize for carousel scaling
  window.addEventListener('resize', () => {
    if (activeView === CarouselView) {
      // Carousel will reflow on next slide change naturally
    }
  });
})();
