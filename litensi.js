/* ═══════════════════════════════════════════════════
   Litensi Mail — Email Activation Frontend
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
const els = {
  statusIndicator: $(".status-indicator"),
  statusText:      $(".status-text"),
  apiIdInput:      $("#apiIdInput"),
  apiKeyInput:     $("#apiKeyInput"),
  loginBtn:        $("#loginBtn"),
  balanceBar:      $("#balanceBar"),
  balanceAmount:   $("#balanceAmount"),
  logoutBtn:       $("#logoutBtn"),
  loginPanel:      $("#loginPanel"),
  orderPanel:      $("#orderPanel"),
  siteInput:       $("#siteInput"),
  checkPricesBtn:  $("#checkPricesBtn"),
  priceTableContainer: $("#priceTableContainer"),
  ordersContainer: $("#ordersContainer"),
  ordersLiveIndicator: $("#ordersLiveIndicator"),
};

/* ═══════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════ */

function setStatus(text, type = "") {
  const dot = els.statusIndicator.querySelector(".status-dot");
  els.statusText.textContent = text;
  // Reset classes
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
  setTimeout(() => toast.remove(), 2200);
}

function formatIDR(num) {
  if (num == null || isNaN(num)) return "Rp 0";
  return "Rp " + Number(num).toLocaleString("id-ID");
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

function formatTimeRemaining(expiredAt) {
  if (!expiredAt) return "";
  const now = Date.now();
  const exp = new Date(expiredAt).getTime();
  const diff = exp - now;
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

/* ═══════════════════════════════════════════════════
   API Proxy
   ═══════════════════════════════════════════════════ */

async function proxyCall(endpoint, params = {}) {
  if (!state.apiId || !state.apiKey) {
    throw new Error("Belum login. Masukkan API credentials dulu.");
  }

  const body = {
    api_id: state.apiId,
    api_key: state.apiKey,
    endpoint,
    params,
  };

  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || data.data || res.statusText);
  }

  if (data.success === false) {
    throw new Error(data.data || "API error");
  }

  return data;
}

/* ═══════════════════════════════════════════════════
   LocalStorage
   ═══════════════════════════════════════════════════ */

function saveCreds() {
  localStorage.setItem(
    STORAGE_CREDS_KEY,
    JSON.stringify({ api_id: state.apiId, api_key: state.apiKey })
  );
}

