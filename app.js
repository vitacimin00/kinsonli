const API_BASE = "";
const MAX_EMAILS = 10;
const POLL_MS = 5000;
const MAX_POLLS = 10;

const state = {
  emails: [],
  inbox: new Map(),
  pollTimer: null,
  pollCount: 0,
  checking: false,
};

const els = {
  statusPill: document.querySelector("#statusPill"),
  countInput: document.querySelector("#countInput"),
  domainSelect: document.querySelector("#domainSelect"),
  customDomainInput: document.querySelector("#customDomainInput"),
  addDomainBtn: document.querySelector("#addDomainBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  checkBtn: document.querySelector("#checkBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  copyAllBtn: document.querySelector("#copyAllBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  generatedCount: document.querySelector("#generatedCount"),
  foundCount: document.querySelector("#foundCount"),
  waitingCount: document.querySelector("#waitingCount"),
  mailGrid: document.querySelector("#mailGrid"),
};

function setStatus(text, type = "") {
  els.statusPill.textContent = text;
  els.statusPill.className = `status-pill ${type}`.trim();
}

function clampCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return MAX_EMAILS;
  }
  return Math.max(1, Math.min(MAX_EMAILS, parsed));
}

function normalizeDomain(value) {
  return value.trim().toLowerCase().replace(/^@+/, "") || "kinsonli.site";
}

