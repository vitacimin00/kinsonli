/* ═══════════════════════════════════════════════════
   ShadowMail — Frontend Logic
   ═══════════════════════════════════════════════════ */

const API = "";
const MAX_EMAILS = 10;
const POLL_INTERVAL_MS = 5000;
const MANUAL_POLL_MS = 5000;
const STORAGE_KEY = "shadowmail_emails";

/* ─── State ─── */
const state = {
  emails: [],
  inbox: new Map(),     // email -> { code, from, subject, received_at }
  pollTimer: null,
  pollCount: 0,
  polling: false,
  domains: [],
  manualMessages: [],   // all messages for manual viewer
  activeMessageId: null,
  manualEmail: "",       // current email in manual viewer
  manualPollTimer: null, // auto-refresh timer for manual inbox
  manualPolling: false,
  notificationsEnabled: false,
};

/* ─── DOM ─── */
const $ = (sel) => document.querySelector(sel);
const els = {
  statusIndicator: $("#statusIndicator"),
  statusText: $("#statusText"),
  countInput: $("#countInput"),
  domainSelect: $("#domainSelect"),
  nameSourceSelect: $("#nameSourceSelect"),
  customDomainInput: $("#customDomainInput"),
  addDomainBtn: $("#addDomainBtn"),
  generateBtn: $("#generateBtn"),
  copyAllBtn: $("#copyAllBtn"),
  clearBtn: $("#clearBtn"),
  generatedCount: $("#generatedCount"),
  foundCount: $("#foundCount"),
  waitingCount: $("#waitingCount"),
  pollInfo: $("#pollInfo"),
  mailGrid: $("#mailGrid"),
  manualEmailInput: $("#manualEmailInput"),
  manualCheckBtn: $("#manualCheckBtn"),
  inboxList: $("#inboxList"),
  inboxBody: $("#inboxBody"),
};

/* ═══ Utilities ═══ */

function setStatus(text, type = "") {
  els.statusText.textContent = text;
  els.statusIndicator.className = `status-indicator ${type}`.trim();
}

function clamp(val, min, max) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeDomain(v) {
  return v.trim().toLowerCase().replace(/^@+/, "");
}

function showToast(text, type = "") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

async function copyToClipboard(text, label = "Copied!") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label, "success");
  } catch {
    showToast("Gagal copy", "error");
  }
}

/* ═══ Notification System ═══ */

let audioCtx = null;

function playNotificationSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    // Pleasant two-tone chime
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1108, audioCtx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);

    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch {
    // Audio not supported, silently ignore
  }
}

function sendBrowserNotification(title, body) {
  if (!state.notificationsEnabled) return;
  try {
    if (Notification.permission === "granted") {
      const n = new Notification(title, {
        body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📬</text></svg>",
        silent: true, // we play our own sound
      });
      setTimeout(() => n.close(), 5000);
    }
  } catch {
    // Notifications not supported
  }
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  state.notificationsEnabled = Notification.permission === "granted";
}

function notifyNewCodes(newEmails) {
  if (!newEmails.length) return;
  playNotificationSound();

  const summary = newEmails
    .map((e) => {
      const msg = state.inbox.get(e);
      return msg?.code ? `${e.split("@")[0]}: ${msg.code}` : e.split("@")[0];
    })
    .join(", ");

  sendBrowserNotification(
    `🔔 ${newEmails.length} code baru ditemukan!`,
    summary
  );
}

/* ═══ API Helpers ═══ */

