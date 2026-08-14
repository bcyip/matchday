// MatchDay API test suite.
//
// Runs against a REAL deployed instance (production, or a future QA
// environment) over plain HTTP - no browser, no direct DB access, matching
// the same interface real users go through.
//
// Usage:
//   TEST_BASE_URL=https://matchday.onrender.com \
//   TEST_DATABASE_URL="postgresql://..." \
//   node --test test/
//   (TEST_BASE_URL defaults to http://localhost:8787 if unset;
//    TEST_DATABASE_URL is required for the "Suspension serving" tests,
//    which need direct Postgres access to simulate admin-console
//    adjustments - matchday itself has no endpoint for changing an
//    existing suspension's games_suspended value)
//
// CI-readiness notes (see conversation for the full reasoning):
//   - Uses `node --test`, which exits non-zero on any failure - this alone
//     is what a CI system needs to know pass/fail. No extra wiring required.
//   - All config (BASE_URL) comes from an environment variable, not a
//     hardcoded value - pointing this at a future QA deployment instead of
//     production is a one-line env var change, not a code change.
//   - Every test uses a freshly-generated random game/team/profile ID, so
//     runs never collide with each other or with real data. Check-in test
//     data is cleaned up via the existing remove-endpoint at the end of
//     each test. (See the KNOWN LIMITATIONS note near the bottom of this
//     file for what does NOT get cleaned up automatically yet.)

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8787';
// Only used by the "Suspension serving" tests below, to directly adjust
// games_suspended the way the admin console would (matchday itself has no
// endpoint for this) and to clean up suspension rows afterward.
const testPool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function randomId(prefix) {
  return prefix + '-' + crypto.randomBytes(6).toString('hex');
}

async function apiGet(path) {
  const res = await fetch(BASE_URL + path);
  let body;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

async function apiPost(path, payload) {
  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

// ---------- Check-In: basic add/remove ----------

describe('Check-In: basic add/remove', () => {
  test('adding a player makes them appear in GET /api/checkins, removing makes them disappear', async () => {
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const profileId = randomId('test-player');

    const addRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId, name: 'Test Player', jerseyNumber: '7', action: 'add',
    });
    assert.strictEqual(addRes.status, 200, 'add should succeed: ' + JSON.stringify(addRes.body));

    const getRes = await apiGet('/api/checkins/' + gameId);
    assert.strictEqual(getRes.status, 200);
    const found = getRes.body.checkins.find(c => c.profile_id === profileId);
    assert.ok(found, 'player should appear in check-in list');
    assert.strictEqual(found.jersey_number, '7');

    const removeRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId, name: 'Test Player', jerseyNumber: null, action: 'remove',
    });
    assert.strictEqual(removeRes.status, 200);

    const getAfterRemove = await apiGet('/api/checkins/' + gameId);
    const stillThere = getAfterRemove.body.checkins.find(c => c.profile_id === profileId);
    assert.strictEqual(stillThere, undefined, 'player should be gone after remove');
  });
});

// ---------- Check-In: caps ----------

