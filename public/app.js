// Jarvis dashboard. All text is inserted with textContent (never innerHTML),
// because model output is untrusted.
const $ = (s) => document.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const state = { view: "room", status: null, jobs: [], selectedId: null, job: null, busy: false, error: "", open: new Set(), draft: "" };
let timer = null;

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") {
    showLogin();
    throw new Error("Please sign in.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (n) => "$" + Number(n || 0).toFixed(4);
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const ACTIVE = new Set(["planning", "running"]);

const STATUS = {
  planning: ["Planning", "live"],
  awaiting_plan: ["Needs your approval", "warn"],
  running: ["Running", "live"],
  awaiting_step: ["Needs your approval", "warn"],
  done: ["Done", "ok"],
  rejected: ["Plan rejected", ""],
  failed: ["Failed", "bad"],
  cap_reached: ["Stopped at spend cap", "warn"],
};
const STEP_LABEL = { pending: "Waiting", running: "Running", done: "Done", flagged: "Needs your review", skipped: "Skipped", failed: "Failed" };
const STEP_CLASS = { done: "ok", flagged: "warn", failed: "bad", running: "live" };

function statusPill(s) {
  const [label, cls] = STATUS[s] || [s, ""];
  return h("span", { class: "pill " + cls }, ACTIVE.has(s) ? h("span", { class: "live-dot" }) : null, label);
}

// ---------- login ----------
function showLogin() {
  clearInterval(timer);
  $("#app").hidden = true;
  $("#login").hidden = false;
  $("#pw").focus();
}
async function doLogin() {
  $("#login-err").textContent = "";
  try {
    await api("/login", { method: "POST", body: { password: $("#pw").value } });
    $("#pw").value = "";
    await start();
  } catch (e) {
    $("#login-err").textContent = e.message;
  }
}

// ---------- data ----------
async function refreshJobs() {
  state.jobs = await api("/jobs");
  renderSide();
}
async function refreshJob() {
  if (!state.selectedId) return;
  state.job = await api("/jobs/" + state.selectedId);
  renderMain();
}
async function tick() {
  try {
    renderHeader();
    await refreshJobs();
    await refreshJob();
  } catch {
    /* auth errors already handled in api() */
  }
}
async function select(id) {
  state.selectedId = id;
  state.job = null;
  state.error = "";
  renderSide();
  renderMain();
  await refreshJob();
}
async function act(fn) {
  state.busy = true;
  state.error = "";
  renderMain();
  try {
    await fn();
  } catch (e) {
    state.error = e.message;
  }
  state.busy = false;
  await tick();
}

// ---------- render ----------
function renderHeader() {
  $("#statusline").replaceChildren(h("span", { class: "sdot" }), state.status?.mock ? "DEMO AGENTS ACTIVE" : "AGENTS ACTIVE");
  $("#stamp").textContent = "Updated " + new Date().toLocaleTimeString();
}

function renderSide() {
  document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));
}

