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

// Standard suspension length by Red Card reason - used to auto-create a
// suspension the moment a match report is submitted (before any admin
// console review happens). The committee can later adjust up or down from
// this baseline, but this is always the starting point.
const STANDARD_SUSPENSION_GAMES = {
  'Serious Foul Play': 1,
  'DOGSO-F': 1,
  'DOGSO-H': 1,
  '2nd Caution': 1,
  'Violent Conduct': 3,
  'Abusive Language': 3,
  'Biting or Spitting': 3,
};
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

  // GET /api/config — expose the configured caps to the frontend
  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maxPlayers: MAX_PLAYERS_CHECKIN, maxStaff: MAX_STAFF_CHECKIN }));
    return;
  }

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

  // GET /api/checkins/:gameId — current check-in state for this game (both teams), plus per-team completion status
  const checkinsGetMatch = url.pathname.match(/^\/api\/checkins\/([^/]+)$/);
  if (req.method === 'GET' && checkinsGetMatch) {
    const gameId = decodeURIComponent(checkinsGetMatch[1]);
    try {
      const [checkinsResult, completionResult] = await Promise.all([
        pool.query(
          'SELECT game_id, team_id, team_name, person_type, profile_id, name, jersey_number FROM checkins WHERE game_id = $1 ORDER BY team_id, person_type, name',
          [gameId]
        ),
        pool.query('SELECT team_id FROM checkin_completion WHERE game_id = $1 AND completed = true', [gameId]),
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        checkins: checkinsResult.rows,
        completedTeamIds: completionResult.rows.map(r => r.team_id),
      }));
    } catch (err) {
      console.error('[api/checkins GET] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/checkin-complete — mark (or unmark) a team's check-in as done.
  // A persisted flag, not just client-side state, so reloading the page or
  // coming back later correctly shows the team as already checked in.
  if (req.method === 'POST' && url.pathname === '/api/checkin-complete') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
      const { gameId, teamId, teamName, completed } = payload;
      if (!gameId || !teamId || !teamName || typeof completed !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing gameId, teamId, teamName, or completed (boolean).' }));
      }
      try {
        await pool.query(
          `INSERT INTO checkin_completion (game_id, team_id, team_name, completed, completed_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (game_id, team_id) DO UPDATE SET completed = EXCLUDED.completed, completed_at = now(), team_name = EXCLUDED.team_name`,
          [gameId, teamId, teamName, completed]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('[api/checkin-complete POST] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/checkin — add/update or remove one person's check-in status
  if (req.method === 'POST' && url.pathname === '/api/checkin') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }

      const { gameId, teamId, teamName, personType, profileId, name, jerseyNumber, action } = payload;

      if (!gameId || !teamId || !teamName || !personType || !profileId || !name || !action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing required field(s).' }));
      }
      if (!['player', 'staff'].includes(personType)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'personType must be "player" or "staff".' }));
      }
      if (!['add', 'remove'].includes(action)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'action must be "add" or "remove".' }));
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (action === 'remove') {
          await client.query(
            'DELETE FROM checkins WHERE game_id = $1 AND team_id = $2 AND profile_id = $3',
            [gameId, teamId, profileId]
          );
          await client.query('COMMIT');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true }));
        }

        // action === 'add' — check whether this person is already checked in
        // (an update, doesn't count against the cap) vs. a genuinely new
        // check-in (does count, and must be validated against the cap).
        const existing = await client.query(
          'SELECT 1 FROM checkins WHERE game_id = $1 AND team_id = $2 AND profile_id = $3',
          [gameId, teamId, profileId]
        );
        const isNewCheckin = existing.rowCount === 0;

        // Serialize concurrent attempts for this exact game+team+personType
        // group using an advisory lock - covers both the jersey-duplicate
        // check and the cap check below, so two simultaneous requests can't
        // both slip past either one at once. (FOR UPDATE can't be combined
        // with COUNT(*) - it's an aggregate, not real rows to lock - so an
        // advisory lock is the correct tool here.) Auto-released at COMMIT/
        // ROLLBACK, no separate unlock call needed.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [gameId + ':' + teamId + ':' + personType]);

        // Players can't share a jersey number with another checked-in
        // player on the same team. Checked on every add - both a brand new
        // check-in AND a jersey-number change for someone already checked
        // in - since either could introduce a collision.
        if (personType === 'player' && jerseyNumber) {
          const dupCheck = await client.query(
            'SELECT name FROM checkins WHERE game_id = $1 AND team_id = $2 AND person_type = $3 AND jersey_number = $4 AND profile_id != $5',
            [gameId, teamId, personType, jerseyNumber, profileId]
          );
          if (dupCheck.rowCount > 0) {
            await client.query('ROLLBACK');
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Jersey number ${jerseyNumber} is already assigned to ${dupCheck.rows[0].name} on this team.` }));
          }
        }

        if (isNewCheckin) {
          const cap = personType === 'player' ? MAX_PLAYERS_CHECKIN : MAX_STAFF_CHECKIN;
          const countResult = await client.query(
            'SELECT COUNT(*) FROM checkins WHERE game_id = $1 AND team_id = $2 AND person_type = $3',
            [gameId, teamId, personType]
          );
          const currentCount = parseInt(countResult.rows[0].count, 10);
          if (currentCount >= cap) {
            await client.query('ROLLBACK');
            res.writeHead(409, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `Cap reached (${cap} ${personType}s already checked in for this team).` }));
          }
        }

        await client.query(
          `INSERT INTO checkins (game_id, team_id, team_name, person_type, profile_id, name, jersey_number, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (game_id, team_id, profile_id)
           DO UPDATE SET jersey_number = EXCLUDED.jersey_number, name = EXCLUDED.name, updated_at = now()`,
          [gameId, teamId, teamName, personType, profileId, name, jerseyNumber || null]
        );

        await client.query('COMMIT');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[api/checkin POST] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        client.release();
      }
    });
    return;
  }

  // GET /api/match-report/:gameId — read back an existing submitted report, if any
  const matchReportGetMatch = url.pathname.match(/^\/api\/match-report\/([^/]+)$/);
  if (req.method === 'GET' && matchReportGetMatch) {
    const gameId = decodeURIComponent(matchReportGetMatch[1]);
    try {
      const scoresResult = await pool.query('SELECT * FROM match_report_scores WHERE game_id = $1', [gameId]);
      const entriesResult = await pool.query(
        'SELECT team_id, team_name, person_type, profile_id, name, event_type, minute, reason, supplemental_report FROM match_report_entries WHERE game_id = $1 ORDER BY minute NULLS LAST',
        [gameId]
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scores: scoresResult.rows[0] || null, entries: entriesResult.rows }));
    } catch (err) {
      console.error('[api/match-report GET] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/match-report — the big submit: saves to Postgres, then pushes
  // the final score to SportsEngine via the real updateScore mutation.
  if (req.method === 'POST' && url.pathname === '/api/match-report') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }

      const { gameId, gameDate, team1, team2, entries } = payload;

      // --- Validation ---
      if (!gameId || !team1 || !team2 || !Array.isArray(entries)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing gameId, team1, team2, or entries.' }));
      }
      // A Red Card always auto-creates a suspension, which requires a real
      // game date (issued_from_game_date is NOT NULL). Rejecting outright
      // here - rather than silently skipping suspension creation - is
      // deliberate: a real Red Card that silently got no suspension due to
      // a missing date would be a serious, easy-to-miss integrity gap.
      if (entries.some(e => e.eventType === 'Red Card') && !gameDate) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'gameDate is required when submitting a Red Card, since it is needed to create the suspension record.' }));
      }
      for (const t of [team1, team2]) {
        if (!t.id || !t.name || !Number.isInteger(t.score) || t.score < 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Each team needs id, name, and a non-negative integer score.' }));
        }
      }
      const VALID_EVENT_TYPES = ['Goal', 'Yellow Card', 'Red Card'];
      const VALID_YELLOW_REASONS = ['Unsporting Behavior', 'Delaying the Restart', 'Failure to Respect Distance', 'Persistent Offense', 'Dissent', 'Entering/Leaving Field of Play', "Excessively using the 'review' signal"];
      const VALID_RED_REASONS = ['2nd Caution', 'Serious Foul Play', 'DOGSO-F', 'DOGSO-H', 'Violent Conduct', 'Abusive Language', 'Biting or Spitting'];
      for (const e of entries) {
        if (!e.teamId || !e.teamName || !e.personType || !e.profileId || !e.name || !VALID_EVENT_TYPES.includes(e.eventType)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Each entry needs teamId, teamName, personType, profileId, name, and a valid eventType.' }));
        }
        if (e.minute != null && (!Number.isInteger(e.minute) || e.minute < 0)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'minute must be a non-negative integer or null.' }));
        }
        if (e.eventType === 'Yellow Card' && !VALID_YELLOW_REASONS.includes(e.reason)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Yellow Card entries require a valid reason.' }));
        }
        if (e.eventType === 'Red Card' && !VALID_RED_REASONS.includes(e.reason)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Red Card entries require a valid reason.' }));
        }
        if (e.eventType === 'Red Card' && e.reason !== '2nd Caution' && (!e.supplementalReport || !String(e.supplementalReport).trim())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'A supplemental report is required for this red card (not needed for 2nd Caution).' }));
        }
      }

      // --- Save to Postgres first (our own data, fully under our control).
      // Match reports can NEVER be resubmitted once saved - this is
      // deliberate: suspensions are auto-created below at submission time
      // and referenced by entry_id, which must stay permanently stable.
      // Allowing a delete-and-replace resubmission (like earlier versions
      // of this endpoint did) would risk orphaning or duplicating real
      // suspension records tied to a specific incident. ---
      const client = await pool.connect();
      let postgresSaved = false;
      try {
        await client.query('BEGIN');

        // Lock on this specific game so two near-simultaneous submission
        // attempts can't both pass the "not yet submitted" check before
        // either has committed.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['match-report-submit:' + gameId]);

        const existing = await client.query('SELECT 1 FROM match_report_scores WHERE game_id = $1', [gameId]);
        if (existing.rowCount > 0) {
          await client.query('ROLLBACK');
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'This match report has already been submitted and cannot be resubmitted.' }));
        }

        await client.query(
          `INSERT INTO match_report_scores (game_id, game_date, team1_id, team1_name, team1_score, team2_id, team2_name, team2_score, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
          [gameId, gameDate || null, team1.id, team1.name, team1.score, team2.id, team2.name, team2.score]
        );

        for (const e of entries) {
          const insertResult = await client.query(
            `INSERT INTO match_report_entries (game_id, team_id, team_name, person_type, profile_id, name, event_type, minute, reason, supplemental_report, submitted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
             RETURNING id`,
            [gameId, e.teamId, e.teamName, e.personType, e.profileId, e.name, e.eventType, e.minute ?? null, e.reason ?? null, e.supplementalReport ?? null]
          );
          const entryId = insertResult.rows[0].id;

          // Auto-create the suspension the moment a Red Card is submitted -
          // never waits for an admin console review to exist first. Starts
          // at the standard value for the reason; a committee can adjust it
          // later, but the record always exists from submission onward.
          if (e.eventType === 'Red Card') {
            const standardGames = STANDARD_SUSPENSION_GAMES[e.reason];
            if (standardGames != null) {
              await client.query(
                `INSERT INTO suspensions (entry_id, profile_id, team_id, team_name, player_name, games_suspended, standard_games, issued_from_game_date, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'active', now())`,
                [entryId, e.profileId, e.teamId, e.teamName, e.name, standardGames, gameDate || null]
              );
            } else {
              console.warn('[match-report] No standard suspension mapping for reason:', e.reason, '- no suspension created for entry', entryId);
            }
          }
        }

        await client.query('COMMIT');
        postgresSaved = true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {}); // don't let a rollback failure mask the real error
        console.error('[api/match-report POST] Postgres error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to save report: ' + err.message }));
      } finally {
        client.release();
      }

      // --- Push the score to SportsEngine. This is reported separately from
      // the Postgres save above, since the two are different systems with no
      // shared transaction - if this fails, the detailed report is still
      // safely saved and the score push can be retried without re-entering
      // everything. ---
      let scoreUpdated = false;
      let scoreError = null;
      try {
        const mutation = `
          mutation UpdateScore($eventId: ID!, $s1: String!, $s2: String!) {
            updateScore(eventId: $eventId, scoreTeam1: $s1, scoreTeam2: $s2) {
              name
              eventTeams { name score }
            }
          }`;
        await callGraphQL(mutation, { eventId: gameId, s1: String(team1.score), s2: String(team2.score) });
        scoreUpdated = true;
      } catch (err) {
        console.error('[api/match-report POST] updateScore error:', err.message);
        scoreError = err.message;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, postgresSaved, scoreUpdated, scoreError }));
    });
    return;
  }

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