describe('Check-In: caps', () => {
  test('player cap is enforced - the (max+1)th player is rejected', async () => {
    const configRes = await apiGet('/api/config');
    const maxPlayers = configRes.body.maxPlayers;
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const addedProfileIds = [];

    for (let i = 0; i < maxPlayers; i++) {
      const profileId = randomId('test-player');
      const res = await apiPost('/api/checkin', {
        gameId, teamId, teamName: 'Test Team', personType: 'player',
        profileId, name: 'Player ' + i, jerseyNumber: String(i + 1), action: 'add',
      });
      assert.strictEqual(res.status, 200, `player ${i} (within cap) should succeed`);
      addedProfileIds.push(profileId);
    }

    const overCapProfileId = randomId('test-player');
    const overCapRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId: overCapProfileId, name: 'Over Cap Player', jerseyNumber: '99', action: 'add',
    });
    assert.strictEqual(overCapRes.status, 409, 'over-cap add should be rejected with 409');

    // Cleanup
    for (const profileId of addedProfileIds) {
      await apiPost('/api/checkin', {
        gameId, teamId, teamName: 'Test Team', personType: 'player',
        profileId, name: 'Cleanup', jerseyNumber: null, action: 'remove',
      });
    }
  });

  test('un-checking someone at the cap frees a slot for a new check-in', async () => {
    const configRes = await apiGet('/api/config');
    const maxStaff = configRes.body.maxStaff;
    console.log('[DIAG] maxStaff from /api/config:', maxStaff);
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const staffIds = [];

    for (let i = 0; i < maxStaff; i++) {
      const profileId = randomId('test-staff');
      const addRes = await apiPost('/api/checkin', {
        gameId, teamId, teamName: 'Test Team', personType: 'staff',
        profileId, name: 'Staff ' + i, jerseyNumber: null, action: 'add',
      });
      console.log(`[DIAG] add staff ${i} (${profileId}):`, addRes.status, JSON.stringify(addRes.body));
      staffIds.push(profileId);
    }

    // Remove one, freeing a slot
    const removeRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'staff',
      profileId: staffIds[0], name: 'Cleanup', jerseyNumber: null, action: 'remove',
    });
    console.log('[DIAG] remove staffIds[0] (' + staffIds[0] + '):', removeRes.status, JSON.stringify(removeRes.body));

    // See exactly what the server thinks is checked in right now
    const midCheck = await apiGet('/api/checkins/' + gameId);
    const staffRows = midCheck.body.checkins.filter(c => c.person_type === 'staff');
    console.log('[DIAG] staff rows AFTER remove, BEFORE new add:', JSON.stringify(staffRows, null, 2));
    console.log('[DIAG] staff row count:', staffRows.length, '(expected:', maxStaff - 1, ')');

    const newProfileId = randomId('test-staff');
    const res = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'staff',
      profileId: newProfileId, name: 'New Staff', jerseyNumber: null, action: 'add',
    });
    console.log('[DIAG] final add attempt:', res.status, JSON.stringify(res.body));
    assert.strictEqual(res.status, 200, 'should succeed now that a slot is free');

    // Cleanup
    for (const profileId of staffIds.slice(1).concat(newProfileId)) {
      await apiPost('/api/checkin', {
        gameId, teamId, teamName: 'Test Team', personType: 'staff',
        profileId, name: 'Cleanup', jerseyNumber: null, action: 'remove',
      });
    }
  });
});

// ---------- Check-In: jersey number uniqueness ----------

describe('Check-In: jersey number uniqueness', () => {
  test('duplicate jersey number on the SAME team is rejected', async () => {
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const p1 = randomId('test-player');
    const p2 = randomId('test-player');

    await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId: p1, name: 'Player One', jerseyNumber: '10', action: 'add',
    });

    const dupRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId: p2, name: 'Player Two', jerseyNumber: '10', action: 'add',
    });
    assert.strictEqual(dupRes.status, 409, 'duplicate jersey on same team should be rejected');

    // Cleanup
    await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId: p1, name: 'Cleanup', jerseyNumber: null, action: 'remove',
    });
  });

  test('the SAME jersey number on a DIFFERENT team is allowed', async () => {
    const gameId = randomId('test-game');
    const teamA = randomId('test-team-a');
    const teamB = randomId('test-team-b');
    const p1 = randomId('test-player');
    const p2 = randomId('test-player');

    const res1 = await apiPost('/api/checkin', {
      gameId, teamId: teamA, teamName: 'Team A', personType: 'player',
      profileId: p1, name: 'Player One', jerseyNumber: '10', action: 'add',
    });
    assert.strictEqual(res1.status, 200);

    const res2 = await apiPost('/api/checkin', {
      gameId, teamId: teamB, teamName: 'Team B', personType: 'player',
      profileId: p2, name: 'Player Two', jerseyNumber: '10', action: 'add',
    });
    assert.strictEqual(res2.status, 200, 'same number on a different team should be allowed');

    // Cleanup
    await apiPost('/api/checkin', { gameId, teamId: teamA, teamName: 'Team A', personType: 'player', profileId: p1, name: 'Cleanup', jerseyNumber: null, action: 'remove' });
    await apiPost('/api/checkin', { gameId, teamId: teamB, teamName: 'Team B', personType: 'player', profileId: p2, name: 'Cleanup', jerseyNumber: null, action: 'remove' });
  });

  test('updating an already-checked-in player\'s own jersey number does not count as a new check-in against the cap', async () => {
    const configRes = await apiGet('/api/config');
    const maxPlayers = configRes.body.maxPlayers;
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const profileIds = [];

    for (let i = 0; i < maxPlayers; i++) {
      const profileId = randomId('test-player');
      await apiPost('/api/checkin', {
        gameId, teamId, teamName: 'Test Team', personType: 'player',
        profileId, name: 'Player ' + i, jerseyNumber: String(i + 1), action: 'add',
      });
      profileIds.push(profileId);
    }

    // Update the first player's jersey number - should succeed even though the team is at cap
    const updateRes = await apiPost('/api/checkin', {
      gameId, teamId, teamName: 'Test Team', personType: 'player',
      profileId: profileIds[0], name: 'Player 0', jerseyNumber: '77', action: 'add',
    });
    assert.strictEqual(updateRes.status, 200, 'updating an existing check-in should not be blocked by the cap');

    // Cleanup
    for (const profileId of profileIds) {
      await apiPost('/api/checkin', { gameId, teamId, teamName: 'Test Team', personType: 'player', profileId, name: 'Cleanup', jerseyNumber: null, action: 'remove' });
    }
  });
});

