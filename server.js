// Check-in / Match Report app server — Stage 1: foundation.
//
// ARCHITECTURE NOTE: unlike the earlier stat-tracking app, this server does
// NOT expose a generic /api/graphql pass-through. This app needs a real
// write mutation (updateScore) eventually, so instead every capability is
// its own dedicated, purpose-built endpoint that does exactly one thing —
// tighter than an operation-allowlist over a generic proxy, since there's
// no "generic query shape" an attacker could probe at all.
//
// REQUIRED ENVIRONMENT VARIABLES:
//   SE_CLIENT_ID, SE_CLIENT_SECRET, SE_REFRESH_TOKEN, SE_ORG_ID  - same as before
//   DATABASE_URL       - Supabase (or later, DigitalOcean) Postgres connection string
//   MAX_PLAYERS_CHECKIN - integer, max players that can be checked in per team
//   MAX_STAFF_CHECKIN   - integer, max staff that can be checked in per team
//   PORT               - (optional) most hosts set this automatically

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'index.html');

const SE_CLIENT_ID = process.env.SE_CLIENT_ID;
const SE_CLIENT_SECRET = process.env.SE_CLIENT_SECRET;
const SE_REFRESH_TOKEN = process.env.SE_REFRESH_TOKEN;
const SE_ORG_ID = process.env.SE_ORG_ID;
const GRAPHQL_ENDPOINT = 'https://api.sportsengine.com/graphql';

const MAX_PLAYERS_CHECKIN = parseInt(process.env.MAX_PLAYERS_CHECKIN || '18', 10);
const MAX_STAFF_CHECKIN = parseInt(process.env.MAX_STAFF_CHECKIN || '5', 10);

// ---------- Postgres ----------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooler requires SSL. rejectUnauthorized:false is a pragmatic
  // default here (we're not bundling Supabase's CA cert) — acceptable given
  // the connection string itself (with its embedded password) is the real
  // secret being protected, same trust model as everything else in this app.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client:', err.message);
});

// ---------- SportsEngine token management (same refresh pattern as before) ----------

let tokenCache = { accessToken: null, expiresAt: 0 };

function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!SE_CLIENT_ID || !SE_CLIENT_SECRET || !SE_REFRESH_TOKEN) {
      return reject(new Error('Missing SE_CLIENT_ID / SE_CLIENT_SECRET / SE_REFRESH_TOKEN environment variables.'));
    }
    const body = JSON.stringify({
      client_id: SE_CLIENT_ID,
      client_secret: SE_CLIENT_SECRET,
      refresh_token: SE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const req = https.request(
      {
        hostname: 'user.sportsengine.com',
        path: '/oauth/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!json.access_token) return reject(new Error('Token refresh failed: ' + data));
            tokenCache.accessToken = json.access_token;
            tokenCache.expiresAt = Date.now() + (json.expires_in || 1800) * 1000 - 60000;
            console.log('[auth] Refreshed SportsEngine access token, valid for', json.expires_in || 1800, 'seconds');
            resolve(tokenCache.accessToken);
          } catch (e) {
            reject(new Error('Could not parse token response: ' + data));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getValidAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return refreshAccessToken();
}

async function callGraphQL(query, variables) {
  const token = await getValidAccessToken();
  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.sportsengine.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: 'Bearer ' + token,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.errors) return reject(new Error('GraphQL error: ' + JSON.stringify(json.errors)));
            resolve(json.data);
          } catch (e) {
            reject(new Error('Non-JSON response from SportsEngine: ' + data.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------- Dedicated endpoint: resolve a game deep-link + both rosters ----------

async function fetchGameWithRosters(gameId) {
  const eventQuery = `
    query Event($id: String!) {
      event(id: $id) {
        id
        name
        start
        location { name }
        eventTeams { name homeTeam team { id } }
      }
    }`;
  const eventData = await callGraphQL(eventQuery, { id: gameId });
  const event = eventData.event;
  if (!event) throw new Error('No event found for game ID: ' + gameId);

  const teamIds = (event.eventTeams || []).map((t) => t.team && t.team.id).filter(Boolean);
  if (teamIds.length !== 2) {
    console.warn('[fetchGameWithRosters] Expected 2 teams, found', teamIds.length, 'for game', gameId);
  }

  const rosterQuery = `
    query Team($id: String!) {
      team(id: $id) {
        id
        name
        players { firstName lastName jerseyNumber profileId rosterStatus }
        staff { firstName lastName profileId title }
      }
    }`;

  const teams = [];
  for (const teamId of teamIds) {
    const data = await callGraphQL(rosterQuery, { id: teamId });
    teams.push(data.team);
  }

  return { event, teams };
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // GET /api/game/:gameId — deep-link resolution: event info + both rosters
  const gameMatch = url.pathname.match(/^\/api\/game\/([^/]+)$/);
  if (req.method === 'GET' && gameMatch) {
    const gameId = decodeURIComponent(gameMatch[1]);
    try {
      const result = await fetchGameWithRosters(gameId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[api/game] Error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Stage 2 will add: GET/POST /api/checkin
  // Stage 3 will add: GET/POST /api/match-report

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(HTML_FILE, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('index.html not found — make sure it is in the same folder as server.js');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`MAX_PLAYERS_CHECKIN=${MAX_PLAYERS_CHECKIN}, MAX_STAFF_CHECKIN=${MAX_STAFF_CHECKIN}`);
  if (!SE_REFRESH_TOKEN) {
    console.warn('WARNING: no SE_REFRESH_TOKEN set. SportsEngine calls will fail until this is configured.');
  }
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: no DATABASE_URL set. Database calls will fail until this is configured.');
  } else {
    try {
      await pool.query('SELECT 1');
      console.log('[postgres] Connected successfully.');
    } catch (err) {
      console.error('[postgres] Connection test FAILED:', err.message);
    }
  }
});
