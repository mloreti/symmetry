const RING_CIRCUMFERENCE = 565.5;

function $(id) { return document.getElementById(id); }

function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function todayLabel() {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
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
// Persistent storage: Supabase is the source of truth for the sequential
// program pointer, in-progress session (so a reload doesn't lose checked-off
// sets), the completed-workout log, and per-exercise load. Everything is
// pulled into local caches once at boot and written through (fire-and-forget)
// on every change, so the UI stays synchronous while Supabase stays current.
// ---------------------------------------------------------------------------
const SUPABASE_URL = 'https://rhpfwykjysgcckekmpcu.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_cdGBfmnlYn9VJIcTUO5oFA_YHoKHkaf';

let supabaseClient = null;
let workoutStateCache = { current_index: 0, session: null };
let historyCache = [];
let loadsCache = {};

// Fire-and-forget writes to the same row can arrive at Supabase out of
// order (e.g. rapid +/- taps on load), silently letting an earlier write
// clobber a later one. Chaining each write per key behind the last one's
// network round-trip keeps arrival order matching call order.
const writeQueues = new Map();
function queueWrite(key, performWrite) {
  const prevSettled = (writeQueues.get(key) || Promise.resolve()).catch(() => {});
  const thisWrite = prevSettled.then(performWrite);
  writeQueues.set(key, thisWrite);
  return thisWrite;
}

function readProgramState() { return { currentIndex: workoutStateCache.current_index }; }
function writeProgramState(state) {
  workoutStateCache.current_index = state.currentIndex;
  queueWrite('workout_state', () => supabaseClient.from('workout_state')
    .update({ current_index: state.currentIndex, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .then(({ error }) => { if (error) console.error('Failed to sync program state:', error.message); }));
}

function readSession() { return workoutStateCache.session; }
function writeSession(session) {
  workoutStateCache.session = session;
  queueWrite('workout_state', () => supabaseClient.from('workout_state')
    .update({ session, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .then(({ error }) => { if (error) console.error('Failed to sync session:', error.message); }));
}
function clearSessionIfIndex(index) {
  if (workoutStateCache.session && workoutStateCache.session.index === index) {
    writeSession(null);
  }
}

function readHistory() { return historyCache; }

function resolveEntryLabel(entry) {
  if (entry.type === 'strength') return programData[entry.ref]?.dayLabel ?? entry.ref;
  if (entry.type === 'intervals') return intervalsDataGlobal[entry.ref]?.label ?? entry.ref;
  return entry.label;
}

// Logs a completed workout to history and advances the sequential pointer to
// whatever follows the completed entry — regardless of where the pointer was
// before (so picking an out-of-order workout and finishing it "counts").
function logCompletion(index) {
  const entry = rotationData[index];
  const type = entry.type;
  const label = resolveEntryLabel(entry);

  const optimisticRow = { date: new Date().toISOString(), index, type, label };
  historyCache = [optimisticRow, ...historyCache];

  supabaseClient.from('workout_history')
    .insert({ entry_index: index, type, label })
    .select()
    .single()
    .then(({ data, error }) => {
      if (error) { console.error('Failed to log workout:', error.message); return; }
      const i = historyCache.indexOf(optimisticRow);
      if (i !== -1) {
        historyCache[i] = { date: data.completed_at, index: data.entry_index, type: data.type, label: data.label };
      }
    });

  const programState = readProgramState();
  programState.currentIndex = (index + 1) % rotationData.length;
  writeProgramState(programState);

  clearSessionIfIndex(index);
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
  index: null,
  dateLabel: '',
  exerciseIndex: 0,
  setsDone: [],
  loads: [],
  logged: false,
  resting: false,
  restRemaining: 0,
  restTotal: 0,
};

function persistLoad(name, value) {
  loadsCache[name] = value;
  queueWrite(`load:${name}`, () => supabaseClient.from('exercise_loads')
    .upsert({ name, load: value, updated_at: new Date().toISOString() })
    .then(({ error }) => { if (error) console.error('Failed to sync load:', error.message); }));
}
function readPersistedLoad(name) {
  return name in loadsCache ? loadsCache[name] : null;
}

function strengthSessionValid(session, index, day) {
  return !!session && session.index === index && Array.isArray(session.setsDone) &&
    session.setsDone.length === day.exercises.length &&
    session.setsDone.every((arr, i) => Array.isArray(arr) && arr.length === day.exercises[i].sets);
}

function sCurrentExercise() { return sState.day.exercises[sState.exerciseIndex]; }
function sIsFirst() { return sState.exerciseIndex === 0; }
function sIsLast() { return sState.exerciseIndex === sState.day.exercises.length - 1; }
function sAllDoneThis() { return sState.setsDone[sState.exerciseIndex].every(Boolean); }
function sIsWorkoutDone() { return sIsLast() && sAllDoneThis(); }
function sAdvanceLabel() { return sIsLast() ? 'Finish' : (sAllDoneThis() ? 'Next exercise' : 'Skip to next'); }

function bindStrengthListenersOnce() {
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
}

function loadStrengthDay(day, index, dateLabel) {
  sState.day = day;
  sState.index = index;
  sState.dateLabel = dateLabel;

  const session = readSession();
  sState.setsDone = strengthSessionValid(session, index, day)
    ? session.setsDone.map(arr => arr.slice())
    : day.exercises.map(e => Array(e.sets).fill(false));

  // Resume at the first exercise that isn't fully done yet, so returning
  // after a reload drops you right back where you left off.
  const firstIncomplete = sState.setsDone.findIndex(arr => !arr.every(Boolean));
  sState.exerciseIndex = firstIncomplete === -1 ? sState.setsDone.length - 1 : firstIncomplete;

  sState.loads = day.exercises.map(e => readPersistedLoad(e.name) ?? e.load);
  sState.logged = false;
  sState.resting = false;
  sState.restRemaining = 0;
  sState.restTotal = 0;

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
  writeSession({ index: sState.index, setsDone: sState.setsDone });
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
  if (sIsWorkoutDone()) {
    if (!sState.logged) {
      logCompletion(sState.index);
      sState.logged = true;
      sRender();
    }
    return;
  }
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

  sEl.dayLabel.textContent = `${sState.dateLabel} · ${day.dayLabel}`;
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
  if (done) {
    sEl.completeBanner.textContent = sState.logged ? 'Logged ✓ \u{1F389}' : 'Workout complete \u{1F389}';
    sEl.advanceBtn.hidden = sState.logged;
    sEl.advanceBtn.textContent = 'Mark Done';
    sEl.advanceBtn.classList.add('primary');
    sEl.advanceBtn.classList.remove('muted');
  } else {
    sEl.advanceBtn.hidden = false;
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
  completeBanner: $('i-complete-banner'),
  logBtn: $('i-log-btn'),
};

let iState = {
  index: null,
  phases: [],
  phaseIndex: -1, // -1 = not started
  remaining: 0,
  total: 0,
  logged: false,
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

function bindIntervalListenersOnce() {
  iEl.startBtn.addEventListener('click', iStart);
  iEl.skipBtn.addEventListener('click', iSkipPhase);
  iEl.logBtn.addEventListener('click', () => {
    if (iState.logged) return;
    logCompletion(iState.index);
    iState.logged = true;
    iRender();
  });
}

function loadIntervalWorkout(workout, index, dateLabel) {
  const phases = buildIntervalPhases(workout);
  iState.index = index;
  iState.phases = phases;
  iState.phaseIndex = -1;
  iState.remaining = 0;
  iState.total = 0;
  iState.logged = false;

  iEl.dayLabel.textContent = dateLabel;
  iEl.title.textContent = workout.label;
  iEl.note.textContent = workout.note || '';
  iEl.summary.textContent = describeIntervalSummary(workout, phases);

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

  if (done) {
    iEl.completeBanner.textContent = iState.logged ? 'Logged ✓ \u{1F389}' : 'Workout complete \u{1F389}';
    iEl.logBtn.hidden = iState.logged;
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
  logBtn: $('n-log-btn'),
};

let nState = { index: null, logged: false };

function bindNoteListenersOnce() {
  nEl.logBtn.addEventListener('click', () => {
    if (nState.logged) return;
    logCompletion(nState.index);
    nState.logged = true;
    nRender();
  });
}

function loadNote(entry, index, dateLabel) {
  nState.index = index;
  nState.logged = false;

  nEl.dayLabel.textContent = dateLabel;
  nEl.title.textContent = entry.label;
  nEl.note.textContent = entry.note || '';
  nEl.screen.hidden = false;
  nRender();
}

function nRender() {
  nEl.logBtn.disabled = nState.logged;
  nEl.logBtn.textContent = nState.logged ? 'Logged ✓' : 'Mark Done';
  nEl.logBtn.classList.toggle('primary', !nState.logged);
  nEl.logBtn.classList.toggle('muted', nState.logged);
}

// ---------------------------------------------------------------------------
// History screen: a read-only log of completed workouts.
// ---------------------------------------------------------------------------
const hEl = {
  screen: $('screen-history'),
  list: $('history-list'),
  openBtn: $('history-open-btn'),
  closeBtn: $('history-close-btn'),
};

let activeScreenEl = null;

function bindHistoryListenersOnce() {
  hEl.openBtn.addEventListener('click', openHistory);
  hEl.closeBtn.addEventListener('click', closeHistory);
}

function formatHistoryDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderHistory() {
  const history = readHistory();
  if (history.length === 0) {
    hEl.list.innerHTML = `<p class="history-empty">No workouts logged yet.</p>`;
    return;
  }
  hEl.list.innerHTML = history.map(item => `
    <div class="history-row">
      <span class="history-label">${item.label}</span>
      <span class="history-date">${formatHistoryDate(item.date)}</span>
    </div>`).join('');
}

function openHistory() {
  activeScreenEl = [sEl.screen, iEl.screen, nEl.screen].find(el => !el.hidden) || null;
  if (activeScreenEl) activeScreenEl.hidden = true;
  renderHistory();
  hEl.screen.hidden = false;
}
function closeHistory() {
  hEl.screen.hidden = true;
  if (activeScreenEl) activeScreenEl.hidden = false;
}

// ---------------------------------------------------------------------------
// Ad-hoc workout picker: the sequential pointer still picks the default, but
// any workout in the rotation can be selected regardless of position (e.g.
// you want to jump ahead or repeat an earlier day). Completing whichever one
// you picked moves the pointer to right after it.
// ---------------------------------------------------------------------------
const pickerEl = $('workout-select');

let programData = null;
let intervalsDataGlobal = null;
let rotationData = null;
let pickerEntries = [];

function buildPickerEntries(rotation) {
  return rotation.map((entry, index) => ({ index, entry, label: resolveEntryLabel(entry) }));
}

function populatePicker(currentIndex) {
  pickerEl.innerHTML = pickerEntries.map(e => `<option value="${e.index}">${e.index + 1}. ${e.label}</option>`).join('');
  pickerEl.value = String(currentIndex);
}

function activateEntry(index) {
  clearCountdown();
  sEl.screen.hidden = true;
  iEl.screen.hidden = true;
  nEl.screen.hidden = true;
  const entry = rotationData[index];
  const dateLabel = todayLabel();
  try {
    if (entry.type === 'strength') {
      const day = programData[entry.ref];
      if (!day) throw new Error(`schedule.json references unknown strength day "${entry.ref}".`);
      validateStrengthDay(day, entry.ref);
      loadStrengthDay(day, index, dateLabel);
    } else if (entry.type === 'intervals') {
      const workout = intervalsDataGlobal[entry.ref];
      if (!workout) throw new Error(`schedule.json references unknown interval workout "${entry.ref}".`);
      validateIntervalWorkout(workout, entry.ref);
      loadIntervalWorkout(workout, index, dateLabel);
    } else {
      loadNote(entry, index, dateLabel);
    }
  } catch (err) {
    showError(err.message);
  }
}

// ---------------------------------------------------------------------------
// Boot: resolve the sequential pointer from Supabase for the default
// selection, then wire up the picker and the (bind-once) screen listeners.
// ---------------------------------------------------------------------------
function validateRotation(rotation) {
  if (!Array.isArray(rotation) || rotation.length === 0) {
    throw new Error('schedule.json "rotation" must be a non-empty array.');
  }
  rotation.forEach((entry, i) => {
    if (!entry || !['strength', 'intervals', 'note'].includes(entry.type)) {
      throw new Error(`schedule.json rotation[${i}]: unknown type "${entry && entry.type}".`);
    }
    if ((entry.type === 'strength' || entry.type === 'intervals') && !entry.ref) {
      throw new Error(`schedule.json rotation[${i}]: type "${entry.type}" requires a "ref".`);
    }
    if (entry.type === 'note' && !entry.label) {
      throw new Error(`schedule.json rotation[${i}]: type "note" requires a "label".`);
    }
  });
}

async function boot() {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  let rotation;
  try {
    let program, intervalsData, stateRow, historyRows, loadRows;
    [rotation, program, intervalsData, stateRow, historyRows, loadRows] = await Promise.all([
      fetchJson('data/schedule.json').then(d => d.rotation),
      fetchJson('data/program.json'),
      fetchJson('data/intervals.json'),
      supabaseClient.from('workout_state').select('*').eq('id', 1).single()
        .then(({ data, error }) => {
          if (error) throw new Error(`Supabase workout_state: ${error.message}`);
          return data;
        }),
      supabaseClient.from('workout_history').select('*').order('completed_at', { ascending: false })
        .then(({ data, error }) => {
          if (error) throw new Error(`Supabase workout_history: ${error.message}`);
          return data;
        }),
      supabaseClient.from('exercise_loads').select('name, load')
        .then(({ data, error }) => {
          if (error) throw new Error(`Supabase exercise_loads: ${error.message}`);
          return data;
        }),
    ]);
    validateRotation(rotation);
    rotationData = rotation;
    programData = program;
    intervalsDataGlobal = intervalsData;

    workoutStateCache = { current_index: stateRow.current_index, session: stateRow.session };
    historyCache = (historyRows || []).map(row => (
      { date: row.completed_at, index: row.entry_index, type: row.type, label: row.label }
    ));
    loadsCache = Object.fromEntries((loadRows || []).map(r => [r.name, Number(r.load)]));
  } catch (err) {
    showError(err.message);
    return;
  }

  const programState = readProgramState();
  const currentIndex = Number.isInteger(programState.currentIndex) &&
    programState.currentIndex >= 0 && programState.currentIndex < rotation.length
    ? programState.currentIndex : 0;

  pickerEntries = buildPickerEntries(rotation);
  populatePicker(currentIndex);
  pickerEl.addEventListener('change', () => {
    activateEntry(Number(pickerEl.value));
  });

  bindStrengthListenersOnce();
  bindIntervalListenersOnce();
  bindNoteListenersOnce();
  bindHistoryListenersOnce();

  $('app').hidden = false;
  activateEntry(currentIndex);
}

boot();
