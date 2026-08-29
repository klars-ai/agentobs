/**
 * Dashboard client.
 *
 * Plain ES modules, no build step and no framework - the page is a handful of
 * tables and one chart, and keeping it dependency-free means the dashboard
 * ships inside the npm package with nothing to compile.
 */

const state = {
  range: '7d',
  status: '',
  timeline: [],
  sparklines: null,
};

const RANGE_LABEL = {
  today: 'today',
  '7d': 'this week',
  '30d': 'this month',
  all: 'all time',
};

/* ---------- formatting ---------- */

/**
 * Money formatter.
 *
 * `null` renders as an em dash, never as $0.00: a missing price for a model
 * is not the same fact as a call that cost nothing, and conflating them is
 * exactly the fabrication this product promises not to do.
 */
function money(value) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function count(value) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat().format(value);
}

function ms(value) {
  if (value === null || value === undefined) return '—';
  if (value < 1000) return `${Math.round(value)}`;
  return `${(value / 1000).toFixed(1)}s`;
}

function percent(value) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso ?? '—';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return new Date(then).toLocaleDateString();
}

/** Always build DOM via textContent - tool inputs are untrusted strings. */
function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function statusPill(status) {
  const span = document.createElement('span');
  const known = ['success', 'error', 'blocked', 'pending'].includes(status);
  span.className = `pill pill-${known ? status : 'pending'}`;
  span.textContent = status;
  return span;
}

/* ---------- data ---------- */

async function fetchJson(path) {
  const url = new URL(path, window.location.origin);
  url.searchParams.set('range', state.range);
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) url.searchParams.set('token', token);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function setConnection(ok, message) {
  const el = document.getElementById('conn-state');
  el.className = `conn ${ok ? 'is-live' : 'is-down'}`;
  el.textContent = message;
}

async function refresh() {
  try {
    const [summary, timeline, tools, calls, sessions] = await Promise.all([
      fetchJson('/api/summary'),
      fetchJson('/api/timeline'),
      fetchJson('/api/tools-breakdown'),
      fetchJson(`/api/tool-calls${state.status ? `?status=${state.status}` : ''}`),
      fetchJson('/api/sessions'),
    ]);

    renderSummary(summary);
    state.timeline = timeline;
    drawTimeline();
    renderTimelineTable(timeline);
    renderTools(tools);
    renderActivity(calls.calls ?? []);
    renderSessions(sessions.sessions ?? []);
    setConnection(true, `Live · updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    setConnection(false, `Disconnected: ${err.message}`);
  }
}

/* ---------- render ---------- */

function renderSummary(s) {
  document.getElementById('hero-cost').textContent = money(s.total_cost_usd);
  document.getElementById('hero-tokens-in').textContent = count(s.tokens_in);
  document.getElementById('hero-tokens-out').textContent = count(s.tokens_out);
  document.getElementById('hero-duration').textContent = ms(s.avg_duration_ms);

  // Say plainly when the cost figure is incomplete, rather than presenting a
  // partial total as if it were the whole spend.
  const note = document.getElementById('hero-note');
  if (s.tool_calls === 0) {
    note.textContent = 'No activity recorded yet.';
  } else if (s.uncosted_calls > 0) {
    note.textContent = `${count(s.uncosted_calls)} call${s.uncosted_calls === 1 ? '' : 's'} have no price for their model — add it to ~/.agentobs/pricing.json to include them.`;
  } else {
    note.textContent = `Across ${count(s.tool_calls)} tool calls in ${count(s.sessions)} session${s.sessions === 1 ? '' : 's'}.`;
  }

  document.getElementById('stat-calls').textContent = count(s.tool_calls);
  document.getElementById('stat-calls-sub').textContent = `${count(s.tokens_in + s.tokens_out)} tokens`;
  document.getElementById('stat-sessions').textContent = count(s.sessions);
  document.getElementById('stat-sessions-sub').textContent = RANGE_LABEL[s.range] ?? '';
  document.getElementById('stat-errors').textContent = percent(s.error_rate);
  document.getElementById('stat-errors-sub').textContent = `${count(s.errors)} failed`;
  document.getElementById('stat-blocked').textContent = count(s.blocked);

  const prev = s.previous;
  renderDelta(document.getElementById('delta-calls'), s.tool_calls, prev?.tool_calls);
  renderDelta(document.getElementById('delta-sessions'), s.sessions, prev?.sessions);
  // Up is bad for an error rate - see renderDelta's goodWhenUp.
  renderDelta(document.getElementById('delta-errors'), s.error_rate, prev?.error_rate, {
    goodWhenUp: false,
  });

  state.sparklines = s.sparklines ?? null;
  drawAllSparks();

  for (const el of document.querySelectorAll('[data-range-label]')) {
    el.textContent = RANGE_LABEL[state.range] ?? '';
  }
}

function renderTimelineTable(rows) {
  const body = document.getElementById('timeline-table-body');
  body.replaceChildren();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.append(
      cell(row.bucket),
      cell(count(row.calls), 'num'),
      cell(count(row.errors), 'num'),
      cell(money(row.cost_usd), 'num'),
    );
    body.append(tr);
  }
}

function renderTools(rows) {
  const body = document.getElementById('tools-body');
  body.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.append(Object.assign(cell('No tool calls recorded yet.', 'empty'), { colSpan: 5 }));
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    const name = cell('');
    name.append(document.createTextNode(row.tool_name));
    if (row.blocked > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${row.blocked} blocked`;
      name.append(badge);
    }
    tr.append(
      name,
      cell(count(row.calls), 'num'),
      cell(count(row.errors), 'num'),
      cell(ms(row.avg_duration_ms), 'num'),
      cell(money(row.cost_usd), 'num'),
    );
    body.append(tr);
  }
}

