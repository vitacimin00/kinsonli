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
  nameSourceSelect: document.querySelector("#nameSourceSelect"),
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
  manualEmailInput: document.querySelector("#manualEmailInput"),
  manualCheckBtn: document.querySelector("#manualCheckBtn"),
  manualResult: document.querySelector("#manualResult"),
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
  return value.trim().toLowerCase().replace(/^@+/, "");
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
    const source = els.nameSourceSelect.value;
    els.countInput.value = String(count);

    const data = await api("/api/generate", { count, domain, source });
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
    renderDomains([], selectedDomain);
  }
}

function renderDomains(domains, selectedDomain = "") {
  const current = normalizeDomain(selectedDomain || els.domainSelect.value || "");
  els.domainSelect.innerHTML = "";

  const unique = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  if (!unique.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Tambah domain dulu";
    option.disabled = true;
    option.selected = true;
    els.domainSelect.appendChild(option);
    return;
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
    waiting.textContent = "Menunggu kode...";
    card.appendChild(waiting);
    return card;
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

async function checkManualEmail() {
  const email = els.manualEmailInput.value.trim().toLowerCase();
  if (!email) {
    renderManualEmpty("Masukkan alamat email dulu.");
    return;
  }

  els.manualCheckBtn.disabled = true;
  setStatus("Manual check");
  try {
    const data = await api("/api/inbox/detail", { email });
    renderManualResult(data);
    setStatus("Ready", "ok");
  } catch (error) {
    setStatus("Error", "error");
    renderManualError(error.message);
  } finally {
    els.manualCheckBtn.disabled = false;
  }
}

function renderManualResult(data) {
  const message = data.message;
  if (!message) {
    renderManualEmpty("Belum ada email masuk untuk alamat ini.");
    return;
  }

  els.manualResult.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "manual-meta";
  meta.append(
    createMetaRow("From", message.from || "-"),
    createMetaRow("Subject", message.subject || "-"),
    createMetaRow("Received", formatDate(message.received_at)),
  );
  els.manualResult.appendChild(meta);

  if (message.code) {
    const codeRow = document.createElement("div");
    codeRow.className = "manual-code";
    const code = document.createElement("strong");
    code.textContent = message.code;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary";
    button.textContent = "Copy Code";
    button.addEventListener("click", () => copyText(message.code, "Copied"));
    codeRow.append(code, button);
    els.manualResult.appendChild(codeRow);
  }

  if (message.allowed_full_body) {
    const body = document.createElement("pre");
    body.className = "manual-body";
    body.textContent = message.body || "Isi email kosong.";
    els.manualResult.appendChild(body);
    return;
  }

  const notice = document.createElement("p");
  notice.className = "manual-notice";
  notice.textContent = `Isi email disembunyikan. Sender terdeteksi: ${message.from_email || message.from || "-"}`;
  els.manualResult.appendChild(notice);
}

function createMetaRow(label, value) {
  const row = document.createElement("div");
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

function renderManualEmpty(text) {
  els.manualResult.innerHTML = "";
  const empty = document.createElement("p");
  empty.className = "muted";
  empty.textContent = text;
  els.manualResult.appendChild(empty);
}

function renderManualError(text) {
  els.manualResult.innerHTML = "";
  const error = document.createElement("p");
  error.className = "error-box";
  error.textContent = text || "Gagal cek email.";
  els.manualResult.appendChild(error);
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
  els.manualCheckBtn.addEventListener("click", checkManualEmail);
  els.manualEmailInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      checkManualEmail();
    }
  });
}

bindEvents();
loadDomains();
render();
