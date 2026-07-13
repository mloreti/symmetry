const RING_CIRCUMFERENCE = 565.5;
const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_LABELS = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
};

function $(id) { return document.getElementById(id); }

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Shared drift-proof countdown: deadline-based, recomputed from Date.now() on
// every tick and whenever the tab regains visibility, so backgrounding the
// tab (phone lock, app switch) can't cause the displayed time to drift or
// freeze. Only one countdown runs at a time in this app.
// ---------------------------------------------------------------------------
let countdown = null; // { endAt, tick, intervalId } | null

function startCountdown(seconds, { onTick, onDone }) {
  clearCountdown();
  const endAt = Date.now() + seconds * 1000;
  const tick = () => {
    const remainingMs = endAt - Date.now();
    const remaining = Math.max(0, Math.round(remainingMs / 1000));
    onTick(remaining, seconds);
    if (remainingMs <= 0) {
      clearCountdown();
      onDone();
    }
  };
  countdown = { endAt, tick, intervalId: setInterval(tick, 1000) };
  tick();
}
function clearCountdown() {
  if (countdown) {
    clearInterval(countdown.intervalId);
    countdown = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && countdown) countdown.tick();
});

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path} (HTTP ${res.status}).`);
  return res.json();
}

function showError(message) {
  $('app').hidden = true;
  $('error').hidden = false;
  $('error-detail').textContent = message;
}

// ---------------------------------------------------------------------------
// Strength screen (sets/reps/load days)
// ---------------------------------------------------------------------------
const sEl = {
  screen: $('screen-strength'),
  dayLabel: $('s-day-label'),
  progressLabel: $('s-progress-label'),
  dots: $('s-dots'),
  prevBtn: $('s-prev-btn'),
  nextBtn: $('s-next-btn'),
  optionLabel: $('s-option-label'),
  exerciseName: $('s-exercise-name'),
  loadValue: $('s-load-value'),
  loadDec: $('s-load-dec'),
  loadInc: $('s-load-inc'),
  restView: $('s-rest-view'),
  setsView: $('s-sets-view'),
  setsList: $('s-sets-list'),
  ringProgress: $('s-ring-progress'),
  restCountdown: $('s-rest-countdown'),
  skipRestBtn: $('s-skip-rest-btn'),
  completeBanner: $('s-complete-banner'),
  advanceBtn: $('s-advance-btn'),
};

let sState = {
  day: null,
  weekdayLabel: '',
  exerciseIndex: 0,
  setsDone: [],
  loads: [],
  resting: false,
  restRemaining: 0,
  restTotal: 0,
};

function loadKey(name) {
  return `symmetry:load:${name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}
function persistLoad(name, value) { localStorage.setItem(loadKey(name), String(value)); }
function readPersistedLoad(name) {
  const raw = localStorage.getItem(loadKey(name));
  return raw === null ? null : Number(raw);
}

function sCurrentExercise() { return sState.day.exercises[sState.exerciseIndex]; }
function sIsFirst() { return sState.exerciseIndex === 0; }
function sIsLast() { return sState.exerciseIndex === sState.day.exercises.length - 1; }
function sAllDoneThis() { return sState.setsDone[sState.exerciseIndex].every(Boolean); }
function sIsWorkoutDone() { return sIsLast() && sAllDoneThis(); }
function sAdvanceLabel() { return sIsLast() ? 'Finish' : (sAllDoneThis() ? 'Next exercise' : 'Skip to next'); }

function initStrength(day, weekdayLabel) {
  sState.day = day;
  sState.weekdayLabel = weekdayLabel;
  sState.exerciseIndex = 0;
  sState.setsDone = day.exercises.map(e => Array(e.sets).fill(false));
  sState.loads = day.exercises.map(e => readPersistedLoad(e.name) ?? e.load);

  sEl.prevBtn.addEventListener('click', sGoPrev);
  sEl.nextBtn.addEventListener('click', sGoNext);
  sEl.loadDec.addEventListener('click', () => sBumpLoad(-5));
  sEl.loadInc.addEventListener('click', () => sBumpLoad(5));
  sEl.skipRestBtn.addEventListener('click', sSkipRest);
  sEl.advanceBtn.addEventListener('click', sAdvance);
  sEl.setsList.addEventListener('click', (e) => {
    const row = e.target.closest('.set-row');
    if (row) sToggleSet(Number(row.dataset.setIndex));
  });

  sEl.screen.hidden = false;
  sRender();
}