function renderSessions(rows) {
  const body = document.getElementById('sessions-body');
  body.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.append(Object.assign(cell('No sessions yet.', 'empty'), { colSpan: 4 }));
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    const agent = cell('');
    agent.append(document.createTextNode(row.agent_name));
    // Coarse sessions know only duration and exit code. Labelling them keeps
    // the UI from implying per-tool-call detail it does not have.
    if (row.fidelity === 'coarse') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'coarse';
      badge.title = 'Process-wrapped: duration and exit code only, no per-tool-call detail.';
      agent.append(badge);
    }
    tr.append(
      agent,
      cell(relativeTime(row.started_at)),
      cell(row.fidelity === 'coarse' ? '—' : count(row.tool_call_count), 'num'),
      cell(money(row.total_cost_usd), 'num'),
    );
    body.append(tr);
  }
}

function renderActivity(rows) {
  const body = document.getElementById('activity-body');
  body.replaceChildren();
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.append(
      Object.assign(cell('Nothing yet. Run an agent to see activity here.', 'empty'), {
        colSpan: 6,
      }),
    );
    body.append(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');

    const status = document.createElement('td');
    status.append(statusPill(row.status));
    if (row.rule_matched) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = row.rule_matched;
      badge.title = 'Policy rule that produced this decision';
      status.append(badge);
    }

    const input = document.createElement('td');
    const code = document.createElement('code');
    code.className = 'mono truncate';
    code.textContent = row.input_summary || '—';
    code.title = row.error_message || row.output_summary || row.input_summary || '';
    input.append(code);

    tr.append(
      status,
      cell(row.tool_name),
      input,
      cell(relativeTime(row.started_at)),
      cell(ms(row.duration_ms), 'num'),
      cell(money(row.cost_usd), 'num'),
    );
    body.append(tr);
  }
}

/* ---------- chart ---------- */

const canvas = document.getElementById('timeline');
const tip = document.getElementById('timeline-tip');
let bars = [];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Grouped bar chart on a plain canvas.
 *
 * One y-scale only - calls and errors are both counts, so they share it. A
 * second axis for cost would be a dual-axis chart, which misleads by making
 * two unrelated scales look comparable.
 */