async function apiPost(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function apiGet(path) {
  const res = await fetch(`${API}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ═══ LocalStorage ═══ */

function saveToStorage() {
  const payload = {
    emails: state.emails,
    inbox: Object.fromEntries(state.inbox),
    savedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const payload = JSON.parse(raw);
    // Expire after 24h
    if (Date.now() - payload.savedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    state.emails = payload.emails || [];
    state.inbox = new Map(Object.entries(payload.inbox || {}));
    return state.emails.length > 0;
  } catch {
    return false;
  }
}

function clearStorage() {
  localStorage.removeItem(STORAGE_KEY);
}

/* ═══ Domains ═══ */

async function loadDomains() {
  try {
    const data = await apiGet("/api/domains");
    state.domains = (data.domains || []).map(normalizeDomain).filter(Boolean);
    renderDomains();
  } catch {
    state.domains = [];
    renderDomains();
  }
}

function renderDomains() {
  const current = normalizeDomain(els.domainSelect.value || "");
  els.domainSelect.innerHTML = "";

  // Random option
  const randomOpt = document.createElement("option");
  randomOpt.value = "__random__";
  randomOpt.textContent = "🎲 Random Domain";
  els.domainSelect.appendChild(randomOpt);

  state.domains.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    if (d === current) opt.selected = true;
    els.domainSelect.appendChild(opt);
  });
}

async function addDomain() {
  const domain = normalizeDomain(els.customDomainInput.value);
  if (!domain) return;

  try {
    const data = await apiPost("/api/domains", { domain });
    state.domains = (data.domains || []).map(normalizeDomain).filter(Boolean);
    renderDomains();
    // Select the new domain
    els.domainSelect.value = data.domain || domain;
    els.customDomainInput.value = "";
    showToast(`Domain ${domain} ditambahkan!`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ═══ Generate Emails ═══ */

function getSelectedDomain() {
  const val = els.domainSelect.value;
  if (val === "__random__" && state.domains.length > 0) {
    return state.domains[Math.floor(Math.random() * state.domains.length)];
  }
  return val || (state.domains[0] || "");
}

async function generateEmails() {
  stopPolling();

  const count = clamp(els.countInput.value, 1, MAX_EMAILS);
  els.countInput.value = count;
  const domain = getSelectedDomain();
  const source = els.nameSourceSelect.value;

  if (!domain || domain === "__random__") {
    showToast("Tambah domain dulu sebelum generate!", "error");
    return;
  }

  setStatus("Generating...", "generating");
  els.generateBtn.disabled = true;

  try {
    const data = await apiPost("/api/generate", { count, domain, source });
    state.emails = data.emails || [];
    state.inbox = new Map();
    saveToStorage();
    renderGrid();
    updateStats();
    showToast(`${state.emails.length} email berhasil di-generate`, "success");

    // Auto-start polling
    startPolling();
  } catch (err) {
    setStatus("Error", "error");
    showError(err.message);
  } finally {
    els.generateBtn.disabled = false;
  }
}

/* ═══ Polling ═══ */

function startPolling() {
  if (!state.emails.length || state.polling) return;

  state.polling = true;
  state.pollCount = 0;
  setStatus("Polling", "polling");

  // Immediate first check
  pollOnce();
  state.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  state.polling = false;
}

async function pollOnce() {
  if (!state.emails.length) {
    stopPolling();
    return;
  }

  state.pollCount++;
  els.pollInfo.textContent = `#${state.pollCount}`;
  setStatus(`Polling #${state.pollCount}`, "polling");

  try {
    const data = await apiPost("/api/inbox/bulk", { emails: state.emails });
    const newlyFound = [];

    for (const result of data.results || []) {
      if (result.message && !state.inbox.has(result.email)) {
        state.inbox.set(result.email, result.message);
        newlyFound.push(result.email);
      }
    }

    if (newlyFound.length) {
      saveToStorage();
      notifyNewCodes(newlyFound);
    }

    renderGrid();
    updateStats();

    // Check if all found
    const allFound = state.emails.every((e) => state.inbox.has(e));
    if (allFound) {
      stopPolling();
      setStatus("All Found", "ok");
      showToast("Semua email sudah mendapat kode!", "success");
    }
  } catch {
    // Keep polling on error, don't stop
  }
}

/* ═══ Render Grid ═══ */

function updateStats() {
  const found = state.emails.filter((e) => state.inbox.has(e)).length;
  const waiting = state.emails.length - found;

  els.generatedCount.textContent = state.emails.length;
  els.foundCount.textContent = found;
  els.waitingCount.textContent = waiting;
  els.copyAllBtn.disabled = !state.emails.length;
  els.clearBtn.disabled = !state.emails.length;

  if (!state.polling && state.emails.length) {
    const hasWaiting = waiting > 0;
    if (hasWaiting) {
      setStatus("Idle", "");
    } else {
      setStatus("Complete", "ok");
    }
  }
}

function renderGrid() {
  if (!state.emails.length) {
    els.mailGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📬</div>
        <p>Pilih jumlah email dan klik <strong>Generate</strong> untuk mulai.</p>
      </div>`;
    return;
  }

  els.mailGrid.innerHTML = "";
  state.emails.forEach((email) => {
    els.mailGrid.appendChild(createMailCard(email, state.inbox.get(email)));
  });
}

function createMailCard(email, message) {
  const card = document.createElement("article");
  card.className = `mail-card ${message ? "found" : "waiting"}`;

  const header = document.createElement("div");
  header.className = "mail-card-header";

  const emailEl = document.createElement("span");
  emailEl.className = "mail-email";
  emailEl.textContent = email;
  emailEl.title = "Click to copy email";
  emailEl.addEventListener("click", () => copyToClipboard(email, "Email copied!"));

  const badge = document.createElement("span");
  badge.className = `mail-badge ${message ? "found" : "waiting"}`;
  badge.textContent = message ? "Code Found" : "Waiting";

  header.append(emailEl, badge);
  card.appendChild(header);

  if (message) {
    const codeArea = document.createElement("div");
    codeArea.className = "mail-code-area";

    const codeEl = document.createElement("span");
    if (message.code) {
      codeEl.className = "mail-code";
      codeEl.textContent = message.code;
    } else {
      codeEl.className = "mail-code no-code";
      codeEl.textContent = "No code detected";
    }

    codeArea.appendChild(codeEl);

    if (message.code) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "btn-copy-code";
      copyBtn.textContent = "Copy Code";
      copyBtn.addEventListener("click", () => copyToClipboard(message.code, "Code copied!"));
      codeArea.appendChild(copyBtn);
    }

    card.appendChild(codeArea);
  } else {
    const waitRow = document.createElement("div");
    waitRow.className = "mail-code-area";
    waitRow.innerHTML = `
      <span class="mail-waiting-text">Menunggu email masuk
        <span class="mail-waiting-dots"><span></span><span></span><span></span></span>
      </span>
      <button class="btn-copy-email" onclick="event.stopPropagation()">Copy Email</button>`;
    waitRow.querySelector(".btn-copy-email").addEventListener("click", () => {
      copyToClipboard(email, "Email copied!");
    });
    card.appendChild(waitRow);
  }

  return card;
}

function showError(msg) {
  els.mailGrid.innerHTML = `<div class="error-state">${msg || "Request gagal."}</div>`;
}

/* ═══ Clear ═══ */

function clearAll() {
  stopPolling();
  state.emails = [];
  state.inbox = new Map();
  clearStorage();
  renderGrid();
  updateStats();
  els.pollInfo.textContent = "—";
  setStatus("Idle", "");
  showToast("Semua email dihapus", "success");
}

/* ═══ Copy All ═══ */

function copyAllEmails() {
  if (!state.emails.length) return;
  copyToClipboard(state.emails.join("\n"), `${state.emails.length} email copied!`);
}

/* ═══ Manual Inbox Viewer ═══ */

async function checkManualInbox(isAutoRefresh = false) {
  const email = els.manualEmailInput.value.trim().toLowerCase();
  if (!email) {
    if (!isAutoRefresh) showToast("Masukkan email dulu", "error");
    return;
  }

  state.manualEmail = email;

  if (!isAutoRefresh) {
    els.manualCheckBtn.disabled = true;
    setStatus("Checking inbox...", "generating");
    renderInboxLoading();
  }

  try {
    const data = await apiPost("/api/inbox/messages", { email });
    const oldCount = state.manualMessages.length;
    state.manualMessages = data.messages || [];

    // Notify if new messages arrived during auto-refresh
    if (isAutoRefresh && state.manualMessages.length > oldCount) {
      const diff = state.manualMessages.length - oldCount;
      playNotificationSound();
      sendBrowserNotification(
        `📨 ${diff} pesan baru!`,
        `Email: ${email}`
      );
    }

    // Preserve selected message if still exists, otherwise select first
    if (!isAutoRefresh) {
      state.activeMessageId = null;
    }
    renderInboxList();

    if (state.manualMessages.length > 0) {
      if (!state.activeMessageId) {
        selectMessage(state.manualMessages[0].id);
      } else {
        // Re-render active message body (might have updated)
        const activeMsg = state.manualMessages.find((m) => m.id === state.activeMessageId);
        if (activeMsg) renderInboxBody(activeMsg);
      }
      if (!isAutoRefresh) setStatus(`${state.manualMessages.length} pesan ditemukan`, "ok");
    } else {
      renderInboxBodyEmpty("Belum ada email masuk untuk alamat ini.");
      if (!isAutoRefresh) setStatus("No messages", "");
    }

    // Start auto-refresh if not already running
    if (!state.manualPolling) startManualPolling();

  } catch (err) {
    if (!isAutoRefresh) {
      showToast(err.message, "error");
      setStatus("Error", "error");
    }
    renderInboxBodyEmpty("Gagal mengambil data inbox.");
  } finally {
    if (!isAutoRefresh) els.manualCheckBtn.disabled = false;
  }
}

function startManualPolling() {
  stopManualPolling();
  state.manualPolling = true;
  updateManualPollIndicator();
  state.manualPollTimer = setInterval(() => {
    if (state.manualEmail) {
      checkManualInbox(true);
    }
  }, MANUAL_POLL_MS);
}

function stopManualPolling() {
  if (state.manualPollTimer) {
    clearInterval(state.manualPollTimer);
    state.manualPollTimer = null;
  }
  state.manualPolling = false;
  updateManualPollIndicator();
}

function updateManualPollIndicator() {
  const el = document.getElementById("manualLiveIndicator");
  if (el) {
    el.classList.toggle("active", state.manualPolling);
    el.textContent = state.manualPolling ? "● LIVE" : "○ PAUSED";
  }
}

function renderInboxLoading() {
  els.inboxList.innerHTML = `<div class="inbox-loading">
    <span class="mail-waiting-dots"><span></span><span></span><span></span></span>
    Memuat inbox...
  </div>`;
  els.inboxBody.innerHTML = `<div class="inbox-empty"><p>Memuat...</p></div>`;
}

function renderInboxList() {
  if (!state.manualMessages.length) {
    els.inboxList.innerHTML = `<div class="inbox-empty"><p>Tidak ada pesan ditemukan.</p></div>`;
    return;
  }

  els.inboxList.innerHTML = "";
  state.manualMessages.forEach((msg) => {
    const item = document.createElement("div");
    item.className = `inbox-item ${msg.id === state.activeMessageId ? "active" : ""}`;
    item.dataset.id = msg.id;

    const fromName = extractDisplayName(msg.from);

    let metaRight = "";
    if (msg.code) {
      metaRight = `<span class="inbox-item-code">${msg.code}</span>`;
    }

    item.innerHTML = `
      <div class="inbox-item-from">${escapeHtml(fromName)}</div>
      <div class="inbox-item-subject">${escapeHtml(msg.subject || "(No Subject)")}</div>
      <div class="inbox-item-meta">
        <span class="inbox-item-time">${formatTime(msg.received_at)}</span>
        ${metaRight}
      </div>`;

    item.addEventListener("click", () => selectMessage(msg.id));
    els.inboxList.appendChild(item);
  });
}

function selectMessage(id) {
  state.activeMessageId = id;
  const msg = state.manualMessages.find((m) => m.id === id);
  if (!msg) return;

  // Update active state in list
  els.inboxList.querySelectorAll(".inbox-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.id) === id);
  });

  renderInboxBody(msg);
}

function renderInboxBody(msg) {
  els.inboxBody.innerHTML = "";

  // Header
  const header = document.createElement("div");
  header.className = "inbox-body-header";
  header.innerHTML = `
    <div class="inbox-body-subject">${escapeHtml(msg.subject || "(No Subject)")}</div>
    <div class="inbox-body-meta">
      <div class="inbox-body-meta-row">
        <span class="inbox-body-meta-label">From</span>
        <span class="inbox-body-meta-value">${escapeHtml(msg.from || "—")}</span>
      </div>
      <div class="inbox-body-meta-row">
        <span class="inbox-body-meta-label">To</span>
        <span class="inbox-body-meta-value">${escapeHtml(msg.to || "—")}</span>
      </div>
      <div class="inbox-body-meta-row">
        <span class="inbox-body-meta-label">Date</span>
        <span class="inbox-body-meta-value">${formatDate(msg.received_at)}</span>
      </div>
    </div>`;
  els.inboxBody.appendChild(header);

  // Code banner
  if (msg.code) {
    const banner = document.createElement("div");
    banner.className = "inbox-body-code-banner";
    banner.innerHTML = `
      <div><span style="font-size:12px;color:var(--text-muted);font-weight:600;">VERIFICATION CODE</span><br>
      <strong>${escapeHtml(msg.code)}</strong></div>
      <button class="btn-copy-code">Copy Code</button>`;
    banner.querySelector(".btn-copy-code").addEventListener("click", () => {
      copyToClipboard(msg.code, "Code copied!");
    });
    els.inboxBody.appendChild(banner);
  }

  // Body content
  const content = document.createElement("div");
  content.className = "inbox-body-content";

  const body = msg.body || "";

  // Check if body looks like HTML
  if (/<[a-z][\s\S]*>/i.test(body)) {
    // Render HTML in sandboxed iframe
    const iframe = document.createElement("iframe");
    iframe.sandbox = "allow-same-origin";
    iframe.title = "Email body";
    content.appendChild(iframe);
    els.inboxBody.appendChild(content);

    // Write content after iframe is attached
    requestAnimationFrame(() => {
      const doc = iframe.contentDocument;
      if (doc) {
        doc.open();
        doc.write(`<!doctype html><html><head><meta charset="utf-8">
          <style>
            body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; padding: 16px; margin: 0; background: #fff; }
            img { max-width: 100%; height: auto; }
            a { color: #2563eb; }
            table { border-collapse: collapse; max-width: 100%; }
          </style></head><body>${body}</body></html>`);
        doc.close();

        // Auto-resize iframe
        const resizeObserver = new ResizeObserver(() => {
          const h = doc.documentElement.scrollHeight;
          iframe.style.height = `${Math.max(200, Math.min(600, h))}px`;
        });
        resizeObserver.observe(doc.documentElement);
      }
    });
  } else {
    // Plain text
    const pre = document.createElement("pre");
    pre.textContent = body || "(Email body kosong)";
    content.appendChild(pre);
    els.inboxBody.appendChild(content);
  }
}

function renderInboxBodyEmpty(text) {
  els.inboxBody.innerHTML = `<div class="inbox-empty"><p>${text}</p></div>`;
}

/* ═══ Helpers ═══ */

function extractDisplayName(fromHeader) {
  if (!fromHeader) return "Unknown";
  // "Name <email>" → "Name"
  const match = fromHeader.match(/^(.+?)\s*<[^>]+>$/);
  if (match) return match[1].replace(/^["']|["']$/g, "").trim();
  return fromHeader;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/* ═══ Event Bindings ═══ */

function bindEvents() {
  els.generateBtn.addEventListener("click", generateEmails);
  els.copyAllBtn.addEventListener("click", copyAllEmails);
  els.clearBtn.addEventListener("click", clearAll);
  els.addDomainBtn.addEventListener("click", addDomain);
  els.customDomainInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDomain();
  });
  els.manualCheckBtn.addEventListener("click", checkManualInbox);
  els.manualEmailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkManualInbox();
  });

  // Clamp count input
  els.countInput.addEventListener("change", () => {
    els.countInput.value = clamp(els.countInput.value, 1, MAX_EMAILS);
  });
}

/* ═══ Init ═══ */

async function init() {
  bindEvents();
  await loadDomains();
  await requestNotificationPermission();

  // Restore from localStorage
  const restored = loadFromStorage();
  if (restored) {
    renderGrid();
    updateStats();

    // Resume polling if there are waiting emails
    const hasWaiting = state.emails.some((e) => !state.inbox.has(e));
    if (hasWaiting) {
      startPolling();
    } else {
      setStatus("Complete", "ok");
    }
  } else {
    renderGrid();
    updateStats();
  }
}

init();