function sBumpLoad(delta) {
  sState.loads[sState.exerciseIndex] = Math.max(0, sState.loads[sState.exerciseIndex] + delta);
  persistLoad(sCurrentExercise().name, sState.loads[sState.exerciseIndex]);
  sRender();
}

function sToggleSet(setIdx) {
  const wasDone = sState.setsDone[sState.exerciseIndex][setIdx];
  sState.setsDone[sState.exerciseIndex][setIdx] = !wasDone;
  // Skip the rest timer on the set that finishes the entire workout — nothing
  // left to rest for once it's already showing "Workout complete".
  if (!wasDone && !sIsWorkoutDone()) sStartRest();
  sRender();
}

function sGoPrev() {
  sState.exerciseIndex = Math.max(0, sState.exerciseIndex - 1);
  sSkipRest();
  sRender();
}
function sGoNext() {
  const n = sState.day.exercises.length;
  sState.exerciseIndex = Math.min(n - 1, sState.exerciseIndex + 1);
  sSkipRest();
  sRender();
}
function sAdvance() {
  if (sState.exerciseIndex < sState.day.exercises.length - 1) sGoNext();
}

function sStartRest() {
  sState.resting = true;
  startCountdown(sCurrentExercise().rest, {
    onTick: (remaining, total) => {
      sState.restRemaining = remaining;
      sState.restTotal = total;
      sRender();
    },
    onDone: () => {
      sState.resting = false;
      sRender();
    },
  });
}
function sSkipRest() {
  clearCountdown();
  sState.resting = false;
  sState.restRemaining = 0;
  sRender();
}

function sRender() {
  const day = sState.day;
  const ex = sCurrentExercise();

  sEl.dayLabel.textContent = `${sState.weekdayLabel} · ${day.dayLabel}`;
  sEl.progressLabel.textContent = `${sState.exerciseIndex + 1} of ${day.exercises.length}`;
  sRenderDots();

  sEl.prevBtn.disabled = sIsFirst();
  sEl.nextBtn.disabled = sIsLast();
  sEl.optionLabel.textContent = ex.option || '';
  sEl.exerciseName.textContent = ex.name;
  sEl.loadValue.textContent = `${sState.loads[sState.exerciseIndex]} lb`;

  sEl.restView.hidden = !sState.resting;
  sEl.setsView.hidden = sState.resting;
  if (sState.resting) {
    sRenderRestView();
  } else {
    sRenderSetsList();
  }

  const done = sIsWorkoutDone();
  sEl.completeBanner.hidden = !done;
  sEl.advanceBtn.hidden = done;
  if (!done) {
    sEl.advanceBtn.textContent = sAdvanceLabel();
    sEl.advanceBtn.classList.toggle('primary', sAllDoneThis());
    sEl.advanceBtn.classList.toggle('muted', !sAllDoneThis());
  }
}

function sRenderDots() {
  const day = sState.day;
  sEl.dots.innerHTML = day.exercises.map((_, i) => {
    const cls = i < sState.exerciseIndex ? 'passed' : i === sState.exerciseIndex ? 'current' : 'upcoming';
    return `<span class="dot ${cls}"></span>`;
  }).join('');
}

function sRenderSetsList() {
  const ex = sCurrentExercise();
  const done = sState.setsDone[sState.exerciseIndex];
  sEl.setsList.innerHTML = done.map((isDone, i) => `
    <button class="set-row ${isDone ? 'done' : ''}" data-set-index="${i}">
      <span class="set-circle ${isDone ? 'done' : ''}">${isDone ? '&#10003;' : i + 1}</span>
      <span class="set-copy">
        <span class="set-title">Set ${i + 1}</span><br>
        <span class="set-subtitle">Up to ${ex.repsMax} reps</span>
      </span>
      <span class="set-status ${isDone ? 'done' : ''}">${isDone ? 'Done' : 'Tap'}</span>
    </button>`).join('');
}

function sRenderRestView() {
  const frac = sState.restTotal > 0 ? sState.restRemaining / sState.restTotal : 0;
  sEl.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * frac);
  sEl.restCountdown.textContent = formatMMSS(sState.restRemaining);
}

