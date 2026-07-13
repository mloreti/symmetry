# Symmetry — Workout of the Day

A small static web app for your daily workout, driven by a fixed weekly schedule:

- **Monday / Tuesday / Thursday / Friday** — strength days (exercises, sets, adjustable load, rest timer between sets).
- **Wednesday** — Norwegian 4x4 interval workout (warm-up, 4 rounds of hard work / easy recovery, cool-down).
- **Saturday** — running (no structured tracking here — just a reminder screen).
- **Sunday** — rest day.

The app looks at today's date, checks `data/schedule.json` to see what kind of day it is, and shows that screen by default. If you skipped a day, use the **Workout** picker at the top to switch to any other workout ad-hoc — the weekday label still shows the real day, just paired with whatever content you picked.

## Editing your schedule

`data/schedule.json` maps each weekday to a day type:

```json
"monday": { "type": "strength", "ref": "day1" },
"wednesday": { "type": "intervals", "ref": "norwegian4x4" },
"saturday": { "type": "note", "label": "Running", "note": "Easy run today." }
```

- `type: "strength"` — `ref` points to a key in `data/program.json`.
- `type: "intervals"` — `ref` points to a key in `data/intervals.json`.
- `type: "note"` — no timer, just shows `label` and `note` (used for running/rest days, or anything else you don't want tracked in detail).

## Editing strength days

`data/program.json` is keyed by day id (`day1`, `day2`, ...). Each exercise:

```json
{ "name": "Leg Press", "option": "Uni · Triple Xt", "load": 45, "sets": 3, "repsMax": 7, "rest": 120 }
```

- `load` — starting weight in lb. Once adjusted in the app, your last-used weight for that exercise **name** is remembered (localStorage) and carries across days/sessions.
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

## Known limitations (v1)

- Reloading mid-workout resets your current exercise/set/phase progress for that visit (only load overrides persist).
- No sound or vibration — timer feedback is visual only.
- Switching workouts via the picker isn't remembered across a reload — it resets to today's scheduled default (consistent with the point above).
