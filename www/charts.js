"use strict";

// Weight-over-time and weekly-summary charts, drawn as plain SVG.
// Uses globals from app.js (state, api, goTo, iso, addDays, weekStart, fmtNum, setStatus).
const HFCharts = (() => {
  const SPANS = [["1m", "1 month", 1], ["3m", "3 months", 3], ["6m", "6 months", 6], ["12m", "1 year", 12]];
  const SERIES_VARS = ["--series-1", "--series-2", "--series-3"];
  const NS = "http://www.w3.org/2000/svg";
  const M = { l: 44, r: 14, t: 14, b: 26 };
  const DAY_MS = 864e5;
  const fmtShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fmtLong = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

  let span = "3m";
  let range = null;     // {start, end} Date, whole weeks
  let weeks = [];       // [{start, totals: {metric: number|null}, current}]
  let weights = [];     // [{date, value}] sorted
  let refreshTimer = null;
  let loadSeq = 0;

  try { span = localStorage.getItem("hf-chart-span") || span; } catch (e) { /* storage unavailable */ }
  if (!SPANS.some(([k]) => k === span)) span = "3m";

  // --- small helpers ---
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (parent) parent.append(e);
    return e;
  }
  function cssVar(name) {
    return getComputedStyle(document.getElementById("charts")).getPropertyValue(name).trim();
  }
  function niceStep(rough) {
    const p = 10 ** Math.floor(Math.log10(rough));
    const f = rough / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function niceScale(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const step = niceStep((max - min) / count);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return { min: lo, max: hi, ticks };
  }
  function sameWeek(date, wkStart) {
    return date >= wkStart && date < addDays(wkStart, 7);
  }

  // --- data ---
  function computeRange() {
    const today = new Date();
    const months = SPANS.find(([k]) => k === span)[2];
    const from = new Date(today.getFullYear(), today.getMonth() - months, today.getDate() + 1);
    const start = weekStart(from, state.startDay);
    const end = addDays(weekStart(today, state.startDay), 6);
    return { start, end };
  }

  function buildModel(entries) {
    const today = new Date();
    weeks = [];
    for (let d = range.start; d <= range.end; d = addDays(d, 7)) {
      const totals = {};
      for (const m of state.metrics) totals[m.key] = null;
      for (let i = 0; i < 7; i++) {
        const day = entries[iso(addDays(d, i))] || {};
        for (const m of state.metrics) {
          if (day[m.key] !== undefined) totals[m.key] = (totals[m.key] ?? 0) + day[m.key];
        }
      }
      weeks.push({ start: d, totals, current: sameWeek(today, d) });
    }
    weights = Object.keys(entries)
      .filter((day) => entries[day][state.weight.key] !== undefined)
      .sort()
      .map((day) => ({ date: parseIso(day), value: entries[day][state.weight.key] }));
  }

  async function refresh() {
    clearTimeout(refreshTimer);
    const seq = ++loadSeq;
    range = computeRange();
    const root = document.getElementById("charts");
    root.classList.add("loading");
    try {
      const data = await api("GET", { from: iso(range.start), to: iso(range.end) });
      if (seq !== loadSeq) return;
      buildModel(data.entries);
      drawAll();
    } catch (e) {
      setStatus(`Could not load chart data: ${e.message}`, true);
    } finally {
      if (seq === loadSeq) root.classList.remove("loading");
    }
  }

  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 800);
  }

  // --- shared drawing pieces ---
  function frame(container, height) {
    const width = Math.max(280, container.clientWidth);
    container.replaceChildren();
    const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, tabindex: 0 }, container);
    const x0 = range.start.getTime();
    const x1 = addDays(range.end, 1).getTime();
    const pw = width - M.l - M.r;
    const x = (date) => M.l + ((date.getTime() - x0) / (x1 - x0)) * pw;
    return { svg, width, height, x, bandW: (7 * DAY_MS / (x1 - x0)) * pw };
  }

  function yAxis(f, scale, y) {
    const g = svgEl("g", { class: "axis" }, f.svg);
    for (const t of scale.ticks) {
      svgEl("line", { class: "grid", x1: M.l, x2: f.width - M.r, y1: y(t), y2: y(t) }, g);
      svgEl("text", { x: M.l - 6, y: y(t), dy: "0.32em", "text-anchor": "end" }, g).textContent = fmtNum(t);
    }
  }

  function xAxis(f, bottom) {
    const g = svgEl("g", { class: "axis" }, f.svg);
    svgEl("line", { class: "baseline", x1: M.l, x2: f.width - M.r, y1: bottom, y2: bottom }, g);
    const every = Math.max(1, Math.ceil(weeks.length / Math.max(1, Math.floor((f.width - M.l - M.r) / 60))));
    weeks.forEach((w, i) => {
      if ((weeks.length - 1 - i) % every) return; // anchor labels on the most recent week
      svgEl("text", { x: f.x(w.start) + f.bandW / 2, y: bottom + 16, "text-anchor": "middle" }, g)
        .textContent = fmtShort.format(w.start);
    });
  }

  function selectedBand(f, top, bottom) {
    const w = weeks.find((wk) => sameWeek(state.anchor, wk.start));
    if (!w) return;
    svgEl("rect", { class: "selected-week", x: f.x(w.start), y: top, width: f.bandW, height: bottom - top }, f.svg);
  }

  function showTip(tip, card, px, py, rows, heading) {
    tip.replaceChildren();
    const h = document.createElement("div");
    h.className = "tip-head";
    h.textContent = heading;
    tip.append(h);
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "tip-row";
      if (r.color) {
        const key = document.createElement("span");
        key.className = "tip-key";
        key.style.background = r.color;
        row.append(key);
      }
      const v = document.createElement("strong");
      v.textContent = r.value;
      row.append(v);
      if (r.label) {
        const l = document.createElement("span");
        l.className = "tip-label";
        l.textContent = r.label;
        row.append(l);
      }
      tip.append(row);
    }
    tip.hidden = false;
    const cw = card.clientWidth;
    const tw = tip.offsetWidth;
    let left = px + 14;
    if (left + tw > cw - 4) left = px - tw - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, py - tip.offsetHeight - 10)}px`;
  }

  function dataTable(card, headers, rows) {
    const holder = card.querySelector(".tbl");
    const table = document.createElement("table");
    const tr = table.createTHead().insertRow();
    for (const h of headers) {
      const th = document.createElement("th");
      th.textContent = h;
      tr.append(th);
    }
    const tb = table.createTBody();
    for (const r of rows) {
      const row = tb.insertRow();
      for (const c of r) row.insertCell().textContent = c;
    }
    holder.replaceChildren(table);
  }

  // Keyboard: arrows move the readout, Enter jumps the tracker to that week.
  function keyNav(svg, count, getIdx, setIdx, activate) {
    svg.addEventListener("focus", () => setIdx(getIdx() ?? count - 1));
    svg.addEventListener("blur", () => setIdx(null));
    svg.addEventListener("keydown", (e) => {
      const i = getIdx() ?? count - 1;
      if (e.key === "ArrowLeft") setIdx(Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setIdx(Math.min(count - 1, i + 1));
      else if (e.key === "Enter") activate(i);
      else return;
      e.preventDefault();
    });
  }

  // --- weight chart ---
  function drawWeight() {
    const card = document.getElementById("weight-card");
    const container = card.querySelector(".chart");
    const tip = card.querySelector(".tooltip");
    const unit = state.weight.unit;
    card.querySelector(".unit").textContent = `(${unit})`;
    tip.hidden = true;
    const f = frame(container, 220);
    const bottom = f.height - M.b;
    f.svg.setAttribute("aria-label", `Weight over time, ${weights.length} weigh-ins`);

    dataTable(card, ["Date", `Weight (${unit})`],
      weights.map((p) => [fmtLong.format(p.date), fmtNum(p.value)]));

    if (!weights.length) {
      xAxis(f, bottom);
      svgEl("text", { class: "empty", x: f.width / 2, y: bottom / 2, "text-anchor": "middle" }, f.svg)
        .textContent = "No weigh-ins in this period";
      return;
    }
    const vals = weights.map((p) => p.value);
    const scale = niceScale(Math.min(...vals) - 1, Math.max(...vals) + 1, 4);
    const y = (v) => M.t + (1 - (v - scale.min) / (scale.max - scale.min)) * (bottom - M.t);
    const px = (p) => f.x(p.date) + f.bandW / 14; // centre of that day

    selectedBand(f, M.t, bottom);
    yAxis(f, scale, y);
    xAxis(f, bottom);

    const color = cssVar("--series-weight");
    const pts = weights.map((p) => [px(p), y(p.value)]);
    svgEl("path", { class: "line", stroke: color, d: "M" + pts.map((p) => p.join(",")).join("L") }, f.svg);
    for (const [cx, cy] of pts) svgEl("circle", { class: "dot", cx, cy, r: 4, fill: color }, f.svg);

    // Direct label on the latest value only.
    const [lx, ly] = pts[pts.length - 1];
    // Put it on the side away from the incoming segment so the line doesn't cross it.
    const below = pts.length > 1 && pts[pts.length - 2][1] < ly;
    const last = svgEl("text", { class: "end-label", x: lx - 8, y: below ? ly + 18 : ly - 10, "text-anchor": "end" }, f.svg);
    last.textContent = `${fmtNum(weights[weights.length - 1].value)} ${unit}`;
    if (lx - 8 - last.getComputedTextLength() < M.l) {
      last.setAttribute("x", lx + 8);
      last.setAttribute("text-anchor", "start");
    }

    const cross = svgEl("line", { class: "crosshair", y1: M.t, y2: bottom, visibility: "hidden" }, f.svg);
    const hot = svgEl("circle", { class: "dot hot", r: 6, fill: color, visibility: "hidden" }, f.svg);
    let idx = null;
    const setIdx = (i) => {
      idx = i;
      if (i === null) {
        cross.setAttribute("visibility", "hidden");
        hot.setAttribute("visibility", "hidden");
        tip.hidden = true;
        return;
      }
      const [cx, cy] = pts[i];
      cross.setAttribute("x1", cx);
      cross.setAttribute("x2", cx);
      cross.setAttribute("visibility", "visible");
      hot.setAttribute("cx", cx);
      hot.setAttribute("cy", cy);
      hot.setAttribute("visibility", "visible");
      const prev = i > 0 ? weights[i].value - weights[i - 1].value : null;
      const rows = [{ value: `${fmtNum(weights[i].value)} ${unit}`, color }];
      if (prev !== null) {
        const d = Math.round(prev * 10) / 10;
        rows.push({ value: (d > 0 ? "+" : d < 0 ? "−" : "±") + fmtNum(Math.abs(d)), label: "vs previous" });
      }
      showTip(tip, card, cx, cy + container.offsetTop, rows, fmtLong.format(weights[i].date));
    };
    const overlay = svgEl("rect", { class: "overlay", x: M.l, y: 0, width: f.width - M.l - M.r, height: bottom }, f.svg);
    overlay.addEventListener("pointermove", (e) => {
      const mx = e.clientX - f.svg.getBoundingClientRect().left;
      let best = 0;
      pts.forEach(([cx], i) => { if (Math.abs(cx - mx) < Math.abs(pts[best][0] - mx)) best = i; });
      setIdx(best);
    });
    overlay.addEventListener("pointerleave", () => setIdx(null));
    overlay.addEventListener("click", () => { if (idx !== null) goTo(weights[idx].date); });
    keyNav(f.svg, pts.length, () => idx, setIdx, (i) => goTo(weights[i].date));
  }

  // --- weekly summary small multiples (one y-scale per metric, shared time axis) ---
  function drawSummary() {
    const card = document.getElementById("summary-card");
    const holder = card.querySelector(".chart");
    const tip = card.querySelector(".tooltip");
    tip.hidden = true;
    holder.replaceChildren();
    const colors = state.metrics.map((_, i) => cssVar(SERIES_VARS[i % SERIES_VARS.length]));
    const highlights = [];
    let idx = null;

    const setIdx = (i) => {
      idx = i;
      for (const h of highlights) {
        if (i === null) { h.rect.setAttribute("visibility", "hidden"); continue; }
        h.rect.setAttribute("x", h.f.x(weeks[i].start));
        h.rect.setAttribute("visibility", "visible");
      }
      if (i === null) { tip.hidden = true; return; }
      const w = weeks[i];
      const rows = state.metrics.map((m, k) => ({
        value: w.totals[m.key] === null ? "—" : fmtNum(w.totals[m.key]),
        label: m.label, color: colors[k],
      }));
      const f0 = highlights[0].f;
      const heading = `Week of ${fmtLong.format(w.start)}${w.current ? " (in progress)" : ""}`;
      showTip(tip, card, f0.x(w.start) + f0.bandW / 2, holder.offsetTop + 20, rows, heading);
    };

    state.metrics.forEach((m, k) => {
      const last = k === state.metrics.length - 1;
      const panel = document.createElement("div");
      panel.className = "panel";
      const title = document.createElement("div");
      title.className = "panel-title";
      const key = document.createElement("span");
      key.className = "line-key";
      key.style.background = colors[k];
      const name = document.createElement("span");
      name.textContent = m.label;
      title.append(key, name);
      if (m.weekly_goal) {
        const g = document.createElement("small");
        g.textContent = `goal ${fmtNum(m.weekly_goal)}/week`;
        title.append(g);
      }
      panel.append(title);
      const plot = document.createElement("div");
      panel.append(plot);
      holder.append(panel);

      const f = frame(plot, last ? 130 : 108);
      const bottom = f.height - (last ? M.b : 6);
      f.svg.setAttribute("aria-label", `${m.label}, weekly totals`);
      const vals = weeks.map((w) => w.totals[m.key] ?? 0);
      const scale = niceScale(0, Math.max(1, m.weekly_goal || 0, ...vals), 3);
      const y = (v) => M.t + (1 - v / scale.max) * (bottom - M.t);

      selectedBand(f, M.t, bottom);
      const hl = svgEl("rect", { class: "hover-week", y: M.t, width: f.bandW, height: bottom - M.t, visibility: "hidden" }, f.svg);
      highlights.push({ rect: hl, f });
      yAxis(f, scale, y);
      if (last) xAxis(f, bottom);
      else svgEl("line", { class: "baseline", x1: M.l, x2: f.width - M.r, y1: bottom, y2: bottom }, f.svg);

      const bw = Math.max(1, Math.min(24, f.bandW - 2));
      weeks.forEach((w) => {
        const v = w.totals[m.key];
        if (!v) return;
        const x = f.x(w.start) + (f.bandW - bw) / 2;
        const top = y(v);
        const r = Math.min(4, bw / 2, bottom - top);
        svgEl("path", {
          class: "bar" + (w.current ? " current" : ""), fill: colors[k],
          d: `M${x},${bottom}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${bottom}Z`,
        }, f.svg);
      });

      if (m.weekly_goal) {
        const gy = y(m.weekly_goal);
        svgEl("line", { class: "goal", x1: M.l, x2: f.width - M.r, y1: gy, y2: gy }, f.svg);
        svgEl("text", { class: "goal-label", x: f.width - M.r, y: gy - 4, "text-anchor": "end" }, f.svg)
          .textContent = `goal ${fmtNum(m.weekly_goal)}`;
      }

      const overlay = svgEl("rect", { class: "overlay", x: M.l, y: 0, width: f.width - M.l - M.r, height: bottom }, f.svg);
      overlay.addEventListener("pointermove", (e) => {
        const mx = e.clientX - f.svg.getBoundingClientRect().left;
        setIdx(Math.min(weeks.length - 1, Math.max(0, Math.floor((mx - M.l) / f.bandW))));
      });
      overlay.addEventListener("pointerleave", () => setIdx(null));
      overlay.addEventListener("click", () => { if (idx !== null) goTo(weeks[idx].start); });
      keyNav(f.svg, weeks.length, () => idx, setIdx, (i) => goTo(weeks[i].start));
    });

    dataTable(card, ["Week of", ...state.metrics.map((m) => m.label)],
      weeks.slice().reverse().map((w) => [
        fmtLong.format(w.start) + (w.current ? " (in progress)" : ""),
        ...state.metrics.map((m) => (w.totals[m.key] === null ? "—" : fmtNum(w.totals[m.key]))),
      ]));
  }

  function drawAll() {
    if (!range) return;
    // The viewed week may now sit in a different place (or the start day changed): redraw.
    drawWeight();
    drawSummary();
  }

  function init() {
    const picker = document.getElementById("span-picker");
    for (const [key, label] of SPANS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-pressed", key === span);
      b.addEventListener("click", () => {
        span = key;
        try { localStorage.setItem("hf-chart-span", span); } catch (e) { /* storage unavailable */ }
        picker.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
        refresh();
      });
      picker.append(b);
    }
    let lastWidth = 0;
    new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w !== lastWidth) { lastWidth = w; drawAll(); }
    }).observe(document.getElementById("charts"));
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);
    refresh();
  }

  return { init, refresh, refreshSoon, drawAll };
})();
