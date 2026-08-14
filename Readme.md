# MatchDay — Check-In & Match Report App

A mobile-first web app for USCCS game-day check-in and match reporting. No login — access is via a per-game deep link (`?game=<uid>`), protected by whatever authenticated portal distributes the link.

## Architecture

- **Server:** Node.js, zero framework dependencies except `pg` (Postgres driver). Single `server.js` serving both the API and the static `index.html`.
- **Database:** Postgres (Supabase). Tables: `checkins`, `checkin_completion`, `match_report_scores`, `match_report_entries`, `suspensions`.
- **External integration:** SportsEngine GraphQL API — event/roster lookup, and the `updateScore` mutation on submit.
- **Frontend:** Single HTML file, vanilla JS, no build step.

### Required environment variables

| Variable | Purpose |
|---|---|
| `SE_CLIENT_ID`, `SE_CLIENT_SECRET`, `SE_REFRESH_TOKEN` | SportsEngine OAuth credentials (shared token, refreshed manually via Postman when it expires) |
| `SE_ORG_ID` | USCCS's SportsEngine org ID |
| `DATABASE_URL` | Supabase Postgres connection string (pooler, IPv4-compatible — see deployment notes below) |
| `MAX_PLAYERS_CHECKIN`, `MAX_STAFF_CHECKIN` | Per-team check-in caps |
| `PORT` | Usually set automatically by the host |

## Workflows

### 1. Deep link → landing page
Visiting `?game=<sportsengine-event-uid>` resolves the event and both teams' full rosters in one call, then shows a landing page with **Check In** and **Submit Match Report** buttons. Match Report stays disabled until at least one person is checked in.

### 2. Check-In
- Select one team at a time (tiles double as the switcher — never both rosters shown at once).
- **Players:** typing a jersey number *is* the check-in action — no separate checkbox. Required, must be unique within that team (not across teams), enforced client-side for instant feedback and server-side (via an advisory lock) as the real guarantee against race conditions.
- **Staff:** simple checkbox, no jersey number.
- Caps enforced per team, per role; the next empty slot auto-disables once reached.
- **Done/Edit** is a persisted flag (`checkin_completion` table) — grays out the roster and survives a page reload; Edit reverts it.

### 3. Match Report
- **Goals:** enter each team's score first — that many goal "slots" appear automatically. Click an empty slot to assign a scorer + minute. Submission is blocked unless the goal count exactly matches the score.
- **Misconduct:** Yellow/Red Card sections are unified across both teams (not per-team tabs) — the picker asks which team first, then person, then minute, then (Yellow/Red) a reason from a fixed list.
  - A player's **2nd Yellow Card** in the game auto-generates a Red Card (reason "2nd Caution", same minute) — this auto-generated card **cannot be removed directly**; only removing the triggering Yellow Card removes it.
  - A **3rd Yellow Card** for the same player is blocked outright.
  - Every **Red Card** (except "2nd Caution") requires a supplemental report (free-text incident description) before it can be added.
  - Submitting with **zero cards recorded** for either team triggers a confirmation popup ("confirm no misconduct?") before proceeding.
- **No resubmission, ever.** Once a match report is submitted for a game, the view locks permanently into a read-only summary. A second submission attempt is rejected outright (`409`). This is deliberate — see "Suspension auto-creation" below for why.
- **Auto-suspension creation:** every submitted Red Card automatically creates a row in `suspensions` at a **standard games** value (looked up by reason — see `STANDARD_SUSPENSION_GAMES` in `server.js`), *before* any human review happens. `gameDate` is required on the payload whenever a Red Card is present — the server rejects the submission outright if it's missing, rather than silently skipping suspension creation (a missing suspension for a real incident would be a serious, easy-to-miss integrity gap).

### Standard suspension lengths (by reason)
| Reason | Standard games |
|---|---|
| Serious Foul Play, DOGSO-F, DOGSO-H, 2nd Caution | 1 |
| Violent Conduct, Abusive Language, Biting or Spitting | 3 |

## Running the automated tests

```bash
npm install
TEST_BASE_URL=https://your-matchday-deployment.onrender.com npm test
```

Uses Node's built-in test runner (`node --test`) — no external test framework. Every test generates its own random synthetic `game_id`/`team_id`/`profile_id`, so it's safe to run repeatedly against a live deployment without colliding with real data (though rows aren't auto-cleaned up — see the file's own header comments for details).

**What's covered:** check-in add/remove, cap enforcement, jersey-number uniqueness (same team vs. different team), the completion flag's persistence, Yellow/Red Card reason validation, the supplemental-report requirement, the no-resubmission lock (submits once, second attempt rejected, original data untouched), and graceful handling when the real SportsEngine score push fails.

**What's NOT covered by automation** (needs manual testing — see `matchday_test_plan.md`): the real SportsEngine roster fetch and `updateScore` push against a real game, all mobile/visual UI behavior, and multi-device concurrency scenarios.

**Known, deliberate gap:** goal-count-matches-score, the 3rd-yellow-card block, and the 2nd-yellow-auto-red-card rule are enforced **client-side only** — not re-verified server-side. Given this app has no login by design, a raw API call could bypass these. Documented in the test file's closing comment as a deliberate, revisitable trade-off.