function drawTimeline() {
  const rows = state.timeline;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = 220;

  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = { top: 12, right: 8, bottom: 26, left: 40 };
  const plotW = cssWidth - pad.left - pad.right;
  const plotH = cssHeight - pad.top - pad.bottom;
  bars = [];

  const muted = cssVar('--text-muted');
  const gridColor = cssVar('--grid');
  const axisColor = cssVar('--axis');

  if (rows.length === 0) {
    ctx.fillStyle = muted;
    ctx.font = '13px ' + cssVar('--font');
    ctx.textAlign = 'center';
    ctx.fillText('No activity in this range', cssWidth / 2, cssHeight / 2);
    return;
  }

  const maxCalls = Math.max(1, ...rows.map((r) => r.calls));
  const ticks = niceTicks(maxCalls, 4);
  const top = ticks[ticks.length - 1];
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  // Recessive gridlines, drawn under the data.
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.fillStyle = muted;
  ctx.font = '11px ' + cssVar('--font');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of ticks) {
    const yy = Math.round(y(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(pad.left + plotW, yy);
    ctx.stroke();
    ctx.fillText(String(t), pad.left - 8, yy);
  }

  const slot = plotW / rows.length;
  // Cap the width so a 7-bucket week doesn't render as slabs, but keep bars
  // substantial enough to read as data rather than hairlines.
  const barW = Math.max(4, Math.min(46, slot * 0.62));
  const errW = Math.max(3, barW * 0.4);
  const radius = 4;

  rows.forEach((row, i) => {
    const cx = pad.left + slot * i + slot / 2;
    const x = cx - barW / 2;
    const h = Math.max(row.calls > 0 ? 2 : 0, plotH - (y(row.calls) - pad.top));

    if (h > 0) {
      // Vertical gradient rather than a flat fill: it gives the bar body
      // depth while keeping full saturation at the data end, where the
      // value is actually read.
      const grad = ctx.createLinearGradient(0, y(row.calls), 0, pad.top + plotH);
      grad.addColorStop(0, cssVar('--series-1'));
      grad.addColorStop(1, hexToRgba(cssVar('--series-1'), 0.55));
      ctx.fillStyle = grad;
      roundedTop(ctx, x, y(row.calls), barW, h, radius);
      ctx.fill();
    }

    // Errors ride in front, inset, in the reserved critical status color -
    // never a categorical slot, so a status never impersonates a series.
    if (row.errors > 0) {
      const eh = Math.max(2, plotH - (y(row.errors) - pad.top));
      ctx.fillStyle = cssVar('--surface');
      roundedTop(ctx, cx - errW / 2 - 1, y(row.errors) - 1, errW + 2, eh + 1, radius);
      ctx.fill();
      ctx.fillStyle = cssVar('--status-critical');
      roundedTop(ctx, cx - errW / 2, y(row.errors), errW, eh, radius);
      ctx.fill();
    }

    bars.push({ x: pad.left + slot * i, w: slot, row });
  });

  // Baseline.
  ctx.strokeStyle = axisColor;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + plotH + 0.5);
  ctx.lineTo(pad.left + plotW, pad.top + plotH + 0.5);
  ctx.stroke();

  // Thin out x labels so they never collide.
  ctx.fillStyle = muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(rows.length / Math.floor(plotW / 70)));
  rows.forEach((row, i) => {
    if (i % step !== 0 && i !== rows.length - 1) return;
    ctx.fillText(shortLabel(row.bucket), pad.left + slot * i + slot / 2, pad.top + plotH + 8);
  });
}

function roundedTop(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function niceTicks(max, target) {
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const stepMult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = stepMult * mag;
  const out = [];
  for (let v = 0; v <= max + step; v += step) out.push(Math.round(v));
  return out;
}

function shortLabel(bucket) {
  if (bucket.includes('T')) return bucket.split('T')[1];
  const parts = bucket.split('-');
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : bucket;
}

canvas.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const hit = bars.find((b) => x >= b.x && x < b.x + b.w);
  if (!hit) {
    tip.classList.remove('is-visible');
    return;
  }
  tip.textContent = `${hit.row.bucket} · ${hit.row.calls} calls · ${hit.row.errors} errors · ${money(hit.row.cost_usd)}`;
  tip.classList.add('is-visible');
  const wrapRect = canvas.parentElement.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, event.clientX - wrapRect.left + 12),
    wrapRect.width - tip.offsetWidth - 8,
  );
  tip.style.left = `${left}px`;
  tip.style.top = `${event.clientY - wrapRect.top - 40}px`;
});

canvas.addEventListener('mouseleave', () => tip.classList.remove('is-visible'));

/* ---------- controls ---------- */

function bindGroup(selector, attr, onPick) {
  for (const btn of document.querySelectorAll(selector)) {
    btn.addEventListener('click', () => {
      for (const sibling of btn.parentElement.children) {
        sibling.setAttribute('aria-pressed', String(sibling === btn));
      }
      onPick(btn.dataset[attr] ?? '');
    });
  }
}

