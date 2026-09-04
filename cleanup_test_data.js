// USCCS Test Data Cleanup
//
// Removes synthetic rows left behind by matchday.test.js and admin.test.js
// (both apps share the same Supabase database). The test suites deliberately
// don't clean up after themselves (see their own header comments - low
// real-world harm, since synthetic IDs are clearly distinguishable), but
// this script exists so cleanup is a one-command action instead of manual
// SQL each time.
//
// Test data is identified by the same patterns the test suites themselves
// use to generate it:
//   - team_name = 'Test Team' or name = 'Test Player' (admin.test.js)
//   - IDs prefixed 'test-' (both suites - team IDs, player IDs, game IDs)
//
// Usage:
//   DATABASE_URL="postgresql://..." node cleanup-test-data.js
//
//   Add --dry-run to only PREVIEW what would be deleted, without deleting
//   anything:
//   DATABASE_URL="..." node cleanup-test-data.js --dry-run

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
    console.error('ERROR: set DATABASE_URL (or TEST_DATABASE_URL) before running this script.');
    process.exit(1);
  }

  console.log(DRY_RUN ? '=== DRY RUN - nothing will actually be deleted ===\n' : '=== Cleaning up test data ===\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Order matters - children before parents, to respect foreign keys.

    // 1. Suspensions tied to test entries
    const suspensions = await runStep(
      client,
      'suspensions',
      `SELECT id FROM suspensions WHERE entry_id IN (
         SELECT id FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'
       )`,
      `DELETE FROM suspensions WHERE entry_id IN (
         SELECT id FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'
       )`
    );

    // 2. Misconduct reviews tied to test entries
    const reviews = await runStep(
      client,
      'misconduct_reviews',
      `SELECT id FROM misconduct_reviews WHERE entry_id IN (
         SELECT id FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'
       )`,
      `DELETE FROM misconduct_reviews WHERE entry_id IN (
         SELECT id FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'
       )`
    );

    // 3. Match report entries themselves
    const entries = await runStep(
      client,
      'match_report_entries',
      `SELECT id FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'`,
      `DELETE FROM match_report_entries WHERE team_name = 'Test Team' OR name = 'Test Player' OR team_id LIKE 'test-%'`
    );

    // 4. Match report scores (test games)
    const scores = await runStep(
      client,
      'match_report_scores',
      `SELECT id FROM match_report_scores WHERE game_id LIKE 'test-game-%'`,
      `DELETE FROM match_report_scores WHERE game_id LIKE 'test-game-%'`
    );

    // 5. Check-in data (test games)
    const checkins = await runStep(
      client,
      'checkins',
      `SELECT id FROM checkins WHERE game_id LIKE 'test-game-%'`,
      `DELETE FROM checkins WHERE game_id LIKE 'test-game-%'`
    );

    const checkinCompletion = await runStep(
      client,
      'checkin_completion',
      `SELECT id FROM checkin_completion WHERE game_id LIKE 'test-game-%'`,
      `DELETE FROM checkin_completion WHERE game_id LIKE 'test-game-%'`
    );

    if (DRY_RUN) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }

    const total = suspensions + reviews + entries + scores + checkins + checkinCompletion;
    console.log(`\n${DRY_RUN ? 'Would delete' : 'Deleted'} ${total} total row(s) across all tables.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nERROR during cleanup - nothing was deleted (transaction rolled back):', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

async function runStep(client, tableName, previewQuery, deleteQuery) {
  const preview = await client.query(previewQuery);
  const count = preview.rowCount;
  console.log(`${tableName}: ${count} row(s) ${DRY_RUN ? 'would be' : 'to be'} deleted`);
  if (count > 0 && !DRY_RUN) {
    await client.query(deleteQuery);
  }
  return count;
}

main();
