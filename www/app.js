"use strict";

const API = "cgi-bin/api.py";
const DAY_ABBR = ["Su", "M", "Tu", "W", "Th", "F", "Sa"];
const SAVE_DELAY_MS = 600;

const $ = (id) => document.getElementById(id);
const state = { days: [], metrics: [], weight: null, startDay: 4, anchor: new Date(), entries: {}, prevWeight: null };
const pending = new Map(); // "day|metric" -> timeout id

// --- local-date helpers (avoid UTC shifts from Date.toISOString) ---
function iso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function weekStart(d, startDay) {
  return addDays(d, -((d.getDay() - startDay + 7) % 7));
}
function weekDates() {
  const start = weekStart(state.anchor, state.startDay);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// Row label text for a metric's goal, e.g. "Goal of 35+ per week (5/day)".
function goalText(m) {
  const g = m.weekly_goal;
  if (!g) return m.note ? `No goal set, ${m.note}` : "No goal set";
  let text = `Goal of ${fmtNum(g)}+ per week`;
  if (m.per_day) text += ` (${fmtNum(Math.round((g / 7) * 10) / 10)}/day)`;
  return m.note ? `${text}, ${m.note}` : text;
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}

async function api(method, params) {
  const opts = { method, headers: {} };
  let url = API;
  if (method === "GET") {
    url += "?" + new URLSearchParams(params);
  } else {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(params);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function load() {
  const dates = weekDates();
  const data = await api("GET", { from: iso(dates[0]), to: iso(dates[6]) });
  state.metrics = data.metrics;
  state.weight = data.weight;
  state.days = data.days;
  state.entries = data.entries;
  state.prevWeight = data.prev_weight;
  return data;
}

function render() {
  const dates = weekDates();
  const todayIso = iso(new Date());
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  $("range").textContent = `${fmt.format(dates[0])} – ${fmt.format(dates[6])}`;
  $("week-date").value = iso(state.anchor);

  const head = $("head-row");
  head.replaceChildren(document.createElement("th"));
  for (const d of dates) {
    const th = document.createElement("th");
    th.innerHTML = `${DAY_ABBR[d.getDay()]}<small>${d.getMonth() + 1}/${d.getDate()}</small>`;
    if (iso(d) === todayIso) th.className = "today";
    head.append(th);
  }
  const totalTh = document.createElement("th");
  totalTh.innerHTML = "Weekly<br>Total";
  head.append(totalTh);

  const body = $("body-rows");
  body.replaceChildren();
  for (const m of state.metrics) {
    const tr = document.createElement("tr");
    tr.className = m.color;
    const label = document.createElement("th");
    label.scope = "row";
    label.innerHTML = `<span><small></small></span>`;
    label.querySelector("small").textContent = m.label;
    label.querySelector("span").append(`(${goalText(m)})`);
    tr.append(label);

    for (const d of dates) {
      const day = iso(d);
      const td = document.createElement("td");
      if (day === todayIso) td.className = "today";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.inputMode = "decimal";
      input.dataset.day = day;
      input.dataset.metric = m.key;
      input.setAttribute("aria-label", `${m.label}, ${day}`);
      const v = state.entries[day]?.[m.key];
      input.value = v === undefined ? "" : fmtNum(v);
      input.addEventListener("input", () => onEdit(input, false));
      input.addEventListener("change", () => onEdit(input, true));
      td.append(input);
      tr.append(td);
    }
    const total = document.createElement("td");
    total.className = "total";
    total.dataset.metric = m.key;
    tr.append(total);
    body.append(tr);
    updateTotal(m.key);
  }
  body.append(weightRow(dates, todayIso));
  updateWeightChange();
}

// The day this week's weight is stored on: normally the first day, but if the start day was
// changed after weighing in, an entry may sit on another day of the week (latest wins).
function weightDay(dates) {
  const key = state.weight.key;
  const days = dates.map(iso);
  if (state.entries[days[0]]?.[key] !== undefined) return days[0];
  return days.filter((d) => state.entries[d]?.[key] !== undefined).pop() ?? days[0];
}

function weightRow(dates, todayIso) {
  const w = state.weight;
  const tr = document.createElement("tr");
  tr.className = "weight";
  const label = document.createElement("th");
  label.scope = "row";
  label.innerHTML = `<span><small></small></span>`;
  label.querySelector("small").textContent = w.label;
  label.querySelector("span").append(`(${w.unit}, under first day)`);
  tr.append(label);

  const day = weightDay(dates);
  dates.forEach((d, i) => {
    const td = document.createElement("td");
    if (i > 0) {
      td.className = "na";
    } else {
      if (iso(d) === todayIso) td.className = "today";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.inputMode = "decimal";
      input.dataset.day = day;
      input.dataset.metric = w.key;
      input.setAttribute("aria-label", `${w.label} (${w.unit}), week of ${iso(d)}`);
      const v = state.entries[day]?.[w.key];
      input.value = v === undefined ? "" : fmtNum(v);
      input.addEventListener("input", () => onEdit(input, false));
      input.addEventListener("change", () => onEdit(input, true));
      td.append(input);
    }
    tr.append(td);
  });
  const change = document.createElement("td");
  change.className = "total weight-change";
  change.dataset.metric = w.key;
  tr.append(change);
  return tr;
}

// Weight row "total": change since the previous recorded weight.
function updateWeightChange() {
  const cell = document.querySelector("td.weight-change");
  const n = parseFloat(document.querySelector(`input[data-metric="${state.weight.key}"]`).value);
  if (Number.isNaN(n) || state.prevWeight === null) {
    cell.textContent = "";
    cell.title = state.prevWeight === null ? "No earlier weigh-in" : "";
    return;
  }
  const diff = Math.round((n - state.prevWeight) * 10) / 10;
  cell.textContent = (diff > 0 ? "+" : diff < 0 ? "\u2212" : "\u00b1") + fmtNum(Math.abs(diff));
  cell.title = `Change since previous weigh-in (${fmtNum(state.prevWeight)} ${state.weight.unit})`;
}

function updateTotal(metric) {
  let sum = 0;
  document.querySelectorAll(`input[data-metric="${metric}"]`).forEach((el) => {
    const n = parseFloat(el.value);
    if (!Number.isNaN(n)) sum += n;
  });
  document.querySelector(`td.total[data-metric="${metric}"]`).textContent = fmtNum(sum);
}

function onEdit(input, immediate) {
  const { day, metric } = input.dataset;
  if (metric === state.weight.key) updateWeightChange();
  else updateTotal(metric);
  const key = `${day}|${metric}`;
  clearTimeout(pending.get(key));
  if (!input.checkValidity()) {
    input.classList.add("error");
    setStatus("Please enter a non-negative number.", true);
    return;
  }
  input.classList.remove("error");
  input.classList.add("saving");
  pending.set(key, setTimeout(() => save(input), immediate ? 0 : SAVE_DELAY_MS));
}

async function save(input) {
  const { day, metric } = input.dataset;
  const key = `${day}|${metric}`;
  pending.delete(key);
  const raw = input.value.trim();
  const value = raw === "" ? null : parseFloat(raw);
  if (value === (state.entries[day]?.[metric] ?? null)) {
    input.classList.remove("saving");
    return;
  }
  try {
    await api("POST", { action: "set_entry", day, metric, value });
    if (value === null) {
      if (state.entries[day]) delete state.entries[day][metric];
    } else {
      (state.entries[day] ??= {})[metric] = value;
    }
    input.classList.remove("saving");
    setStatus(`Saved at ${new Date().toLocaleTimeString()}`);
    HFCharts.refreshSoon();
  } catch (e) {
    input.classList.remove("saving");
    input.classList.add("error");
    setStatus(`Save failed: ${e.message}`, true);
  }
}

async function flushPending() {
  for (const [key, t] of pending) {
    clearTimeout(t);
    const [day, metric] = key.split("|");
    const input = document.querySelector(`input[data-day="${day}"][data-metric="${metric}"]`);
    if (input) await save(input);
  }
}

async function goTo(date) {
  await flushPending();
  state.anchor = date;
  const url = new URL(location.href);
  url.searchParams.set("date", iso(date));
  history.replaceState(null, "", url);
  try {
    await load();
    render();
    HFCharts.drawAll();
  } catch (e) {
    setStatus(`Could not load data: ${e.message}`, true);
  }
}

// "Weekly goals" panel: one input per daily metric, saved on change.
function buildGoalFields() {
  const holder = $("goal-fields");
  holder.replaceChildren();
  for (const m of state.metrics) {
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = m.label;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "any";
    input.inputMode = "decimal";
    input.value = fmtNum(m.weekly_goal);
    input.dataset.metric = m.key;
    const unit = document.createElement("small");
    unit.textContent = "per week";
    label.append(name, input, unit);
    holder.append(label);
    input.addEventListener("change", () => saveGoal(input));
  }
}

async function saveGoal(input) {
  const m = state.metrics.find((x) => x.key === input.dataset.metric);
  const raw = input.value.trim();
  if (raw === "" || !input.checkValidity()) {
    input.value = fmtNum(m.weekly_goal);
    setStatus("A goal must be a number of 0 or more (0 = no goal).", true);
    return;
  }
  try {
    const res = await api("POST", { action: "set_settings", goals: { [m.key]: parseFloat(raw) } });
    state.metrics = res.metrics;
    await flushPending();
    render();
    HFCharts.drawAll();
    setStatus(`${m.label} goal saved.`);
  } catch (e) {
    input.value = fmtNum(m.weekly_goal);
    setStatus(`Could not save goal: ${e.message}`, true);
  }
}

async function init() {
  const qd = new URLSearchParams(location.search).get("date");
  if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) state.anchor = parseIso(qd);

  try {
    const data = await load();
    state.startDay = Math.max(0, data.days.indexOf(data.settings.start_day));
    if (state.startDay !== 4) await load(); // week range depends on start day
  } catch (e) {
    setStatus(`Could not load data: ${e.message}`, true);
    return;
  }

  const sel = $("start-day");
  state.days.forEach((name, i) => {
    sel.add(new Option(name[0].toUpperCase() + name.slice(1), i));
  });
  sel.value = state.startDay;
  sel.addEventListener("change", async () => {
    state.startDay = Number(sel.value);
    try {
      await api("POST", { action: "set_settings", start_day: state.days[state.startDay] });
      setStatus("Start day saved.");
    } catch (e) {
      setStatus(`Could not save start day: ${e.message}`, true);
    }
    await goTo(state.anchor);
    HFCharts.refresh();
  });

  $("week-date").addEventListener("change", (e) => {
    if (e.target.value) goTo(parseIso(e.target.value));
  });
  $("prev").addEventListener("click", () => goTo(addDays(state.anchor, -7)));
  $("next").addEventListener("click", () => goTo(addDays(state.anchor, 7)));
  $("today").addEventListener("click", () => goTo(new Date()));
  window.addEventListener("beforeunload", () => { flushPending(); });

  buildGoalFields();
  render();
  HFCharts.init();
}

init();
