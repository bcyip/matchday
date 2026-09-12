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
const MIN_PLAYERS_REQUIRED = parseInt(process.env.MIN_PLAYERS_REQUIRED || '7', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[postgres] Unexpected error on idle client:', err.message);
});

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
    // Same timeout protection as callGraphQL - see that function's comment
    // for the full reasoning.
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timed out waiting for SportsEngine to respond to the token refresh request (15s).'));
    });
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
    // Explicit timeout, deliberately shorter than DigitalOcean's own
    // platform-level request timeout - if SportsEngine is slow (which can
    // precede it returning a bad/HTML response), this ensures OUR clean
    // error handling fires first, so the browser always gets a proper
    // JSON error from us instead of DO's raw HTML timeout page reaching
    // the frontend directly (which is what likely caused the original
    // "Unexpected token '<'" crash - see conversation).
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timed out waiting for SportsEngine to respond (15s).'));
    });
    req.write(body);
    req.end();
  });
}

// Derives gender from program.primaryName (e.g. "College Club Soccer -
// Men FA 2026"). "women" is checked FIRST since "Women" contains "men" as
// a substring (wo-MEN) - checking "men" first would misclassify every
// women's team. Same logic as the schedule monitor, kept consistent.
function deriveGenderFromProgramName(primaryName) {
  if (!primaryName) return null;
  const lower = primaryName.toLowerCase();
  if (lower.includes('women')) return 'Women';
  if (lower.includes('men')) return 'Men';
  return null;
}

async function getSuspendedPlayers(teamId, asOfGameDate) {
  const result = await pool.query(
    `SELECT s.profile_id, s.player_name, s.games_suspended, s.standard_games, s.issued_from_game_date,
       (SELECT COUNT(*) FROM match_report_scores mrs
        WHERE (mrs.team1_id = s.team_id OR mrs.team2_id = s.team_id)
        AND mrs.game_date > s.issued_from_game_date
        AND mrs.game_date < $2) AS games_served
     FROM suspensions s
     WHERE s.team_id = $1`,
    [teamId, asOfGameDate]
  );

  return result.rows
    .map((row) => ({ ...row, games_served: parseInt(row.games_served, 10) }))
    .filter((row) => row.games_served < row.games_suspended);
}

async function fetchGameWithRosters(gameId) {
  const eventQuery = `
    query Event($id: String!) {
      event(id: $id) {
        id
        name
        start
        location { name }
        eventTeams { name homeTeam team { id divisionId program { primaryName } brand { logoUrl } } }
      }
    }`;
  const eventData = await callGraphQL(eventQuery, { id: gameId });
  const event = eventData.event;
  if (!event) throw new Error('No event found for game ID: ' + gameId);

  const teamIds = (event.eventTeams || []).map((t) => t.team && t.team.id).filter(Boolean);
  if (teamIds.length !== 2) {
    console.warn('[fetchGameWithRosters] Expected 2 teams, found', teamIds.length, 'for game', gameId);
  }

  const logoByTeamId = {};
  const divisionByTeamId = {};
  (event.eventTeams || []).forEach((t) => {
    if (t.team && t.team.id) {
      logoByTeamId[t.team.id] = (t.team.brand && t.team.brand.logoUrl) || null;
      divisionByTeamId[t.team.id] = {
        divisionId: t.team.divisionId || null,
        gender: deriveGenderFromProgramName(t.team.program && t.team.program.primaryName),
      };
    }
  });

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
    const team = data.team;
    team.logoUrl = logoByTeamId[teamId] || null;
    team.divisionId = (divisionByTeamId[teamId] && divisionByTeamId[teamId].divisionId) || null;
    team.gender = (divisionByTeamId[teamId] && divisionByTeamId[teamId].gender) || null;

    if (event.start) {
      const suspended = await getSuspendedPlayers(teamId, event.start);
      // Normalize to strings on both sides - SportsEngine returns profileId
      // as a raw JS number, while Postgres's profile_id column comes back
      // as a string. Set.has() and === both use strict equality, so
      // "66976676" !== 66976676 even though they represent the same
      // player - this silently broke suspension display until fixed here.
      const suspendedIds = new Set(suspended.map((s) => String(s.profile_id)));
      (team.players || []).forEach((p) => { p.suspended = suspendedIds.has(String(p.profileId)); });
      (team.staff || []).forEach((s) => { s.suspended = suspendedIds.has(String(s.profileId)); });
    }

    teams.push(team);
  }

  return { event, teams };
}

