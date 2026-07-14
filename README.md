# Symmetry — Workout of the Day

A small static web app for your workouts, driven by a fixed **sequential rotation** — not a weekly calendar. Whatever you finish today, the app shows the next thing in the rotation next time you open it, no matter what day of the week that happens to be.

- **Strength days** — exercises, sets, adjustable load, rest timer between sets.
- **Intervals** — e.g. the Norwegian 4x4 (warm-up, 4 rounds of hard work / easy recovery, cool-down).
- **Note days** — running, rest, or anything else with no structured tracking, just a reminder screen.

The app looks at where you left off (stored in Supabase) and shows that workout by default. Use the **Workout** picker at the top to jump to any entry in the rotation ad-hoc (e.g. to redo an earlier day, or skip ahead) — tapping **Mark Done** on whatever you picked advances the pointer to right after that entry, regardless of where it was before.

## Progress and history

- **In-progress sets** are saved as you check them off, so reloading the page — or opening the app on a different device — doesn't lose your place; it resumes at the first exercise that isn't fully done yet.
- **Mark Done** on a finished strength workout, a finished interval workout, or a note day logs it to your history and advances the rotation to the next entry.
- **Log** (top right) opens a running history of every workout you've marked done, most recent first, with the date.

All of this — rotation position, in-progress sets, history, and per-exercise load — lives in a Supabase project and is the single source of truth, so it's the same on every device/browser you open the app in. `app.js` talks to Supabase directly over its public anon key; see `supabase/schema.sql` for the tables and RLS policies. Since there's no login system, that key grants full read/write access — fine for a personal tracker, not something to reuse for a multi-user app.

## Editing the rotation

`data/schedule.json` holds an ordered `rotation` array. The app works through it front-to-back, wrapping back to the start after the last entry:

```json
{
  "rotation": [
    { "type": "strength", "ref": "day1" },
    { "type": "intervals", "ref": "norwegian4x4" },
    { "type": "note", "label": "Running", "note": "Easy run today." }
  ]
}
```

- `type: "strength"` — `ref` points to a key in `data/program.json`.
- `type: "intervals"` — `ref` points to a key in `data/intervals.json`.
- `type: "note"` — no timer, just shows `label` and `note` (used for running/rest days, or anything else you don't want tracked in detail).

Reordering, inserting, or removing entries takes effect the next time the app loads — your stored rotation position is just an index into this array, so edit it when you're at the start of a cycle to avoid landing on an unexpected entry.

## Editing strength days

`data/program.json` is keyed by day id (`day1`, `day2`, ...). Each exercise:

```json
{ "name": "Leg Press", "option": "Uni · Triple Xt", "load": 45, "sets": 3, "repsMax": 7, "rest": 120 }
```

- `load` — starting weight in lb. Once adjusted in the app, your last-used weight for that exercise **name** is remembered (Supabase) and carries across days/sessions/devices.
- `sets` / `repsMax` — number of sets and the rep target shown per set ("Up to 7 reps").
- `rest` — rest duration in seconds after completing a set.

## Editing interval workouts

`data/intervals.json` is keyed by workout id (referenced from `schedule.json`):

```json
{
  "norwegian4x4": {
    "label": "Norwegian 4x4",
    "note": "Bike, row, or run.",
    "warmupSeconds": 600,
    "rounds": 4,
    "workSeconds": 240,
    "recoverySeconds": 180,
    "cooldownSeconds": 300
  }
}
```

`warmupSeconds`/`cooldownSeconds` are optional (omit or set to 0 to skip). The app builds a phase-by-phase timer: warm-up → (work → recovery) × rounds, skipping the final recovery → cool-down → complete. Tap Start when you're ready; each phase auto-advances when its countdown hits zero, or tap Skip to move on early.

## Running locally

No build step. From this directory:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Setting up Supabase

Run `supabase/schema.sql` once in your Supabase project's SQL Editor to create the `workout_state`, `workout_history`, and `exercise_loads` tables with their RLS policies. Then set `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of `app.js` to your project's values (Settings → API).

## Known limitations (v1)

- Reloading mid-interval-workout resets the timer's current phase (only strength-day set progress survives a reload).
- No sound or vibration — timer feedback is visual only.
- The app needs network connectivity to Supabase to load or save anything — there's no offline fallback.
- The Supabase anon key is embedded in `app.js` and grants full read/write to anyone who has it, gated only by RLS policies that allow anyone with the key — appropriate for a personal, single-user tracker, not a shared or public deployment.