function validateStrengthDay(day, id) {
  if (!Array.isArray(day.exercises) || day.exercises.length === 0) {
    throw new Error(`program.json "${id}": "exercises" must be a non-empty array.`);
  }
  day.exercises.forEach((exercise, ei) => {
    if (!exercise.name) throw new Error(`program.json "${id}", exercise ${ei + 1}: missing "name".`);
    if (!Number.isInteger(exercise.sets) || exercise.sets <= 0) {
      throw new Error(`program.json "${id}", "${exercise.name}": "sets" must be a positive integer.`);
    }
    if (!Number.isInteger(exercise.repsMax) || exercise.repsMax <= 0) {
      throw new Error(`program.json "${id}", "${exercise.name}": "repsMax" must be a positive integer.`);
    }
    if (!Number.isFinite(exercise.rest) || exercise.rest < 0) {
      throw new Error(`program.json "${id}", "${exercise.name}": "rest" must be a non-negative number.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Intervals screen (timed work/recovery protocols, e.g. Norwegian 4x4)
// ---------------------------------------------------------------------------
const iEl = {
  screen: $('screen-intervals'),
  dayLabel: $('i-day-label'),
  title: $('i-title'),
  note: $('i-note'),
  startView: $('i-start-view'),
  summary: $('i-summary'),
  startBtn: $('i-start-btn'),
  phaseView: $('i-phase-view'),
  phaseLabel: $('i-phase-label'),
  ringProgress: $('i-ring-progress'),
  countdown: $('i-countdown'),
  nextLabel: $('i-next-label'),
  skipBtn: $('i-skip-btn'),
  completeView: $('i-complete-view'),
};

let iState = {
  phases: [],
  phaseIndex: -1, // -1 = not started
  remaining: 0,
  total: 0,
};

function buildIntervalPhases(workout) {
  const phases = [];
  if (workout.warmupSeconds > 0) phases.push({ seconds: workout.warmupSeconds, label: 'Warm-up' });
  for (let r = 1; r <= workout.rounds; r++) {
    phases.push({ seconds: workout.workSeconds, label: `Round ${r} of ${workout.rounds} — Work` });
    if (r < workout.rounds && workout.recoverySeconds > 0) {
      phases.push({ seconds: workout.recoverySeconds, label: 'Recovery' });
    }
  }
  if (workout.cooldownSeconds > 0) phases.push({ seconds: workout.cooldownSeconds, label: 'Cool-down' });
  return phases;
}

function describeIntervalSummary(workout, phases) {
  const totalMin = Math.round(phases.reduce((sum, p) => sum + p.seconds, 0) / 60);
  return `${workout.rounds} rounds of ${formatMMSS(workout.workSeconds)} work / ${formatMMSS(workout.recoverySeconds || 0)} recovery · ~${totalMin} min total`;
}

function initIntervals(workout, weekdayLabel) {
  const phases = buildIntervalPhases(workout);
  iState.phases = phases;
  iState.phaseIndex = -1;

  iEl.dayLabel.textContent = weekdayLabel;
  iEl.title.textContent = workout.label;
  iEl.note.textContent = workout.note || '';
  iEl.summary.textContent = describeIntervalSummary(workout, phases);

  iEl.startBtn.addEventListener('click', iStart);
  iEl.skipBtn.addEventListener('click', iSkipPhase);

  iEl.screen.hidden = false;
  iRender();
}

function iStart() {
  iState.phaseIndex = 0;
  iStartCurrentPhase();
  iRender();
}

function iStartCurrentPhase() {
  const phase = iState.phases[iState.phaseIndex];
  startCountdown(phase.seconds, {
    onTick: (remaining, total) => {
      iState.remaining = remaining;
      iState.total = total;
      iRender();
    },
    onDone: iAdvancePhase,
  });
}

function iAdvancePhase() {
  clearCountdown();
  iState.phaseIndex += 1;
  if (iState.phaseIndex < iState.phases.length) {
    iStartCurrentPhase();
  }
  iRender();
}
function iSkipPhase() { iAdvancePhase(); }

function iRender() {
  const notStarted = iState.phaseIndex === -1;
  const done = iState.phaseIndex >= iState.phases.length;
  const inProgress = !notStarted && !done;

  iEl.startView.hidden = !notStarted;
  iEl.phaseView.hidden = !inProgress;
  iEl.completeView.hidden = !done;

  if (inProgress) {
    const phase = iState.phases[iState.phaseIndex];
    const next = iState.phases[iState.phaseIndex + 1];
    iEl.phaseLabel.textContent = phase.label;
    iEl.nextLabel.textContent = next ? `Next: ${next.label}` : 'Next: Finish';
    const frac = iState.total > 0 ? iState.remaining / iState.total : 0;
    iEl.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * frac);
    iEl.countdown.textContent = formatMMSS(iState.remaining);
  }
}

function validateIntervalWorkout(workout, id) {
  if (!workout.label) throw new Error(`intervals.json "${id}": missing "label".`);
  if (!Number.isInteger(workout.rounds) || workout.rounds <= 0) {
    throw new Error(`intervals.json "${id}": "rounds" must be a positive integer.`);
  }
  if (!Number.isFinite(workout.workSeconds) || workout.workSeconds <= 0) {
    throw new Error(`intervals.json "${id}": "workSeconds" must be a positive number.`);
  }
  ['warmupSeconds', 'recoverySeconds', 'cooldownSeconds'].forEach((key) => {
    if (workout[key] !== undefined && (!Number.isFinite(workout[key]) || workout[key] < 0)) {
      throw new Error(`intervals.json "${id}": "${key}" must be a non-negative number.`);
    }
  });
}

// ---------------------------------------------------------------------------
// Note screen (running day, rest day, or anything with no structured timer)
// ---------------------------------------------------------------------------
const nEl = {
  screen: $('screen-note'),
  dayLabel: $('n-day-label'),
  title: $('n-title'),
  note: $('n-note'),
};

function initNote(entry, weekdayLabel) {
  nEl.dayLabel.textContent = weekdayLabel;
  nEl.title.textContent = entry.label;
  nEl.note.textContent = entry.note || '';
  nEl.screen.hidden = false;
}

// ---------------------------------------------------------------------------
// Boot: resolve today's weekday against schedule.json, then route to the
// right screen type.
// ---------------------------------------------------------------------------
function validateSchedule(schedule) {
  WEEKDAY_KEYS.forEach((key) => {
    const entry = schedule[key];
    if (!entry) throw new Error(`schedule.json is missing an entry for "${key}".`);
    if (!['strength', 'intervals', 'note'].includes(entry.type)) {
      throw new Error(`schedule.json "${key}": unknown type "${entry.type}".`);
    }
    if ((entry.type === 'strength' || entry.type === 'intervals') && !entry.ref) {
      throw new Error(`schedule.json "${key}": type "${entry.type}" requires a "ref".`);
    }
    if (entry.type === 'note' && !entry.label) {
      throw new Error(`schedule.json "${key}": type "note" requires a "label".`);
    }
  });
}

async function boot() {
  let schedule, program, intervalsData;
  try {
    [schedule, program, intervalsData] = await Promise.all([
      fetchJson('data/schedule.json'),
      fetchJson('data/program.json'),
      fetchJson('data/intervals.json'),
    ]);
    validateSchedule(schedule);
  } catch (err) {
    showError(err.message);
    return;
  }

  const todayKey = WEEKDAY_KEYS[new Date().getDay()];
  const entry = schedule[todayKey];
  const weekdayLabel = WEEKDAY_LABELS[todayKey];

  try {
    if (entry.type === 'strength') {
      const day = program[entry.ref];
      if (!day) throw new Error(`schedule.json references unknown strength day "${entry.ref}".`);
      validateStrengthDay(day, entry.ref);
      $('app').hidden = false;
      initStrength(day, weekdayLabel);
    } else if (entry.type === 'intervals') {
      const workout = intervalsData[entry.ref];
      if (!workout) throw new Error(`schedule.json references unknown interval workout "${entry.ref}".`);
      validateIntervalWorkout(workout, entry.ref);
      $('app').hidden = false;
      initIntervals(workout, weekdayLabel);
    } else {
      $('app').hidden = false;
      initNote(entry, weekdayLabel);
    }
  } catch (err) {
    showError(err.message);
  }
}

boot();