function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("span", {}, label), h("b", {}, value), h("p", {}, sub));
}
function stats() {
  const active = state.jobs.filter((j) => ACTIVE.has(j.status)).length;
  const review = state.jobs.filter((j) => j.status === "awaiting_plan" || j.status === "awaiting_step").length;
  return h("div", { class: "stats" },
    stat("Active work", `${active} / 3`, "Concurrent run limit"),
    stat("Current spend", money(state.job ? state.job.costTotal : 0), "Selected goal, estimated"),
    stat("Operator review", String(review), "Plan or step decisions pending"),
    stat("Per-run ceiling", "$" + Number(state.status?.capUsd ?? 0).toFixed(2), "Policy spend limit"));
}
function emptyBox(title, text) {
  return h("div", { class: "empty" }, h("span", { class: "logo" }, "J"), h("b", {}, title), h("p", {}, text));
}
function picker() {
  const sel = h("select", { class: "sel", "aria-label": "Saved goals", onchange: (e) => e.target.value && select(e.target.value) },
    h("option", { value: "" }, state.jobs.length ? "Select a saved goal" : "No saved goals"),
    ...state.jobs.map((j) => h("option", { value: j.id, selected: j.id === state.selectedId }, j.goal.slice(0, 70) + " · " + (STATUS[j.status] || [j.status])[0])));
  return sel;
}
function rosterView() {
  const r = state.status?.roster || [];
  return h("section", { class: "panel" }, h("h3", {}, "Model roster"),
    r.length ? h("table", {},
      h("thead", {}, h("tr", {}, ...["Agent", "Provider", "Model", "Strengths", "In / Out per 1M tokens"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...r.map((x) => h("tr", {}, h("td", {}, x.id), h("td", {}, x.provider), h("td", {}, x.model), h("td", {}, x.strengths.join(", ")), h("td", {}, `$${x.priceIn} / $${x.priceOut}`)))))
      : emptyBox("No agents", "Add an API key on the server."),
    h("p", { class: "tags" }, "Prices are estimates from your server settings."));
}
function logView() {
  const j = state.job;
  return h("section", { class: "panel" }, h("h3", {}, "Activity log"),
    j ? h("div", { class: "log" }, ...j.events.map(eventLine)) : emptyBox("No goal selected", "Pick a saved goal in the control room to see everything that happened."));
}

function composer() {
  const ta = h("textarea", { id: "goal", maxlength: "500", placeholder: "Example: Research report on the AI agent orchestration market" });
  ta.value = state.draft;
  ta.addEventListener("input", () => (state.draft = ta.value));
  const go = () =>
    act(async () => {
      const job = await api("/jobs", { method: "POST", body: { goal: state.draft } });
      state.draft = "";
      state.selectedId = job.id;
    });
  return h("section", { class: "panel composer" },
    h("h2", {}, "What should your agents work on?"),
    ta,
    h("div", { class: "row" },
      h("button", { class: "primary", disabled: state.busy, onclick: go }, "Plan it"),
      h("span", { class: "muted" }, "Jarvis will show you the plan before anything runs.")
    ),
    state.error ? h("p", { class: "error", role: "alert" }, state.error) : null
  );
}

function keepOpen(key, summaryText, content) {
  const d = h("details", {}, h("summary", {}, summaryText), content);
  if (state.open.has(key)) d.open = true;
  d.addEventListener("toggle", () => (d.open ? state.open.add(key) : state.open.delete(key)));
  return d;
}

function stepCard(st) {
  const s = st.step;
  const cc = st.crossCheck;
  const verdict = cc
    ? cc.flagged ? "Needs your review" : cc.agreement ? "Models agreed" : "Conflict settled by the judge"
    : null;
  return h("li", { class: "step " + st.status },
    h("div", { class: "step-head" },
      h("span", { class: "step-title" }, `${s.id}. ${s.title}`),
      st.gate === "approval" ? h("span", { class: "pill warn" }, "Asks before running") : null,
      s.risk === "high" ? h("span", { class: "pill" }, "Cross-checked") : null,
      h("span", { class: "pill " + (STEP_CLASS[st.status] || "") }, st.status === "running" ? h("span", { class: "live-dot" }) : null, STEP_LABEL[st.status])
    ),
    h("div", { class: "tags" }, s.instruction),
    cc ? h("div", { class: "ledger" },
      ...cc.workerIds.flatMap((id, i) => [i ? h("span", { class: "arrow" }, "+") : null, h("span", { class: "chip" }, id)]),
      h("span", { class: "arrow" }, "judged by"),
      h("span", { class: "chip" }, cc.judgeId),
      h("span", { class: "arrow" }, "→"),
      h("b", {}, `${verdict} (confidence ${Math.round(cc.confidence * 100)}%)`)
    ) : st.models.length ? h("div", { class: "tags" }, "Done by " + st.models.join(", ")) : null,
    ...(cc ? cc.conflicts.map((c) => h("p", { class: "conflict" }, "Conflict: " + c)) : []),
    st.note ? h("p", { class: st.status === "failed" ? "error" : "muted" }, st.note) : null,
    st.output ? keepOpen(`out-${state.job.id}-${s.id}`, "See the output", h("pre", {}, st.output)) : null
  );
}

function gateBox(job) {
  if (job.status === "awaiting_plan") {
    return h("div", { class: "gate" },
      h("h3", {}, "Approve this plan?"),
      h("p", { class: "muted" }, "Nothing has run yet. Approving starts the steps below in order."),
      h("div", { class: "row" },
        h("button", { class: "primary", disabled: state.busy, onclick: () => act(() => api(`/jobs/${job.id}/plan`, { method: "POST", body: { approve: true } })) }, "Approve and run"),
        h("button", { class: "danger", disabled: state.busy, onclick: () => act(() => api(`/jobs/${job.id}/plan`, { method: "POST", body: { approve: false } })) }, "Reject plan")
      )
    );
  }
  if (job.status === "awaiting_step") {
    const st = job.steps.find((x) => x.step.id === job.pendingStep);
    return h("div", { class: "gate" },
      h("h3", {}, `Step ${job.pendingStep} needs your approval`),
      h("p", {}, st ? st.step.title : ""),
      h("p", { class: "muted" }, "Your policy requires a click before this step runs."),
      h("div", { class: "row" },
        h("button", { class: "primary", disabled: state.busy, onclick: () => act(() => api(`/jobs/${job.id}/step`, { method: "POST", body: { approve: true } })) }, "Run this step"),
        h("button", { class: "danger", disabled: state.busy, onclick: () => act(() => api(`/jobs/${job.id}/step`, { method: "POST", body: { approve: false } })) }, "Skip this step")
      )
    );
  }
  return null;
}

function eventLine(e) {
  const { t, event, runId, ...rest } = e;
  const detail = Object.keys(rest).length ? JSON.stringify(rest) : "";
  return h("div", {}, new Date(t).toLocaleTimeString() + "  ", h("b", {}, event), detail ? "  " + (detail.length > 200 ? detail.slice(0, 200) + "…" : detail) : "");
}

function jobView(job) {
  const pct = Math.min(100, (job.costTotal / job.capUsd) * 100);
  const bar = h("div", { class: "bar" }, h("i", {}));
  bar.firstChild.style.width = pct + "%";
  return [
    h("section", { class: "panel" },
      h("div", { class: "row" },
        h("h2", { class: "grow" }, job.goal),
        statusPill(job.status)
      ),
      h("div", { class: "spend" },
        h("span", { class: "muted" }, `Spend ${money(job.costTotal)} of ${money(job.capUsd)} cap (estimated)`),
        bar
      ),
      job.error ? h("p", { class: "error", role: "alert" }, job.error) : null,
      state.error ? h("p", { class: "error", role: "alert" }, state.error) : null,
      gateBox(job)
    ),
    job.steps.length || job.blocked.length ? h("section", { class: "panel" },
      h("h3", {}, "Task board"),
      h("ul", { class: "steps" }, ...job.steps.map(stepCard)),
      ...job.blocked.map((b) => h("p", { class: "muted" }, `Blocked by policy: ${b.title} (${b.reason})`))
    ) : null,
    job.report ? h("section", { class: "panel" },
      h("div", { class: "row" },
        h("h3", { class: "grow" }, "Report"),
        h("a", { href: `/api/jobs/${job.id}/report`, download: "" }, "Download .md")
      ),
      h("pre", {}, job.report)
    ) : null,
    job.costRows.length ? h("section", { class: "panel" },
      h("h3", {}, "Cost by agent"),
      h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", { class: "num" }, "Calls"), h("th", { class: "num" }, "Tokens in"), h("th", { class: "num" }, "Tokens out"), h("th", { class: "num" }, "USD"))),
        h("tbody", {}, ...job.costRows.map((r) => h("tr", {}, h("td", {}, r.id), h("td", { class: "num" }, r.calls), h("td", { class: "num" }, r.inTok), h("td", { class: "num" }, r.outTok), h("td", { class: "num" }, money(r.usd)))))
      )
    ) : null,
    h("section", { class: "panel" },
      keepOpen("log-" + job.id, `Activity log (${job.events.length} events)`, h("div", { class: "log" }, ...job.events.map(eventLine)))
    ),
  ];
}

function renderMain() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return; // don't disturb typing or an open dropdown
  const main = $("#main");
  renderSide();
  if (state.view === "roster") return main.replaceChildren(rosterView());
  if (state.view === "log") return main.replaceChildren(logView());
  const job = state.job;
  main.replaceChildren(...[
    h("div", { class: "head" },
      h("div", {}, h("span", { class: "crumb" }, "Operator console / Control room"), h("h1", { class: "h1" }, "Control room"),
        h("p", { class: "muted" }, "A deliberate queue for work that stays under your control.")),
      h("button", { class: "primary", onclick: newGoal }, "+ New goal")),
    stats(),
    state.selectedId ? null : composer(),
    h("section", { class: "panel" }, h("div", { class: "row" }, h("h3", { class: "grow" }, "Selected goal"), h("div", { class: "pick" }, picker())),
      state.selectedId && !job ? h("p", { class: "muted" }, "Loading…") : null,
      !state.selectedId ? emptyBox("Nothing in the queue", "Create a goal to ask Jarvis for a proposed plan. Work will not run until you review it.") : null),
    ...(job && state.selectedId ? jobView(job) : []),
  ].filter(Boolean));
}

function newGoal() {
  state.view = "room";
  state.selectedId = null;
  state.job = null;
  state.error = "";
  renderMain();
}

async function start() {
  state.status = await api("/status");
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderHeader();
  await tick();
  renderMain();
  clearInterval(timer);
  timer = setInterval(tick, 1800);
}

// ---------- wire up ----------
$("#login-btn").addEventListener("click", doLogin);
$("#pw").addEventListener("keydown", (e) => e.key === "Enter" && doLogin());
$("#logout").addEventListener("click", async () => {
  await api("/logout", { method: "POST" }).catch(() => {});
  showLogin();
});
document.querySelectorAll(".nav button").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    renderMain();
  })
);

start().catch(showLogin);