bindGroup('.rangeset button', 'range', (value) => {
  state.range = value;
  refresh();
});

bindGroup('.filterset button', 'status', (value) => {
  state.status = value;
  refresh();
});

for (const btn of document.querySelectorAll('[data-toggle-table]')) {
  btn.addEventListener('click', () => {
    const wrap = document.querySelector(`[data-table="${btn.dataset.toggleTable}"]`);
    const hidden = wrap.classList.toggle('is-hidden');
    btn.textContent = hidden ? 'Show data table' : 'Hide data table';
  });
}

const themeToggle = document.getElementById('theme-toggle');
themeToggle.addEventListener('click', () => {
  const current =
    document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('agentobs-theme', next);
  } catch {
    // Private windows and blocked site data throw here; the page must still
    // render, it just won't remember the choice.
  }
  drawTimeline();
  drawAllSparks();
});

try {
  const saved = localStorage.getItem('agentobs-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch {
  /* ignore */
}

window.addEventListener('resize', () => {
  drawTimeline();
  drawAllSparks();
});

refresh();
setInterval(refresh, 5000);

/* ---------- sparklines & deltas ---------- */

/**
 * Draws a filled sparkline into a canvas.
 *
 * Deliberately axis-less and label-less: a sparkline's job is shape, not
 * value. The number it accompanies is the value, so adding ticks here would
 * duplicate it and crowd the tile.
 */
function drawSpark(canvas, values, color, { fill = true, dot = true } = {}) {
  if (!canvas || !values || values.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200;
  const h = canvas.clientHeight || 30;
  canvas.width = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(...values, 1);
  const pad = 3;
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const pts = values.map((v, i) => [pad + i * stepX, y(v)]);

  if (fill) {
    // Fade the fill to transparent so the tile's own tint shows through
    // rather than the sparkline reading as a solid block.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexToRgba(color, 0.28));
    grad.addColorStop(1, hexToRgba(color, 0));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(pts[pts.length - 1][0], h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.beginPath();
  pts.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();

  if (dot) {
    // 2px surface ring on the end marker, per the mark spec, so the dot
    // stays legible where it overlaps the line or fill.
    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--surface');
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

/** #rrggbb -> rgba(). Canvas gradients need a concrete alpha value. */
function hexToRgba(hex, alpha) {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Renders a delta chip.
 *
 * `goodWhenUp` matters: more tool calls is neutral-to-good, but a higher
 * error rate is bad. Coloring purely by sign would congratulate the user on
 * a rising error rate.
 */
function renderDelta(el, current, previous, { goodWhenUp = true } = {}) {
  if (!el) return;
  if (previous === null || previous === undefined || previous === 0) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const change = ((current - previous) / previous) * 100;
  if (!Number.isFinite(change) || Math.abs(change) < 0.5) {
    // Below half a percent is noise; a chip there implies a signal that
    // isn't real.
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const up = change > 0;
  const magnitude = Math.abs(change);
  const tone = up === goodWhenUp ? 'delta-good' : 'delta-bad';
  el.className = `delta ${tone}`;
  el.textContent = `${up ? '▲' : '▼'} ${magnitude < 10 ? magnitude.toFixed(1) : Math.round(magnitude)}%`;
  el.title = 'vs the previous period of the same length';
  el.removeAttribute('hidden');
}

/** Repaints every sparkline. Called on refresh, resize and theme change. */
function drawAllSparks() {
  const s = state.sparklines;
  if (!s) return;
  drawSpark(document.getElementById('hero-spark'), s.cost, cssVar('--series-1'));
  drawSpark(document.getElementById('spark-calls'), s.calls, cssVar('--series-1'));
  drawSpark(document.getElementById('spark-sessions'), s.sessions, cssVar('--series-3'));
  drawSpark(document.getElementById('spark-errors'), s.errors, cssVar('--status-critical'));
  const blockedCanvas = document.getElementById('spark-blocked');
  if (s.blocked && s.blocked.some((v) => v > 0)) {
    drawSpark(blockedCanvas, s.blocked, cssVar('--status-serious'));
  } else if (blockedCanvas) {
    // Nothing blocked in this range: clear rather than draw a flat line,
    // which would read as a real series sitting at zero.
    const ctx = blockedCanvas.getContext('2d');
    ctx.clearRect(0, 0, blockedCanvas.width, blockedCanvas.height);
  }
}