function loadCreds() {
  try {
    const raw = localStorage.getItem(STORAGE_CREDS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearCreds() {
  localStorage.removeItem(STORAGE_CREDS_KEY);
}

function saveOrders() {
  localStorage.setItem(STORAGE_ORDERS_KEY, JSON.stringify(state.orders));
}

function loadOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_ORDERS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function clearOrders() {
  localStorage.removeItem(STORAGE_ORDERS_KEY);
}

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
  setStatus("Connecting...", "generating");

  // Temporarily set credentials for proxyCall
  state.apiId = apiId;
  state.apiKey = apiKey;

  try {
    const result = await proxyCall("profile", {});
    const profile = result.data;

    state.loggedIn = true;
    state.balance = profile.balance || 0;
    saveCreds();

    // Show balance bar, hide login inputs
    showLoggedInUI();

    // Restore saved orders
    state.orders = loadOrders();
    renderOrders();

    // Resume polling for WAITING orders
    state.orders.forEach((order) => {
      if (order.status === "WAITING") {
        startPolling(order.order_id);
      }
    });

    // Show order panel
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
  // Stop all polling
  Object.keys(state.pollTimers).forEach((id) => stopPolling(Number(id)));

  // Clear state
  state.apiId = null;
  state.apiKey = null;
  state.loggedIn = false;
  state.balance = 0;
  state.orders = [];
  state.prices = [];

  // Clear storage
  clearCreds();
  clearOrders();

  // Reset UI
  showLoggedOutUI();
  els.orderPanel.style.display = "none";
  els.priceTableContainer.innerHTML = "";
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
  } catch {
    // Silently fail, balance will update on next successful call
  }
}

/* ═══════════════════════════════════════════════════
   Prices
   ═══════════════════════════════════════════════════ */

async function checkPrices() {
  const site = (els.siteInput.value || "").trim();
  if (!site) {
    showToast("Masukkan nama site/domain dulu", "error");
    return;
  }

  els.checkPricesBtn.disabled = true;
  els.checkPricesBtn.textContent = "Loading...";
  setStatus("Checking prices...", "generating");

  try {
    const result = await proxyCall("mail/prices", { site });
    state.prices = result.data || [];

    if (!state.prices.length) {
      els.priceTableContainer.innerHTML = `
        <div class="empty-state">
          <p>Tidak ada zone tersedia untuk <strong>${escapeHtml(site)}</strong></p>
        </div>`;
      setStatus("No zones", "");
    } else {
      renderPriceTable(state.prices, site);
      setStatus(`${state.prices.length} zones found`, "ok");
    }
  } catch (err) {
    showToast(err.message || "Gagal cek harga", "error");
    setStatus("Error", "error");
    els.priceTableContainer.innerHTML = "";
  } finally {
    els.checkPricesBtn.disabled = false;
    els.checkPricesBtn.textContent = "Cek Harga";
  }
}

function renderPriceTable(prices, site) {
  const table = document.createElement("div");
  table.className = "price-table";

  // Header
  table.innerHTML = `
    <div class="price-table-header">
      <span>Zone</span>
      <span>Harga</span>
      <span>Stock</span>
      <span>Action</span>
    </div>`;

  // Rows
  prices.forEach((item) => {
    const row = document.createElement("div");
    row.className = "price-table-row";
    row.innerHTML = `
      <span class="price-zone">${escapeHtml(item.zone)}</span>
      <span class="price-amount">${formatIDR(item.price)}</span>
      <span class="price-stock">${Number(item.stock).toLocaleString("id-ID")}</span>
      <span class="price-action">
        <button class="btn btn-sm btn-primary order-btn" data-zone="${escapeHtml(item.zone)}" data-site="${escapeHtml(site)}">Order</button>
      </span>`;

    row.querySelector(".order-btn").addEventListener("click", () => {
      orderEmail(item.zone, site);
    });

    table.appendChild(row);
  });

  els.priceTableContainer.innerHTML = "";
  els.priceTableContainer.appendChild(table);
}

/* ═══════════════════════════════════════════════════
   Order Email
   ═══════════════════════════════════════════════════ */

async function orderEmail(zone, site) {
  setStatus("Ordering...", "generating");

  try {
    const result = await proxyCall("mail/order", { zone, site });
    const order = result.data;

    // Ensure fields exist
    order.message = order.message || "";
    order.full_message = order.full_message || "";

    // Add to state
    state.orders.unshift(order);
    saveOrders();
    renderOrders();

    // Start polling for this order
    startPolling(order.order_id);

    // Refresh balance after purchase
    await refreshBalance();

    setStatus("Order placed", "ok");
    showToast(`Email ordered: ${order.email}`, "success");
  } catch (err) {
    showToast(err.message || "Order gagal", "error");
    setStatus("Error", "error");
  }
}

/* ═══════════════════════════════════════════════════
   Polling
   ═══════════════════════════════════════════════════ */

function startPolling(orderId) {
  // Don't double-poll
  if (state.pollTimers[orderId]) return;

  // Immediate first check
  pollOrderStatus(orderId);

  // Then every 6 seconds
  state.pollTimers[orderId] = setInterval(() => {
    pollOrderStatus(orderId);
  }, POLL_INTERVAL_MS);

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
  els.ordersLiveIndicator.classList.toggle("active", hasActive);
}

async function pollOrderStatus(orderId) {
  const order = state.orders.find((o) => o.order_id === orderId);
  if (!order) {
    stopPolling(orderId);
    return;
  }

  try {
    const result = await proxyCall("mail/getstatus", { order_id: orderId });
    const data = result.data;

    const prevMessage = order.message || "";
    const newMessage = data.message || "";

    // Update order data
    order.email = data.email || order.email;
    order.message = newMessage;
    order.full_message = data.full_message || order.full_message;
    order.status = data.status || order.status;

    // Play sound if OTP just received (message went from empty to non-empty)
    if (!prevMessage && newMessage) {
      playNotificationSound();
      showToast(`OTP diterima: ${newMessage}`, "success");
    }

    // Stop polling if terminal status
    if (order.status === "SUCCESS" || order.status === "CANCELED") {
      stopPolling(orderId);
    }

    saveOrders();
    renderOrders();
  } catch {
    // Keep polling on error, don't stop
  }
}

/* ═══════════════════════════════════════════════════
   Set Order Status
   ═══════════════════════════════════════════════════ */

async function setOrderStatus(orderId, status) {
  const order = state.orders.find((o) => o.order_id === orderId);
  if (!order) return;

  try {
    setStatus(`Setting ${status}...`, "generating");

    const result = await proxyCall("mail/setstatus", { order_id: orderId, status });
    const data = result.data;

    // Update order
    order.status = data.status || status;
    order.email = data.email || order.email;

    // Stop polling on terminal status
    if (order.status === "SUCCESS" || order.status === "CANCELED") {
      stopPolling(orderId);
    }

    // If set to RESEND, restart polling
    if (status === "RESEND") {
      order.message = "";
      order.full_message = "";
      startPolling(orderId);
    }

    saveOrders();
    renderOrders();

    // Refresh balance on SUCCESS
    if (status === "SUCCESS") {
      await refreshBalance();
    }

    setStatus("Updated", "ok");
    showToast(`Order #${orderId} → ${status}`, "success");
  } catch (err) {
    showToast(err.message || "Gagal update status", "error");
    setStatus("Error", "error");
  }
}

/* ═══════════════════════════════════════════════════
   Reorder
   ═══════════════════════════════════════════════════ */

async function reorderEmail(site, email) {
  setStatus("Reordering...", "generating");

  try {
    const result = await proxyCall("mail/reorder", { site, email });
    const order = result.data;

    order.message = order.message || "";
    order.full_message = order.full_message || "";
    order.status = order.status || "WAITING";
    order.site = site;

    state.orders.unshift(order);
    saveOrders();
    renderOrders();

    startPolling(order.order_id);
    await refreshBalance();

    setStatus("Reordered", "ok");
    showToast(`Reorder berhasil: ${order.email}`, "success");
  } catch (err) {
    showToast(err.message || "Reorder gagal", "error");
    setStatus("Error", "error");
  }
}

/* ═══════════════════════════════════════════════════
   Render Orders
   ═══════════════════════════════════════════════════ */

function renderOrders() {
  if (!state.orders.length) {
    els.ordersContainer.innerHTML = `
      <div class="empty-state">
        <p>Belum ada order aktif. Order email di atas untuk mulai.</p>
      </div>`;
    return;
  }

  els.ordersContainer.innerHTML = "";

  state.orders.forEach((order) => {
    const card = createOrderCard(order);
    els.ordersContainer.appendChild(card);
  });
}

function createOrderCard(order) {
  const card = document.createElement("div");

  // Status class
  let statusClass = "waiting";
  if (order.status === "SUCCESS") statusClass = "success";
  else if (order.status === "CANCELED") statusClass = "canceled";

  card.className = `order-card ${statusClass}`;

  // Badge text
  let badgeHTML = "";
  if (order.status === "WAITING") {
    badgeHTML = `<span class="order-badge waiting"><span class="pulse-dot"></span> WAITING</span>`;
  } else if (order.status === "SUCCESS") {
    badgeHTML = `<span class="order-badge success">✓ SUCCESS</span>`;
  } else if (order.status === "CANCELED") {
    badgeHTML = `<span class="order-badge canceled">✕ CANCELED</span>`;
  } else {
    badgeHTML = `<span class="order-badge">${escapeHtml(order.status)}</span>`;
  }

  // OTP area
  let otpHTML = "";
  if (order.message) {
    otpHTML = `
      <div class="order-otp">
        <div class="otp-label">VERIFICATION CODE</div>
        <div class="otp-code-row">
          <span class="otp-code">${escapeHtml(order.message)}</span>
          <button class="btn btn-sm btn-copy-otp" data-copy-otp="${escapeHtml(order.message)}">Copy</button>
        </div>
        ${order.full_message ? `<div class="otp-full">${escapeHtml(order.full_message)}</div>` : ""}
      </div>`;
  }

  // Action buttons
  let actionsHTML = "";
  const actions = [];

  if (order.status === "WAITING") {
    actions.push(`<button class="btn btn-sm btn-danger btn-cancel" data-order-id="${order.order_id}">Cancel</button>`);
  }

  if (order.message && order.status !== "SUCCESS" && order.status !== "CANCELED") {
    actions.push(`<button class="btn btn-sm btn-success btn-set-success" data-order-id="${order.order_id}">✓ Success</button>`);
    actions.push(`<button class="btn btn-sm btn-ghost btn-resend" data-order-id="${order.order_id}">↻ Resend</button>`);
  }

  if (order.status === "SUCCESS" || order.status === "CANCELED") {
    actions.push(`<button class="btn btn-sm btn-ghost btn-reorder" data-site="${escapeHtml(order.site || "")}" data-email="${escapeHtml(order.email || "")}">🔄 Reorder</button>`);
    actions.push(`<button class="btn btn-sm btn-ghost btn-remove" data-order-id="${order.order_id}">🗑 Remove</button>`);
  }

  if (actions.length) {
    actionsHTML = `<div class="order-actions">${actions.join("")}</div>`;
  }

  // Time remaining
  const timeStr = order.expired_at ? formatTimeRemaining(order.expired_at) : "";
  const timeHTML = timeStr ? `<span class="order-time" title="${escapeHtml(order.expired_at)}">${escapeHtml(timeStr)}</span>` : "";

  card.innerHTML = `
    <div class="order-card-header">
      <div class="order-email-row">
        <span class="order-email" title="Click to copy">${escapeHtml(order.email || "—")}</span>
        ${badgeHTML}
      </div>
      <div class="order-meta">
        <span class="order-site">${escapeHtml(order.site || "")}</span>
        <span class="order-zone">${escapeHtml(order.zone || "")}</span>
        ${order.price != null ? `<span class="order-price">${formatIDR(order.price)}</span>` : ""}
        ${timeHTML}
      </div>
    </div>
    ${otpHTML}
    ${actionsHTML}`;

  // Bind events
  // Copy email on click
  const emailEl = card.querySelector(".order-email");
  if (emailEl) {
    emailEl.addEventListener("click", () => {
      copyToClipboard(order.email, "Email copied!");
    });
  }

  // Copy OTP
  const copyOtpBtn = card.querySelector(".btn-copy-otp");
  if (copyOtpBtn) {
    copyOtpBtn.addEventListener("click", () => {
      copyToClipboard(order.message, "OTP copied!");
    });
  }

  // Cancel
  const cancelBtn = card.querySelector(".btn-cancel");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", () => {
      setOrderStatus(order.order_id, "CANCELED");
    });
  }

  // Success
  const successBtn = card.querySelector(".btn-set-success");
  if (successBtn) {
    successBtn.addEventListener("click", () => {
      setOrderStatus(order.order_id, "SUCCESS");
    });
  }

  // Resend
  const resendBtn = card.querySelector(".btn-resend");
  if (resendBtn) {
    resendBtn.addEventListener("click", () => {
      setOrderStatus(order.order_id, "RESEND");
    });
  }

  // Reorder
  const reorderBtn = card.querySelector(".btn-reorder");
  if (reorderBtn) {
    reorderBtn.addEventListener("click", () => {
      const site = reorderBtn.dataset.site;
      const email = reorderBtn.dataset.email;
      if (site && email) reorderEmail(site, email);
    });
  }

  // Remove from list
  const removeBtn = card.querySelector(".btn-remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      removeOrder(order.order_id);
    });
  }

  return card;
}