function matchReportGetPattern(pathname) {
  const m = pathname.match(/^\/api\/match-report\/([^/]+)$/);
  return m ? m[1] : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const suspendedMatch = url.pathname.match(/^\/api\/suspended-players\/([^/]+)$/);
  if (req.method === 'GET' && suspendedMatch) {
    const teamId = decodeURIComponent(suspendedMatch[1]);
    const gameDate = url.searchParams.get('gameDate');
    if (!gameDate) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'gameDate query parameter is required.' }));
    }
    try {
      const suspended = await getSuspendedPlayers(teamId, gameDate);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ suspended }));
    } catch (err) {
      console.error('[api/suspended-players] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ maxPlayers: MAX_PLAYERS_CHECKIN, maxStaff: MAX_STAFF_CHECKIN, minPlayersRequired: MIN_PLAYERS_REQUIRED }));
    return;
  }

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

      const { gameId, gameDate, teamId, teamName, personType, profileId, name, jerseyNumber, action } = payload;

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

      if (action === 'add' && gameDate) {
        const suspended = await getSuspendedPlayers(teamId, gameDate);
        // Same string-vs-number fix as the roster display above - profileId
        // arrives here as whatever JSON.stringify produced from the
        // frontend's roster data (a raw number), while profile_id from
        // Postgres is a string. Without normalizing both to strings, this
        // check silently never matched, meaning a suspended player could
        // actually be checked in - not just a display bug like the other
        // instance, this one bypassed real enforcement.
        if (suspended.some((s) => String(s.profile_id) === String(profileId))) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: name + ' is suspended and cannot be checked in for this game.' }));
        }
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

        const existing = await client.query(
          'SELECT 1 FROM checkins WHERE game_id = $1 AND team_id = $2 AND profile_id = $3',
          [gameId, teamId, profileId]
        );
        const isNewCheckin = existing.rowCount === 0;

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [gameId + ':' + teamId + ':' + personType]);

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

  if (req.method === 'GET' && matchReportGetPattern(url.pathname)) {
    const gameId = decodeURIComponent(matchReportGetPattern(url.pathname));
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

  // POST /api/match-report/:gameId/retry-score-push — re-attempts ONLY the
  // SportsEngine score sync, using the score already saved in Postgres.
  // Exists because a normal resubmission is always rejected once the
  // report is saved (match reports can never be resubmitted - see below),
  // which previously left no way to retry just the SportsEngine push if it
  // failed independently of the Postgres save. The frontend's single
  // submit button relabels itself to call this instead, once it knows
  // postgresSaved succeeded but scoreUpdated didn't - never a second
  // button, just the same one changing what it does.
  const retryScorePushMatch = url.pathname.match(/^\/api\/match-report\/([^/]+)\/retry-score-push$/);
  if (req.method === 'POST' && retryScorePushMatch) {
    const gameId = decodeURIComponent(retryScorePushMatch[1]);
    try {
      const scoresResult = await pool.query('SELECT team1_score, team2_score FROM match_report_scores WHERE game_id = $1', [gameId]);
      if (scoresResult.rowCount === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No saved match report found for this game - nothing to retry.' }));
      }
      const { team1_score, team2_score } = scoresResult.rows[0];

      const mutation = `
        mutation UpdateScore($eventId: String!, $s1: String!, $s2: String!) {
          updateScore(eventId: $eventId, scoreTeam1: $s1, scoreTeam2: $s2) {
            name
            eventTeams { name score }
          }
        }`;
      await callGraphQL(mutation, { eventId: gameId, s1: String(team1_score), s2: String(team2_score) });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, scoreUpdated: true }));
    } catch (err) {
      console.error('[api/match-report retry-score-push] Error:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' }); // 200, not 500 - this is an expected, retryable outcome, not a server crash
      res.end(JSON.stringify({ success: true, scoreUpdated: false, scoreError: err.message }));
    }
    return;
  }

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

      const { gameId, gameDate, team1, team2, entries, divisionId, gender } = payload;

      if (!gameId || !team1 || !team2 || !Array.isArray(entries)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing gameId, team1, team2, or entries.' }));
      }
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

      const client = await pool.connect();
      let postgresSaved = false;
      try {
        await client.query('BEGIN');

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['match-report-submit:' + gameId]);

        const existing = await client.query('SELECT 1 FROM match_report_scores WHERE game_id = $1', [gameId]);
        if (existing.rowCount > 0) {
          await client.query('ROLLBACK');
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'This match report has already been submitted and cannot be resubmitted.' }));
        }

        await client.query(
          `INSERT INTO match_report_scores (game_id, game_date, team1_id, team1_name, team1_score, team2_id, team2_name, team2_score, submitted_at, division_id, gender)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10)`,
          [gameId, gameDate || null, team1.id, team1.name, team1.score, team2.id, team2.name, team2.score, divisionId || null, gender || null]
        );

        for (const e of entries) {
          const insertResult = await client.query(
            `INSERT INTO match_report_entries (game_id, team_id, team_name, person_type, profile_id, name, event_type, minute, reason, supplemental_report, submitted_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
             RETURNING id`,
            [gameId, e.teamId, e.teamName, e.personType, e.profileId, e.name, e.eventType, e.minute ?? null, e.reason ?? null, e.supplementalReport ?? null]
          );
          const entryId = insertResult.rows[0].id;

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
        await client.query('ROLLBACK').catch(() => {});
        console.error('[api/match-report POST] Postgres error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Failed to save report: ' + err.message }));
      } finally {
        client.release();
      }

      let scoreUpdated = false;
      let scoreError = null;
      try {
        const mutation = `
          mutation UpdateScore($eventId: String!, $s1: String!, $s2: String!) {
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
  console.log(`MAX_PLAYERS_CHECKIN=${MAX_PLAYERS_CHECKIN}, MAX_STAFF_CHECKIN=${MAX_STAFF_CHECKIN}, MIN_PLAYERS_REQUIRED=${MIN_PLAYERS_REQUIRED}`);
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