async function api(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

async function generateEmails() {
  stopChecking();
  setStatus("Generating");

  try {
    const count = clampCount(els.countInput.value);
    const domain = normalizeDomain(els.domainSelect.value);
    els.countInput.value = String(count);

    const data = await api("/api/generate", { count, domain });
    state.emails = data.emails || [];
    state.inbox = new Map();
    render();
    setStatus("Ready", "ok");
  } catch (error) {
    setStatus("Error", "error");
    showError(error.message);
  }
}

async function loadDomains(selectedDomain = "") {
  try {
    const data = await apiGet("/api/domains");
    renderDomains(data.domains || [], selectedDomain);
  } catch (error) {
    setStatus("Domain error", "error");
    renderDomains(["kinsonli.site"], selectedDomain);
  }
}

function renderDomains(domains, selectedDomain = "") {
  const current = normalizeDomain(selectedDomain || els.domainSelect.value || "kinsonli.site");
  els.domainSelect.innerHTML = "";

  const unique = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  if (!unique.includes("kinsonli.site")) {
    unique.unshift("kinsonli.site");
  }

  unique.forEach((domain) => {
    const option = document.createElement("option");
    option.value = domain;
    option.textContent = domain;
    option.selected = domain === current;
    els.domainSelect.appendChild(option);
  });
}

async function addCustomDomain() {
  const domain = normalizeDomain(els.customDomainInput.value);
  if (!domain) {
    return;
  }

  setStatus("Saving");
  try {
    const data = await api("/api/domains", { domain });
    renderDomains(data.domains || [], data.domain || domain);
    els.customDomainInput.value = "";
    setStatus("Saved", "ok");
  } catch (error) {
    setStatus("Error", "error");
    showError(error.message);
  }
}

async function checkInboxOnce() {
  if (!state.emails.length) {
    return;
  }

  setStatus(`Checking ${state.pollCount + 1}/${MAX_POLLS}`);

  try {
    const data = await api("/api/inbox/bulk", { emails: state.emails });
    for (const result of data.results || []) {
      if (result.message) {
        state.inbox.set(result.email, result.message);
      }
    }
    state.pollCount += 1;
    render();

    const foundAll = state.emails.every((email) => state.inbox.has(email));
    if (foundAll) {
      stopChecking("Complete", "ok");
      return;
    }
    if (state.pollCount >= MAX_POLLS) {
      stopChecking("Timeout", "error");
    }
  } catch (error) {
    stopChecking("Error", "error");
    showError(error.message);
  }
}

function startChecking() {
  if (!state.emails.length || state.checking) {
    return;
  }

  state.checking = true;
  state.pollCount = 0;
  els.checkBtn.disabled = true;
  els.stopBtn.disabled = false;
  checkInboxOnce();
  state.pollTimer = window.setInterval(checkInboxOnce, POLL_MS);
}

function stopChecking(status = "Stopped", type = "") {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.checking = false;
  els.checkBtn.disabled = !state.emails.length;
  els.stopBtn.disabled = true;
  if (status) {
    setStatus(status, type);
  }
}

function clearAll() {
  stopChecking("Idle");
  state.emails = [];
  state.inbox = new Map();
  render();
}

function render() {
  const found = state.emails.filter((email) => state.inbox.has(email)).length;
  const waiting = state.emails.length - found;

  els.generatedCount.textContent = String(state.emails.length);
  els.foundCount.textContent = String(found);
  els.waitingCount.textContent = String(waiting);
  els.checkBtn.disabled = !state.emails.length || state.checking;
  els.copyAllBtn.disabled = !state.emails.length;

  if (!state.emails.length) {
    els.mailGrid.innerHTML = '<div class="empty-state">Generate email dulu untuk mulai cek inbox.</div>';
    return;
  }

  els.mailGrid.innerHTML = "";
  state.emails.forEach((email) => {
    els.mailGrid.appendChild(renderEmailCard(email, state.inbox.get(email)));
  });
}

function renderEmailCard(email, message) {
  const card = document.createElement("article");
  card.className = `mail-card ${message ? "found" : "waiting"}`;

  const top = document.createElement("div");
  top.className = "mail-card-top";

  const emailText = document.createElement("strong");
  emailText.textContent = email;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = message ? "Found" : "Waiting";

  top.append(emailText, badge);
  card.appendChild(top);

  if (!message) {
    const waiting = document.createElement("p");
    waiting.className = "muted";
    waiting.textContent = "Belum ada subject masuk.";
    card.appendChild(waiting);
    return card;
  }

  const details = [
    ["To", message.to || email],
    ["From", message.from || "-"],
    ["Subject", message.subject || "-"],
    ["Received", formatDate(message.received_at)],
  ];

  for (const [label, value] of details) {
    const row = document.createElement("div");
    row.className = "detail-row";
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    const valueEl = document.createElement("strong");
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    card.appendChild(row);
  }

  const codeRow = document.createElement("div");
  codeRow.className = "code-row";
  const code = document.createElement("strong");
  code.textContent = message.code || "Tidak terdeteksi";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "secondary";
  copyBtn.textContent = "Copy Code";
  copyBtn.disabled = !message.code;
  copyBtn.addEventListener("click", () => copyText(message.code, "Copied"));
  codeRow.append(code, copyBtn);
  card.appendChild(codeRow);

  return card;
}

function showError(message) {
  els.mailGrid.innerHTML = "";
  const box = document.createElement("div");
  box.className = "empty-state error-box";
  box.textContent = message || "Request gagal.";
  els.mailGrid.appendChild(box);
}

async function copyText(text, statusText = "Copied") {
  await navigator.clipboard.writeText(text);
  setStatus(statusText, "ok");
  window.setTimeout(() => {
    if (!state.checking) {
      setStatus("Ready", "ok");
    }
  }, 1200);
}

function copyAllEmails() {
  if (!state.emails.length) {
    return;
  }
  copyText(state.emails.join("\n"), "Email copied");
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function bindEvents() {
  els.generateBtn.addEventListener("click", generateEmails);
  els.addDomainBtn.addEventListener("click", addCustomDomain);
  els.customDomainInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      addCustomDomain();
    }
  });
  els.checkBtn.addEventListener("click", startChecking);
  els.stopBtn.addEventListener("click", () => stopChecking());
  els.copyAllBtn.addEventListener("click", copyAllEmails);
  els.clearBtn.addEventListener("click", clearAll);
}

bindEvents();
loadDomains();
render();
