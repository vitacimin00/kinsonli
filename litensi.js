/* ═══════════════════════════════════════════════════
   Litensi Mail — Email Activation Frontend v2
   ═══════════════════════════════════════════════════ */

const PROXY_URL = "/api/litensi/proxy";
const POLL_INTERVAL_MS = 6000; // ≥ 5s required by API
const STORAGE_CREDS_KEY = "litensi_creds";
const STORAGE_ORDERS_KEY = "litensi_orders";

/* ─── State ─── */
const state = {
  apiId: null,
  apiKey: null,
  loggedIn: false,
  balance: 0,
  orders: [],        // {order_id, zone, site, price, email, expired_at, status, message, full_message}
  pollTimers: {},     // order_id -> intervalId
  prices: [],        // current price list
};

/* ─── DOM ─── */
const $ = (sel) => document.querySelector(sel);
const els = {};

function cacheDom() {
  els.statusIndicator = $(".status-indicator");
  els.statusText      = $(".status-text");
  els.apiIdInput      = $("#apiIdInput");
  els.apiKeyInput     = $("#apiKeyInput");
  els.loginBtn        = $("#loginBtn");
  els.balanceBar      = $("#balanceBar");
  els.balanceAmount   = $("#balanceAmount");
  els.logoutBtn       = $("#logoutBtn");
  els.loginPanel      = $("#loginPanel");
  els.orderPanel      = $("#orderPanel");
  els.siteInput       = $("#siteInput");
  els.zoneSelect      = $("#zoneSelect");
  els.bulkCount       = $("#bulkCount");
  els.orderBtn        = $("#orderBtn");
  els.ordersContainer = $("#ordersContainer");
  els.ordersLiveIndicator = $("#ordersLiveIndicator");
  els.copyAllBtn      = $("#copyAllBtn");
  els.clearDoneBtn    = $("#clearDoneBtn");
}

/* ═══════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════ */

function setStatus(text, type = "") {
  if (!els.statusIndicator) return;
  els.statusText.textContent = text;
  els.statusIndicator.className = "status-indicator";
  if (type) els.statusIndicator.classList.add(type);
}