// ---------- Check-In: completion flag persistence ----------

describe('Check-In: completion flag', () => {
  test('marking a team complete persists and can be unmarked', async () => {
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');

    const markRes = await apiPost('/api/checkin-complete', {
      gameId, teamId, teamName: 'Test Team', completed: true,
    });
    assert.strictEqual(markRes.status, 200);

    const getRes = await apiGet('/api/checkins/' + gameId);
    assert.ok(getRes.body.completedTeamIds.includes(teamId), 'team should show as completed');

    const unmarkRes = await apiPost('/api/checkin-complete', {
      gameId, teamId, teamName: 'Test Team', completed: false,
    });
    assert.strictEqual(unmarkRes.status, 200);

    const getAfterUnmark = await apiGet('/api/checkins/' + gameId);
    assert.ok(!getAfterUnmark.body.completedTeamIds.includes(teamId), 'team should no longer show as completed');
  });
});

// ---------- Match Report: server-side validation ----------

describe('Match Report: validation', () => {
  function baseEntry(overrides) {
    return {
      teamId: randomId('test-team'), teamName: 'Test Team', personType: 'player',
      profileId: randomId('test-player'), name: 'Test Player', minute: 10,
      ...overrides,
    };
  }

  test('Yellow Card entry with an invalid reason is rejected', async () => {
    const gameId = randomId('test-game');
    const res = await apiPost('/api/match-report', {
      gameId,
      team1: { id: 'teamA', name: 'Team A', score: 0 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [baseEntry({ eventType: 'Yellow Card', reason: 'Not A Real Reason' })],
    });
    assert.strictEqual(res.status, 400, 'invalid reason should be rejected');
  });

  test('Red Card with a non-2nd-Caution reason and NO supplemental report is rejected', async () => {
    const gameId = randomId('test-game');
    const res = await apiPost('/api/match-report', {
      gameId,
      gameDate: '2026-09-15T18:00:00Z',
      team1: { id: 'teamA', name: 'Team A', score: 0 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [baseEntry({ eventType: 'Red Card', reason: 'Violent Conduct', supplementalReport: '' })],
    });
    assert.strictEqual(res.status, 400, 'missing supplemental report should be rejected');
  });

  test('Red Card with reason "2nd Caution" does NOT require a supplemental report', async () => {
    const gameId = randomId('test-game');
    const res = await apiPost('/api/match-report', {
      gameId,
      gameDate: '2026-09-15T18:00:00Z',
      team1: { id: 'teamA', name: 'Team A', score: 0 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [baseEntry({ eventType: 'Red Card', reason: '2nd Caution', supplementalReport: null })],
    });
    assert.strictEqual(res.status, 200, '2nd Caution should be accepted without a supplemental report');
  });
});

// ---------- Match Report: submit, reload, no-resubmission lock ----------

describe('Match Report: submit and reload', () => {
  test('a full valid submission is saved and reloadable, and gracefully reports a SportsEngine push failure for a synthetic game ID', async () => {
    const gameId = randomId('test-game');
    const payload = {
      gameId,
      team1: { id: 'teamA', name: 'Team A', score: 1 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [{
        teamId: 'teamA', teamName: 'Team A', personType: 'player',
        profileId: 'p1', name: 'Scorer', eventType: 'Goal', minute: 30, reason: null, supplementalReport: null,
      }],
    };

    const submitRes = await apiPost('/api/match-report', payload);
    assert.strictEqual(submitRes.status, 200);
    assert.strictEqual(submitRes.body.postgresSaved, true, 'Postgres save should succeed regardless of SportsEngine outcome');
    // This game ID is synthetic, so the real SportsEngine push is EXPECTED to
    // fail - confirming that failure is reported gracefully (not silently
    // swallowed, and not blocking the Postgres save) is the actual point of
    // this assertion.
    assert.strictEqual(submitRes.body.scoreUpdated, false, 'push to a fake game ID should fail as expected');
    assert.ok(submitRes.body.scoreError, 'a scoreError message should be present when the push fails');

    const getRes = await apiGet('/api/match-report/' + gameId);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.body.scores.team1_score, 1);
    assert.strictEqual(getRes.body.entries.length, 1);
    assert.strictEqual(getRes.body.entries[0].name, 'Scorer');
  });

  test('a second submission for the same game is rejected outright - reports can never be resubmitted', async () => {
    const gameId = randomId('test-game');
    const firstPayload = {
      gameId,
      gameDate: '2026-09-15T18:00:00Z',
      team1: { id: 'teamA', name: 'Team A', score: 2 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [
        { teamId: 'teamA', teamName: 'Team A', personType: 'player', profileId: 'p1', name: 'Scorer One', eventType: 'Goal', minute: 10, reason: null, supplementalReport: null },
        { teamId: 'teamA', teamName: 'Team A', personType: 'player', profileId: 'p1', name: 'Scorer One', eventType: 'Goal', minute: 40, reason: null, supplementalReport: null },
      ],
    };
    const firstRes = await apiPost('/api/match-report', firstPayload);
    assert.strictEqual(firstRes.status, 200, 'first submission should succeed');

    const secondPayload = {
      gameId,
      gameDate: '2026-09-15T18:00:00Z',
      team1: { id: 'teamA', name: 'Team A', score: 1 },
      team2: { id: 'teamB', name: 'Team B', score: 0 },
      entries: [
        { teamId: 'teamA', teamName: 'Team A', personType: 'player', profileId: 'p2', name: 'Scorer Two', eventType: 'Goal', minute: 55, reason: null, supplementalReport: null },
      ],
    };
    const secondRes = await apiPost('/api/match-report', secondPayload);
    assert.strictEqual(secondRes.status, 409, 'resubmitting an already-submitted game should be rejected');

    // Confirm the ORIGINAL data is completely untouched by the rejected attempt.
    const getRes = await apiGet('/api/match-report/' + gameId);
    assert.strictEqual(getRes.body.entries.length, 2, 'original 2 entries should remain, unaffected by the rejected resubmission');
    assert.strictEqual(getRes.body.entries[0].name, 'Scorer One');
    assert.strictEqual(getRes.body.scores.team1_score, 2, 'original score should remain unchanged');
  });
});

// ---------- Suspension serving ----------
//
// These tests use the REAL /api/match-report submission path to create
// suspensions (exercising the actual auto-creation logic, not a simulation
// of it), then read status back via the standalone GET
// /api/suspended-players/:teamId endpoint - which exists specifically so
// this logic is testable without needing a real SportsEngine roster fetch.
// Direct Postgres access (testPool) is only used to simulate an admin
// console adjustment (matchday itself has no endpoint for that) and to
// clean up suspension rows afterward.

describe('Suspension serving', () => {
  test('a standard suspension is created automatically at the correct value when a Red Card is submitted', async () => {
    const gameId = randomId('test-game');
    const teamId = randomId('test-team');
    const profileId = randomId('test-player');

    const res = await apiPost('/api/match-report', {
      gameId, gameDate: '2026-09-01T18:00:00Z',
      team1: { id: teamId, name: 'Test Team', score: 0 },
      team2: { id: 'opp-team', name: 'Opponent', score: 1 },
      entries: [{
        teamId, teamName: 'Test Team', personType: 'player', profileId, name: 'Test Player',
        eventType: 'Red Card', reason: 'Violent Conduct', minute: 40, supplementalReport: 'Test incident.',
      }],
    });
    assert.strictEqual(res.status, 200);

    const susResult = await testPool.query('SELECT games_suspended, standard_games FROM suspensions WHERE profile_id = $1', [profileId]);
    assert.strictEqual(susResult.rows.length, 1);
    assert.strictEqual(susResult.rows[0].games_suspended, 3, 'Violent Conduct standard is 3');
    assert.strictEqual(susResult.rows[0].standard_games, 3);

    await testPool.query('DELETE FROM suspensions WHERE profile_id = $1', [profileId]);
  });

  test('player is suspended for the next game, then available once the standard number of games have been played', async () => {
    const teamId = randomId('test-team');
    const profileId = randomId('test-player');

    // DOGSO-F = 1 game standard
    await apiPost('/api/match-report', {
      gameId: randomId('test-game'), gameDate: '2026-09-01T18:00:00Z',
      team1: { id: teamId, name: 'Test Team', score: 0 },
      team2: { id: 'opp-team', name: 'Opponent', score: 1 },
      entries: [{
        teamId, teamName: 'Test Team', personType: 'player', profileId, name: 'Test Player',
        eventType: 'Red Card', reason: 'DOGSO-F', minute: 20, supplementalReport: 'x',
      }],
    });

    const nextGameDate = '2026-09-08T18:00:00Z';
    const beforeRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=' + encodeURIComponent(nextGameDate));
    assert.ok(beforeRes.body.suspended.some(s => s.profile_id === profileId), 'should be suspended for the very next game (0 of 1 required games served)');

    // That next game happens and gets reported (no misconduct in it)
    await apiPost('/api/match-report', {
      gameId: randomId('test-game'), gameDate: nextGameDate,
      team1: { id: teamId, name: 'Test Team', score: 1 },
      team2: { id: 'opp-team', name: 'Opponent', score: 0 },
      entries: [],
    });

    const afterRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=2026-09-15T18:00:00Z');
    assert.ok(!afterRes.body.suspended.some(s => s.profile_id === profileId), 'should be available - the required 1 game has now been served');

    await testPool.query('DELETE FROM suspensions WHERE profile_id = $1', [profileId]);
  });

  test('an admin adjustment to 4 games is correctly respected - suspended through game 4, available for game 5', async () => {
    const teamId = randomId('test-team');
    const profileId = randomId('test-player');

    // DOGSO-H standard is 1 game
    await apiPost('/api/match-report', {
      gameId: randomId('test-game'), gameDate: '2026-09-01T18:00:00Z',
      team1: { id: teamId, name: 'Test Team', score: 0 },
      team2: { id: 'opp-team', name: 'Opponent', score: 1 },
      entries: [{
        teamId, teamName: 'Test Team', personType: 'player', profileId, name: 'Test Player',
        eventType: 'Red Card', reason: 'DOGSO-H', minute: 10, supplementalReport: 'x',
      }],
    });

    // Simulate an admin console increase from standard 1 to 4
    await testPool.query('UPDATE suspensions SET games_suspended = 4 WHERE profile_id = $1', [profileId]);

    const gameDates = ['2026-09-08T18:00:00Z', '2026-09-15T18:00:00Z', '2026-09-22T18:00:00Z', '2026-09-29T18:00:00Z'];

    // Check suspended status BEFORE each of the 4 games, submitting each as we go
    for (let i = 0; i < gameDates.length; i++) {
      const checkRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=' + encodeURIComponent(gameDates[i]));
      assert.ok(checkRes.body.suspended.some(s => s.profile_id === profileId), `should still be suspended for game ${i + 1} of 4`);

      await apiPost('/api/match-report', {
        gameId: randomId('test-game'), gameDate: gameDates[i],
        team1: { id: teamId, name: 'Test Team', score: 1 },
        team2: { id: 'opp-team', name: 'Opponent', score: 0 },
        entries: [],
      });
    }

    // Now, after all 4 adjusted games have been served, the 5th should be available
    const fifthGameRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=2026-10-06T18:00:00Z');
    assert.ok(!fifthGameRes.body.suspended.some(s => s.profile_id === profileId), 'should be available for the 5th game - all 4 adjusted games served');

    await testPool.query('DELETE FROM suspensions WHERE profile_id = $1', [profileId]);
  });

  test('reducing to 0 games makes the player immediately available', async () => {
    const teamId = randomId('test-team');
    const profileId = randomId('test-player');

    await apiPost('/api/match-report', {
      gameId: randomId('test-game'), gameDate: '2026-09-01T18:00:00Z',
      team1: { id: teamId, name: 'Test Team', score: 0 },
      team2: { id: 'opp-team', name: 'Opponent', score: 1 },
      entries: [{
        teamId, teamName: 'Test Team', personType: 'player', profileId, name: 'Test Player',
        eventType: 'Red Card', reason: 'Serious Foul Play', minute: 15, supplementalReport: 'x',
      }],
    });

    const checkDate = '2026-09-08T18:00:00Z';
    const beforeRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=' + checkDate);
    assert.ok(beforeRes.body.suspended.some(s => s.profile_id === profileId), 'should be suspended before the reduction');

    // Simulate an admin console reduction to 0 (e.g. reversed on appeal)
    await testPool.query('UPDATE suspensions SET games_suspended = 0 WHERE profile_id = $1', [profileId]);

    const afterRes = await apiGet('/api/suspended-players/' + teamId + '?gameDate=' + checkDate);
    assert.ok(!afterRes.body.suspended.some(s => s.profile_id === profileId), 'should be immediately available once reduced to 0');

    await testPool.query('DELETE FROM suspensions WHERE profile_id = $1', [profileId]);
  });

  test('a suspension on one team does not affect a different team', async () => {
    const teamA = randomId('test-team-a');
    const teamB = randomId('test-team-b');
    const profileIdA = randomId('test-player');

    await apiPost('/api/match-report', {
      gameId: randomId('test-game'), gameDate: '2026-09-01T18:00:00Z',
      team1: { id: teamA, name: 'Team A', score: 0 },
      team2: { id: teamB, name: 'Team B', score: 1 },
      entries: [{
        teamId: teamA, teamName: 'Team A', personType: 'player', profileId: profileIdA, name: 'Player A',
        eventType: 'Red Card', reason: 'Biting or Spitting', minute: 60, supplementalReport: 'x',
      }],
    });

    const teamBRes = await apiGet('/api/suspended-players/' + teamB + '?gameDate=2026-09-08T18:00:00Z');
    assert.strictEqual(teamBRes.body.suspended.length, 0, 'Team B should have zero suspended players');

    await testPool.query('DELETE FROM suspensions WHERE profile_id = $1', [profileIdA]);
  });
});

after(async () => {
  await testPool.end();
});

/*
 * KNOWN LIMITATIONS / GAPS FOUND WHILE WRITING THIS SUITE — worth reading:
 *
 * 1. NOT CLEANED UP AUTOMATICALLY: match_report_scores and
 *    match_report_entries rows created by these tests are never deleted
 *    (there's no delete-by-gameId endpoint for match reports - and now that
 *    resubmission is blocked entirely, there's no replace-on-resubmit path
 *    either). Rows accumulate slowly over repeated test runs. Low real-world
 *    harm (synthetic gameIds are clearly distinguishable, e.g.
 *    "test-game-..."), but worth adding a real cleanup endpoint or a
 *    periodic manual purge if this becomes noisy in Supabase's Table Editor.
 *
 * 2. NOT SERVER-ENFORCED (client-side only currently):
 *    - Goal entry count matching the submitted score for each team.
 *    - The "player can't receive a 3rd Yellow Card" rule.
 *    - The "2nd Yellow Card auto-generates a Red Card" rule.
 *    All three currently live ONLY in the browser's JavaScript
 *    (se_stats_app / index.html), not in server.js. A raw API call
 *    bypassing the UI could submit a mismatched goal count, a 3rd yellow
 *    card, or two yellow cards with no accompanying red card, and the
 *    server would accept it without complaint. Given the app has no
 *    login (by design), this is a real gap worth a deliberate decision:
 *    add server-side enforcement of these three rules too, or explicitly
 *    accept client-side-only enforcement as sufficient given the trust
 *    model already in place for this app.
 */
