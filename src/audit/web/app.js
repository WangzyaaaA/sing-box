"use strict";

const state = {
  token: sessionStorage.getItem("auditToken") || "", range: "24h", customStart: "", customEnd: "",
  page: 1, pages: 1, usagePage: 1, usagePages: 1, configUsagePage: 1, configUsagePages: 1, timer: null,
};
const $ = (id) => document.getElementById(id);
const rangeLabels = { "1h": "最近 1 小时", "6h": "最近 6 小时", "24h": "最近 24 小时", "7d": "最近 7 天", "30d": "最近 30 天", all: "全部时间" };

function formatBytes(value, suffix = "") {
  let n = Number(value) || 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  while (Math.abs(n) >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
  const digits = unit === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${units[unit]}${suffix}`;
}

function formatTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}

function localInputValue(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function timeParams() {
  const params = new URLSearchParams({ range: state.range === "custom" ? "24h" : state.range });
  if (state.range === "custom" && state.customStart && state.customEnd) {
    params.set("start", new Date(state.customStart).toISOString());
    params.set("end", new Date(state.customEnd).toISOString());
  }
  return params;
}

function timeLabel() {
  if (state.range !== "custom") return rangeLabels[state.range];
  return `${formatTime(state.customStart)} 至 ${formatTime(state.customEnd)}`;
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value == null ? "" : String(value);
  return node.innerHTML;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  if (response.status === 401) {
    sessionStorage.removeItem("auditToken");
    showTokenDialog();
    throw new Error("访问令牌无效");
  }
  if (!response.ok) throw new Error(`请求失败 (${response.status})`);
  return response.json();
}

function showTokenDialog(message = "") {
  $("tokenError").textContent = message;
  const dialog = $("tokenDialog");
  if (!dialog.open) dialog.showModal();
}

function startRefreshTimer() {
  if (state.timer) window.clearInterval(state.timer);
  state.timer = window.setInterval(() => loadDashboard(), 5000);
}

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 2200);
}

function setHealth(collector) {
  const element = $("health");
  const label = element.querySelector("span");
  element.className = `health ${collector.connected ? "ok" : "error"}`;
  label.textContent = collector.connected ? "采集正常" : "采集异常";
  element.title = collector.connected ? `每 ${collector.interval} 秒采集` : (collector.last_error || "无法连接 sing-box API");
}

function renderSummary(data) {
  $("totalTraffic").textContent = formatBytes(data.total);
  $("downloadTraffic").textContent = formatBytes(data.download);
  $("uploadTraffic").textContent = formatBytes(data.upload);
  $("activeConnections").textContent = new Intl.NumberFormat("zh-CN").format(data.active_connections);
  $("allConnections").textContent = new Intl.NumberFormat("zh-CN").format(data.connections);
  $("downRate").textContent = formatBytes(data.download_speed, "/s");
  $("upRate").textContent = formatBytes(data.upload_speed, "/s");
  $("liveRate").textContent = formatBytes(data.upload_speed + data.download_speed, "/s");
  $("rangeCopy").textContent = timeLabel();
  setHealth(data.collector);
}

function drawChart(points) {
  const canvas = $("trafficChart");
  const empty = $("emptyChart");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height, pad = { top: 12, right: 12, bottom: 25, left: 48 };
  ctx.clearRect(0, 0, width, height);
  if (!points.length || !points.some((point) => point.upload || point.download)) { empty.hidden = false; return; }
  empty.hidden = true;
  const max = Math.max(...points.flatMap((point) => [point.upload, point.download]), 1);
  const x = (index) => pad.left + index * (width - pad.left - pad.right) / Math.max(1, points.length - 1);
  const y = (value) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "#858588";
  ctx.strokeStyle = "rgba(29,29,31,.1)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + i * (height - pad.top - pad.bottom) / 4;
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(width - pad.right, gy); ctx.stroke();
    ctx.fillText(formatBytes(max * (4 - i) / 4), 2, gy + 3);
  }
  const series = [{ key: "download", color: "#708795" }, { key: "upload", color: "#66816f" }];
  series.forEach(({ key, color }) => {
    ctx.beginPath();
    points.forEach((point, index) => { const px = x(index), py = y(point[key]); index ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  });
  const labelCount = Math.min(5, points.length);
  for (let i = 0; i < labelCount; i += 1) {
    const index = Math.round(i * (points.length - 1) / Math.max(1, labelCount - 1));
    const date = new Date(points[index].ts * 1000);
    const label = state.range === "1h" || state.range === "6h" || state.range === "24h"
      ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
      : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
    ctx.fillStyle = "#858588"; ctx.textAlign = i === 0 ? "left" : i === labelCount - 1 ? "right" : "center";
    ctx.fillText(label, x(index), height - 4);
  }
}

function renderDestinations(items) {
  const list = $("destinations");
  if (!items.length) { list.innerHTML = '<li class="placeholder">暂无目标记录</li>'; return; }
  list.innerHTML = items.map((item, index) => `<li><span class="rank">${String(index + 1).padStart(2, "0")}</span><span class="destination-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span><span class="destination-value">${formatBytes(item.upload + item.download)}</span></li>`).join("");
}

function renderConnections(data) {
  state.pages = data.pages;
  state.page = data.page;
  $("pageInfo").textContent = `第 ${data.page} / ${data.pages} 页 · ${data.total} 条`;
  $("prevPage").disabled = data.page <= 1;
  $("nextPage").disabled = data.page >= data.pages;
  const body = $("connectionRows");
  if (!data.items.length) { body.innerHTML = '<tr><td colspan="9" class="empty-row">当前筛选条件下没有审计记录</td></tr>'; return; }
  body.innerHTML = data.items.map((item) => {
    const target = item.host || item.destination || item.destination_ip || "—";
    const source = `${item.source_ip || "—"}${item.source_port ? `:${item.source_port}` : ""}`;
    const user = item.user || item.config_name || "匿名";
    const config = item.config_name || item.inbound || "—";
    const route = item.chains && item.chains.length ? item.chains.join(" → ") : (item.outbound || "—");
    return `<tr><td>${formatTime(item.start)}</td><td title="${escapeHtml(source)}">${escapeHtml(source)}</td><td title="${escapeHtml(target)}">${escapeHtml(target)}<small>${item.destination_port ? `端口 ${item.destination_port}` : ""}</small></td><td title="${escapeHtml(user)}">${escapeHtml(user)}<small>${escapeHtml(config)}</small></td><td>${escapeHtml(item.protocol || item.network || "—")}</td><td title="${escapeHtml(route)}">${escapeHtml(route)}</td><td class="number up">${formatBytes(item.upload)}</td><td class="number down">${formatBytes(item.download)}</td><td><span class="status-pill ${item.status}">${item.status === "active" ? "活动" : "已结束"}</span></td></tr>`;
  }).join("");
}

function renderUsage(data) {
  state.usagePages = data.pages;
  state.usagePage = data.page;
  $("usagePageInfo").textContent = `第 ${data.page} / ${data.pages} 页 · ${data.total} 组`;
  $("usagePrevPage").disabled = data.page <= 1;
  $("usageNextPage").disabled = data.page >= data.pages;
  const body = $("usageRows");
  if (!data.items.length) { body.innerHTML = '<tr><td colspan="9" class="empty-row">当前时间段没有可归属的 IP 流量</td></tr>'; return; }
  body.innerHTML = data.items.map((item) => `<tr><td>${escapeHtml(item.source_ip || "未知")}</td><td title="${escapeHtml(item.config_name)}">${escapeHtml(item.config_name || "未识别")}</td><td title="${escapeHtml(item.user)}">${escapeHtml(item.user || "—")}</td><td>${formatTime(item.first_seen_at)}</td><td>${formatTime(item.last_seen_at)}</td><td class="number">${new Intl.NumberFormat("zh-CN").format(item.connections)}</td><td class="number up">${formatBytes(item.upload)}</td><td class="number down">${formatBytes(item.download)}</td><td class="number total-value">${formatBytes(item.total)}</td></tr>`).join("");
}

function renderConfigUsage(data) {
  state.configUsagePages = data.pages;
  state.configUsagePage = data.page;
  $("configUsagePageInfo").textContent = `第 ${data.page} / ${data.pages} 页 · ${data.total} 个配置`;
  $("configUsagePrevPage").disabled = data.page <= 1;
  $("configUsageNextPage").disabled = data.page >= data.pages;
  const body = $("configUsageRows");
  if (!data.items.length) { body.innerHTML = '<tr><td colspan="9" class="empty-row">当前时间段没有可归属的配置流量</td></tr>'; return; }
  body.innerHTML = data.items.map((item) => `<tr><td title="${escapeHtml(item.config_name)}">${escapeHtml(item.config_name || "未识别")}</td><td>${formatTime(item.first_seen_at)}</td><td>${formatTime(item.last_seen_at)}</td><td class="number">${new Intl.NumberFormat("zh-CN").format(item.clients)}</td><td class="number">${new Intl.NumberFormat("zh-CN").format(item.users)}</td><td class="number">${new Intl.NumberFormat("zh-CN").format(item.connections)}</td><td class="number up">${formatBytes(item.upload)}</td><td class="number down">${formatBytes(item.download)}</td><td class="number total-value">${formatBytes(item.total)}</td></tr>`).join("");
}

async function loadOptions() {
  const data = await api(`/api/options?${timeParams()}`);
  const select = $("protocol"), selected = select.value;
  select.innerHTML = '<option value="">全部协议</option>' + data.protocols.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  select.value = selected;
}

function connectionQuery() {
  const params = timeParams();
  params.set("page", String(state.page)); params.set("limit", "50");
  if ($("search").value.trim()) params.set("search", $("search").value.trim());
  if ($("protocol").value) params.set("protocol", $("protocol").value);
  if ($("status").value) params.set("status", $("status").value);
  return params;
}

function usageQuery() {
  const params = timeParams();
  params.set("page", String(state.usagePage)); params.set("limit", "50");
  if ($("usageSearch").value.trim()) params.set("search", $("usageSearch").value.trim());
  return params;
}

function configUsageQuery() {
  const params = timeParams();
  params.set("page", String(state.configUsagePage)); params.set("limit", "50");
  if ($("configUsageSearch").value.trim()) params.set("config_search", $("configUsageSearch").value.trim());
  return params;
}

async function loadConnections() {
  renderConnections(await api(`/api/connections?${connectionQuery()}`));
}

async function loadUsage() {
  renderUsage(await api(`/api/client-usage?${usageQuery()}`));
}

async function loadConfigUsage() {
  renderConfigUsage(await api(`/api/config-usage?${configUsageQuery()}`));
}

async function loadDashboard(showNotice = false) {
  try {
    const query = timeParams();
    const [summary, series, destinations] = await Promise.all([
      api(`/api/summary?${query}`), api(`/api/timeseries?${query}`), api(`/api/top-destinations?${query}`),
    ]);
    renderSummary(summary); drawChart(series.points); renderDestinations(destinations.items);
    await Promise.all([loadConfigUsage(), loadUsage(), loadConnections(), loadOptions()]);
    if (showNotice) toast("数据已刷新");
  } catch (error) {
    if (error.message !== "访问令牌无效") { $("health").className = "health error"; $("health").querySelector("span").textContent = "服务异常"; toast(error.message); }
  }
}

function downloadConnections(format) {
  const params = connectionQuery(); params.delete("page"); params.delete("limit"); params.set("format", format);
  fetch(`/api/export?${params}`, { headers: { Authorization: `Bearer ${state.token}` } })
    .then((response) => { if (!response.ok) throw new Error("导出失败"); const disposition = response.headers.get("Content-Disposition") || ""; const name = disposition.match(/filename="([^"]+)"/)?.[1] || `sing-box-audit.${format}`; return Promise.all([response.blob(), name]); })
    .then(([blob, name]) => { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); toast(`已导出 ${format.toUpperCase()}`); })
    .catch((error) => toast(error.message));
}

function downloadUsage(format) {
  const params = usageQuery(); params.delete("page"); params.delete("limit"); params.set("format", format);
  fetch(`/api/usage-export?${params}`, { headers: { Authorization: `Bearer ${state.token}` } })
    .then((response) => { if (!response.ok) throw new Error("导出失败"); const disposition = response.headers.get("Content-Disposition") || ""; const name = disposition.match(/filename="([^"]+)"/)?.[1] || `sing-box-audit-usage.${format}`; return Promise.all([response.blob(), name]); })
    .then(([blob, name]) => { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); toast(`已导出 IP / 配置用量 ${format.toUpperCase()}`); })
    .catch((error) => toast(error.message));
}

function downloadConfigUsage(format) {
  const params = configUsageQuery(); params.delete("page"); params.delete("limit"); params.set("format", format);
  fetch(`/api/config-usage-export?${params}`, { headers: { Authorization: `Bearer ${state.token}` } })
    .then((response) => { if (!response.ok) throw new Error("导出失败"); const disposition = response.headers.get("Content-Disposition") || ""; const name = disposition.match(/filename="([^"]+)"/)?.[1] || `sing-box-audit-config-usage.${format}`; return Promise.all([response.blob(), name]); })
    .then(([blob, name]) => { const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url); toast(`已导出配置文件用量 ${format.toUpperCase()}`); })
    .catch((error) => toast(error.message));
}

let searchTimer;
let usageSearchTimer;
let configUsageSearchTimer;
$("range").addEventListener("change", () => {
  state.range = $("range").value; state.page = 1; state.usagePage = 1; state.configUsagePage = 1;
  $("customRange").hidden = state.range !== "custom";
  if (state.range !== "custom") loadDashboard();
});
$("applyRange").addEventListener("click", () => {
  const start = $("rangeStart").value, end = $("rangeEnd").value;
  if (!start || !end || new Date(start) > new Date(end)) { toast("请选择有效的开始和结束时间"); return; }
  state.customStart = start; state.customEnd = end; state.page = 1; state.usagePage = 1; state.configUsagePage = 1; loadDashboard(true);
});
$("refresh").addEventListener("click", () => loadDashboard(true));
$("protocol").addEventListener("change", () => { state.page = 1; loadConnections(); });
$("status").addEventListener("change", () => { state.page = 1; loadConnections(); });
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.page = 1; loadConnections(); }, 280); });
$("usageSearch").addEventListener("input", () => { clearTimeout(usageSearchTimer); usageSearchTimer = setTimeout(() => { state.usagePage = 1; loadUsage(); }, 280); });
$("configUsageSearch").addEventListener("input", () => { clearTimeout(configUsageSearchTimer); configUsageSearchTimer = setTimeout(() => { state.configUsagePage = 1; loadConfigUsage(); }, 280); });
$("prevPage").addEventListener("click", () => { if (state.page > 1) { state.page -= 1; loadConnections(); } });
$("nextPage").addEventListener("click", () => { if (state.page < state.pages) { state.page += 1; loadConnections(); } });
$("usagePrevPage").addEventListener("click", () => { if (state.usagePage > 1) { state.usagePage -= 1; loadUsage(); } });
$("usageNextPage").addEventListener("click", () => { if (state.usagePage < state.usagePages) { state.usagePage += 1; loadUsage(); } });
$("configUsagePrevPage").addEventListener("click", () => { if (state.configUsagePage > 1) { state.configUsagePage -= 1; loadConfigUsage(); } });
$("configUsageNextPage").addEventListener("click", () => { if (state.configUsagePage < state.configUsagePages) { state.configUsagePage += 1; loadConfigUsage(); } });
$("exportCsv").addEventListener("click", () => downloadConnections("csv"));
$("usageExportCsv").addEventListener("click", () => downloadUsage("csv"));
$("usageExportJson").addEventListener("click", () => downloadUsage("json"));
$("configUsageExportCsv").addEventListener("click", () => downloadConfigUsage("csv"));
$("configUsageExportJson").addEventListener("click", () => downloadConfigUsage("json"));
$("exportJson").addEventListener("click", () => downloadConnections("json"));
$("tokenForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("tokenInput").value.trim();
  try {
    const response = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (!response.ok) throw new Error("访问令牌无效，请重新输入");
    state.token = token; sessionStorage.setItem("auditToken", token); $("tokenDialog").close(); $("tokenError").textContent = ""; loadDashboard(); startRefreshTimer();
  } catch (error) { $("tokenError").textContent = error.message; }
});
window.addEventListener("resize", () => { clearTimeout(window.__chartResize); window.__chartResize = setTimeout(() => api(`/api/timeseries?${timeParams()}`).then((data) => drawChart(data.points)).catch(() => {}), 120); });

async function boot() {
  try {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    $("rangeStart").value = localInputValue(yesterday); $("rangeEnd").value = localInputValue(now);
    state.customStart = $("rangeStart").value; state.customEnd = $("rangeEnd").value;
    const health = await fetch("/api/health", { cache: "no-store" }).then((response) => response.json());
    if (health.auth_required && !state.token) { showTokenDialog(); return; }
    await loadDashboard();
    startRefreshTimer();
  } catch (error) { toast("无法连接审计服务"); }
}
boot();