function removeOrder(orderId) {
  stopPolling(orderId);
  state.orders = state.orders.filter((o) => o.order_id !== orderId);
  saveOrders();
  renderOrders();
  showToast("Order dihapus dari list", "success");
}

/* ═══════════════════════════════════════════════════
   Event Bindings
   ═══════════════════════════════════════════════════ */

function bindEvents() {
  els.loginBtn.addEventListener("click", login);
  els.logoutBtn.addEventListener("click", logout);
  els.checkPricesBtn.addEventListener("click", checkPrices);

  // Enter key on inputs
  els.apiIdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  els.apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  els.siteInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkPrices();
  });
}

/* ═══════════════════════════════════════════════════
   Init
   ═══════════════════════════════════════════════════ */

async function init() {
  bindEvents();

  // Check for saved credentials
  const creds = loadCreds();
  if (creds && creds.api_id && creds.api_key) {
    // Populate inputs and attempt auto-login
    els.apiIdInput.value = creds.api_id;
    els.apiKeyInput.value = creds.api_key;

    state.apiId = creds.api_id;
    state.apiKey = creds.api_key;

    setStatus("Reconnecting...", "generating");
    els.loginBtn.disabled = true;
    els.loginBtn.textContent = "Logging in...";

    try {
      const result = await proxyCall("profile", {});
      const profile = result.data;

      state.loggedIn = true;
      state.balance = profile.balance || 0;

      showLoggedInUI();
      els.orderPanel.style.display = "";

      // Restore saved orders
      state.orders = loadOrders();
      renderOrders();

      // Resume polling for WAITING orders
      state.orders.forEach((order) => {
        if (order.status === "WAITING") {
          startPolling(order.order_id);
        }
      });

      setStatus("Connected", "ok");
    } catch {
      // Saved credentials are invalid
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
    // No saved credentials, show login form
    showLoggedOutUI();
    setStatus("Ready", "");
  }

  renderOrders();
}

init();