function showToast(text, type = "") {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`.trim();
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

function formatIDR(num) {
  if (num == null || isNaN(num)) return "Rp 0";
  return "Rp " + Number(num).toLocaleString("id-ID");
}

function formatTimeRemaining(expiredAt) {
  if (!expiredAt) return "";
  const diff = new Date(expiredAt).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const mins = Math.floor(diff / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function copyToClipboard(text, label = "Copied!") {
  try {
    await navigator.clipboard.writeText(text);
    showToast(label, "success");
  } catch {
    showToast("Gagal copy", "error");
  }
}

/* ═══════════════════════════════════════════════════
   Notification Sound
   ═══════════════════════════════════════════════════ */

let audioCtx = null;

function playNotificationSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1108, audioCtx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch { /* silent */ }
}

/* ═══════════════════════════════════════════════════
   API Proxy
   ═══════════════════════════════════════════════════ */

async function proxyCall(endpoint, params = {}) {
  if (!state.apiId || !state.apiKey) {
    throw new Error("Belum login. Masukkan API credentials dulu.");
  }
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_id: state.apiId,
      api_key: state.apiKey,
      endpoint,
      params,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.data || res.statusText);
  if (data.success === false) throw new Error(data.data || "API error");
  return data;
}

/* ═══════════════════════════════════════════════════
   LocalStorage
   ═══════════════════════════════════════════════════ */

function saveCreds() {
  localStorage.setItem(STORAGE_CREDS_KEY, JSON.stringify({ api_id: state.apiId, api_key: state.apiKey }));
}
function loadCreds() {
  try { const r = localStorage.getItem(STORAGE_CREDS_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
function clearCreds() { localStorage.removeItem(STORAGE_CREDS_KEY); }

function saveOrders() {
  localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(state.orders));
}
function loadOrders() {
  try { const r = localStorage.getItem(STORAGE_ORDERS_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
function clearOrders() { localStorage.removeItem(STORAGE_ORDERS_KEY); }

/* ═══════════════════════════════════════════════════
   Login / Logout
   ═══════════════════════════════════════════════════ */

async function login() {
  const apiId = parseInt(els.apiIdInput.value, 10);
  const apiKey = (els.apiKeyInput.value || "").trim();

  if (!apiId || !apiKey) {
    showToast("Masukkan API ID dan API Key", "error");
    return;
  }

  els.loginBtn.disabled = true;
  els.loginBtn.textContent = "Logging in...";
  setStatus("Connecting...", "loading");

  state.apiId = apiId;
  state.apiKey = apiKey;

  try {
    const result = await proxyCall("profile", {});
    state.loggedIn = true;
    state.balance = result.data.balance || 0;
    saveCreds();
    showLoggedInUI();

    // Restore saved orders
    state.orders = loadOrders();
    renderOrders();

    // Resume polling for WAITING orders
    state.orders.forEach((o) => {
      if (o.status === "WAITING") startPolling(o.order_id);
    });

    els.orderPanel.style.display = "";
    setStatus("Connected", "ok");
    showToast(`Login berhasil! Saldo: ${formatIDR(state.balance)}`, "success");
  } catch (err) {
    state.apiId = null;
    state.apiKey = null;
    setStatus("Login Failed", "error");
    showToast(err.message || "Login gagal", "error");
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = "Login";
  }
}

function logout() {
  Object.keys(state.pollTimers).forEach((id) => stopPolling(Number(id)));
  state.apiId = null;
  state.apiKey = null;
  state.loggedIn = false;
  state.balance = 0;
  state.orders = [];
  state.prices = [];
  clearCreds();
  clearOrders();
  showLoggedOutUI();
  els.orderPanel.style.display = "none";
  renderOrders();
  setStatus("Ready", "");
  showToast("Logged out", "success");
}

function showLoggedInUI() {
  els.balanceBar.style.display = "";
  els.balanceAmount.textContent = formatIDR(state.balance);
  els.apiIdInput.disabled = true;
  els.apiKeyInput.disabled = true;
  els.loginBtn.style.display = "none";
}

function showLoggedOutUI() {
  els.balanceBar.style.display = "none";
  els.apiIdInput.disabled = false;
  els.apiKeyInput.disabled = false;
  els.apiIdInput.value = "";
  els.apiKeyInput.value = "";
  els.loginBtn.style.display = "";
}

async function refreshBalance() {
  try {
    const result = await proxyCall("profile", {});
    state.balance = result.data.balance || 0;
    els.balanceAmount.textContent = formatIDR(state.balance);
  } catch { /* silent */ }
}

/* ═══════════════════════════════════════════════════
   Check Prices — populate zone dropdown
   ═══════════════════════════════════════════════════ */

async function checkPrices() {
  const site = (els.siteInput.value || "").trim();
  if (!site) {
    showToast("Masukkan nama site/domain dulu", "error");
    return;
  }

  els.orderBtn.disabled = true;
  setStatus("Checking prices...", "loading");

  try {
    const result = await proxyCall("mail/prices", { site });
    const allPrices = result.data || [];

    // Filter: only hotmail.com & outlook.com
    const filtered = allPrices.filter(
      (p) => p.zone === "hotmail.com" || p.zone === "outlook.com"
    );

    if (!filtered.length) {
      showToast("Tidak ada zone hotmail/outlook tersedia", "error");
      setStatus("No zones", "");
      state.prices = [];
      updateZoneDropdown();
      return;
    }

    state.prices = filtered;
    updateZoneDropdown();
    els.orderBtn.disabled = false;
    setStatus(`${filtered.length} zones ready`, "ok");
  } catch (err) {
    showToast(err.message || "Gagal cek harga", "error");
    setStatus("Error", "error");
  }
}

function updateZoneDropdown() {
  els.zoneSelect.innerHTML = "";
  if (!state.prices.length) {
    els.zoneSelect.innerHTML = `<option value="">-- Cek harga dulu --</option>`;
    els.orderBtn.disabled = true;
    return;
  }
  state.prices.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.zone;
    opt.textContent = `${p.zone}  —  ${formatIDR(p.price)}  (stock: ${Number(p.stock).toLocaleString("id-ID")})`;
    els.zoneSelect.appendChild(opt);
  });
}

/* ═══════════════════════════════════════════════════
   Order Email (single + bulk)
   ═══════════════════════════════════════════════════ */

async function orderEmail(zone, site) {
  try {
    const result = await proxyCall("mail/order", { zone, site });
    const order = result.data;
    order.message = order.message || "";
    order.full_message = order.full_message || "";
    state.orders.unshift(order);
    saveOrders();
    renderOrders();
    startPolling(order.order_id);
    return order;
  } catch (err) {
    showToast(err.message || "Order gagal", "error");
    return null;
  }
}

async function doBulkOrder() {
  const site = (els.siteInput.value || "").trim();
  const zone = els.zoneSelect.value;
  const count = parseInt(els.bulkCount.value, 10) || 1;

  if (!site || !zone) {
    showToast("Pilih site dan zone dulu", "error");
    return;
  }
  if (count < 1 || count > 20) {
    showToast("Jumlah harus 1-20", "error");
    return;
  }

  els.orderBtn.disabled = true;
  els.orderBtn.textContent = "Ordering...";
  setStatus(`Ordering ${count} email(s)...`, "loading");

  let successCount = 0;
  for (let i = 0; i < count; i++) {
    const order = await orderEmail(zone, site);
    if (order) successCount++;
    // Small delay between orders to avoid rate limits
    if (i < count - 1) await new Promise(r => setTimeout(r, 1500));
  }

  await refreshBalance();
  els.orderBtn.disabled = false;
  els.orderBtn.textContent = "Order";

  if (successCount > 0) {
    setStatus(`${successCount} ordered`, "ok");
    showToast(`${successCount}/${count} email berhasil di-order!`, "success");
  } else {
    setStatus("Failed", "error");
  }
}

/* ═══════════════════════════════════════════════════
   Polling
   ═══════════════════════════════════════════════════ */

function startPolling(orderId) {
  if (state.pollTimers[orderId]) return;
  pollOrderStatus(orderId);
  state.pollTimers[orderId] = setInterval(() => pollOrderStatus(orderId), POLL_INTERVAL_MS);
  updateLiveIndicator();
}

function stopPolling(orderId) {
  if (state.pollTimers[orderId]) {
    clearInterval(state.pollTimers[orderId]);
    delete state.pollTimers[orderId];
  }
  updateLiveIndicator();
}

function updateLiveIndicator() {
  const hasActive = Object.keys(state.pollTimers).length > 0;
  if (els.ordersLiveIndicator) {
    els.ordersLiveIndicator.classList.toggle("active", hasActive);
  }
}

async function pollOrderStatus(orderId) {
  const order = state.orders.find((o) => o.order_id === orderId);
  if (!order) { stopPolling(orderId); return; }

  try {
    const result = await proxyCall("mail/getstatus", { order_id: orderId });
    const data = result.data;
    const prevMessage = order.message || "";
    const newMessage = data.message || "";

    order.email = data.email || order.email;
    order.message = newMessage;
    order.full_message = data.full_message || order.full_message;
    order.status = data.status || order.status;

    // Play sound if OTP just received
    if (!prevMessage && newMessage) {
      playNotificationSound();
      showToast(`OTP diterima untuk ${order.email}`, "success");
    }

    // Stop polling if terminal status
    if (order.status === "SUCCESS" || order.status === "CANCELED") {
      stopPolling(orderId);
    }

    saveOrders();
    renderOrders();
  } catch { /* keep polling on error */ }
}

/* ═══════════════════════════════════════════════════
   Copy All Emails / Clear Done
   ═══════════════════════════════════════════════════ */

function copyAllEmails() {
  const activeEmails = state.orders
    .filter((o) => o.status === "WAITING" || (o.status !== "CANCELED"))
    .map((o) => o.email)
    .filter(Boolean);
  if (!activeEmails.length) {
    showToast("Tidak ada email aktif", "error");
    return;
  }
  copyToClipboard(activeEmails.join("\n"), `${activeEmails.length} email di-copy!`);
}

function clearDoneOrders() {
  // Remove orders that already received OTP (message is not empty) from UI only
  const done = state.orders.filter((o) => o.message);
  if (!done.length) {
    showToast("Belum ada yang selesai", "error");
    return;
  }
  // Stop any polling for done orders
  done.forEach((o) => stopPolling(o.order_id));
  // Keep only orders that don't have OTP yet
  state.orders = state.orders.filter((o) => !o.message);
  saveOrders();
  renderOrders();
  showToast(`${done.length} order dihapus dari list`, "success");
}

/* ═══════════════════════════════════════════════════
   Render Orders
   ═══════════════════════════════════════════════════ */

function renderOrders() {
  if (!els.ordersContainer) return;

  // Update toolbar visibility
  const hasOrders = state.orders.length > 0;
  if (els.copyAllBtn) els.copyAllBtn.style.display = hasOrders ? "" : "none";
  if (els.clearDoneBtn) els.clearDoneBtn.style.display = hasOrders ? "" : "none";

  if (!hasOrders) {
    els.ordersContainer.innerHTML = `
      <div class="empty-state">
        <p>Belum ada order aktif. Order email di atas untuk mulai.</p>
      </div>`;
    return;
  }

  els.ordersContainer.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "orders-grid";

  state.orders.forEach((order) => {
    const card = createOrderCard(order);
    grid.appendChild(card);
  });

  els.ordersContainer.appendChild(grid);
}

function createOrderCard(order) {
  const card = document.createElement("div");

  let statusClass = "waiting";
  if (order.status === "SUCCESS" || order.message) statusClass = "success";
  else if (order.status === "CANCELED") statusClass = "canceled";

  card.className = `order-card ${statusClass}`;

  // Badge
  let badgeHTML = "";
  if (order.message) {
    badgeHTML = `<span class="order-badge success">✓ OTP RECEIVED</span>`;
  } else if (order.status === "WAITING") {
    badgeHTML = `<span class="order-badge waiting">WAITING<span class="waiting-dots"><span></span><span></span><span></span></span></span>`;
  } else if (order.status === "CANCELED") {
    badgeHTML = `<span class="order-badge canceled">✕ CANCELED</span>`;
  } else {
    badgeHTML = `<span class="order-badge">${escapeHtml(order.status)}</span>`;
  }

  // OTP area
  let otpHTML = "";
  if (order.message) {
    otpHTML = `
      <div class="otp-area">
        <div>
          <div class="otp-code">${escapeHtml(order.message)}</div>
          ${order.full_message ? `<div class="otp-full-msg">${escapeHtml(order.full_message)}</div>` : ""}
        </div>
        <button class="btn-copy-otp" data-copy="${escapeHtml(order.message)}">Copy OTP</button>
      </div>`;
  }

  // Time remaining
  const timeStr = order.expired_at ? formatTimeRemaining(order.expired_at) : "";

  // Meta info
  const metaParts = [];
  if (order.site) metaParts.push(order.site);
  if (order.zone) metaParts.push(order.zone);
  if (order.price != null) metaParts.push(formatIDR(order.price));
  if (timeStr) metaParts.push(timeStr);

  card.innerHTML = `
    <div class="order-card-header">
      <span class="order-email" title="Click to copy">${escapeHtml(order.email || "—")}</span>
      ${badgeHTML}
    </div>
    <div class="order-meta">${escapeHtml(metaParts.join("  ·  "))}</div>
    ${otpHTML}`;

  // Bind: copy email on click
  const emailEl = card.querySelector(".order-email");
  if (emailEl) {
    emailEl.addEventListener("click", () => copyToClipboard(order.email, "Email copied!"));
  }

  // Bind: copy OTP
  const copyOtpBtn = card.querySelector(".btn-copy-otp");
  if (copyOtpBtn) {
    copyOtpBtn.addEventListener("click", () => copyToClipboard(order.message, "OTP copied!"));
  }

  return card;
}

/* ═══════════════════════════════════════════════════
   Event Bindings
   ═══════════════════════════════════════════════════ */

function bindEvents() {
  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.orderBtn.addEventListener("click", doBulkOrder);
  els.copyAllBtn.addEventListener("click", copyAllEmails);
  els.clearDoneBtn.addEventListener("click", clearDoneOrders);

  // Enter key on login inputs
  els.apiIdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  els.apiKeyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

  // Auto check prices when site input loses focus or Enter
  els.siteInput.addEventListener("keydown", (e) => { if (e.key === "Enter") checkPrices(); });
  els.siteInput.addEventListener("change", () => { if (els.siteInput.value.trim()) checkPrices(); });
}

/* ═══════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════ */

async function init() {
  cacheDom();
  bindEvents();

  const creds = loadCreds();
  if (creds && creds.api_id && creds.api_key) {
    els.apiIdInput.value = creds.api_id;
    els.apiKeyInput.value = creds.api_key;
    state.apiId = creds.api_id;
    state.apiKey = creds.api_key;

    setStatus("Reconnecting...", "loading");
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "Logging in...";

    try {
      const result = await proxyCall("profile", {});
      state.loggedIn = true;
      state.balance = result.data.balance || 0;
      showLoggedInUI();
      els.orderPanel.style.display = "";

      state.orders = loadOrders();
      renderOrders();
      state.orders.forEach((o) => {
        if (o.status === "WAITING") startPolling(o.order_id);
      });
      setStatus("Connected", "ok");
    } catch {
      state.apiId = null;
      state.apiKey = null;
      clearCreds();
      showLoggedOutUI();
      setStatus("Ready", "");
      showToast("Session expired, silakan login ulang", "error");
    } finally {
      els.loginBtn.disabled = false;
      els.loginBtn.textContent = "Login";
    }
  } else {
    showLoggedOutUI();
    setStatus("Ready", "");
  }
  renderOrders();
}

document.addEventListener("DOMContentLoaded", init);
