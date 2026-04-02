const currentWattsEl = document.getElementById("currentWatts");
const lastUpdatedEl = document.getElementById("lastUpdated");
const statusEl = document.getElementById("status");
const todayKwhEl = document.getElementById("todayKwh");
const todayValueEl = document.getElementById("todayValue");
const acWattsEl = document.getElementById("acWatts");
const chartEl = document.getElementById("historyChart");
const rangePresetEl = document.getElementById("rangePreset");

const MAX_SOLAR_WATTS = 91;

let chart;
let currentTheme = null;
let allHistoryPoints = [];

function formatTimestamp(ms) {
  return new Date(ms).toLocaleString();
}

function renderCurrent(reading) {
  if (!reading) return;
  currentWattsEl.textContent = `${reading.watts.toFixed(0)} W`;
  if (Number.isFinite(Number(reading.acWatts))) {
    acWattsEl.textContent = `${Number(reading.acWatts).toFixed(0)} W`;
  } else if (reading.acError) {
    acWattsEl.textContent = `Unavailable (${reading.acError})`;
  } else {
    acWattsEl.textContent = "-- W";
  }
  lastUpdatedEl.textContent = `Last updated: ${formatTimestamp(reading.timestamp)}`;
  statusEl.textContent = reading.error ? `Warning: ${reading.error}` : "Connected";
  statusEl.className = reading.error ? "status warning" : "status ok";
}

function renderTodaySummary(todaySummary) {
  if (!todaySummary) {
    todayKwhEl.textContent = "-- kWh";
    todayValueEl.textContent = "--";
    return;
  }
  todayKwhEl.textContent = `${todaySummary.kwh.toFixed(3)} kWh`;
  todayValueEl.textContent = `$${todaySummary.costUsd.toFixed(2)} @ $${todaySummary.rateUsdPerKwh.toFixed(2)}/kWh`;
}

function applySolarBackground(reading) {
  const currentWatts = Number(reading?.watts ?? 0);
  const ratio = Math.max(0, Math.min(1, currentWatts / MAX_SOLAR_WATTS));
  const blend = 1 - ratio;
  const surfaceBlend = Math.pow(blend, 0.8);
  const textBlend = Math.pow(blend, 0.5);

  function lerpColor(bright, dark, t = surfaceBlend) {
    const r = Math.round(bright[0] + (dark[0] - bright[0]) * t);
    const g = Math.round(bright[1] + (dark[1] - bright[1]) * t);
    const b = Math.round(bright[2] + (dark[2] - bright[2]) * t);
    return `${r}, ${g}, ${b}`;
  }

  currentTheme = {
    text: lerpColor([31, 26, 20], [236, 242, 248], textBlend),
    bg: lerpColor([243, 238, 224], [13, 17, 23]),
    bannerBg: lerpColor([61, 45, 31], [7, 10, 15]),
    bannerText: lerpColor([247, 239, 224], [232, 239, 247], textBlend),
    subtle: lerpColor([79, 65, 50], [162, 176, 193], textBlend),
    muted: lerpColor([125, 102, 76], [132, 147, 166], textBlend),
    cardBg: lerpColor([255, 249, 235], [23, 29, 38]),
    cardBorder: lerpColor([204, 187, 159], [52, 64, 79]),
    shadow: lerpColor([30, 20, 10], [2, 4, 7]),
    accent: lerpColor([188, 109, 29], [255, 193, 94]),
    ok: lerpColor([46, 114, 70], [92, 220, 149]),
    warning: lerpColor([158, 63, 31], [255, 148, 112]),
    grain: lerpColor([60, 45, 30], [235, 242, 252]),
    grainOpacity: (0.38 - surfaceBlend * 0.18).toFixed(3)
  };

  document.body.style.setProperty("--solar-text-rgb", currentTheme.text);
  document.body.style.setProperty("--solar-bg-rgb", currentTheme.bg);
  document.body.style.setProperty("--solar-banner-bg-rgb", currentTheme.bannerBg);
  document.body.style.setProperty("--solar-banner-text-rgb", currentTheme.bannerText);
  document.body.style.setProperty("--solar-subtle-rgb", currentTheme.subtle);
  document.body.style.setProperty("--solar-muted-rgb", currentTheme.muted);
  document.body.style.setProperty("--solar-card-bg-rgb", currentTheme.cardBg);
  document.body.style.setProperty("--solar-card-border-rgb", currentTheme.cardBorder);
  document.body.style.setProperty("--solar-shadow-rgb", currentTheme.shadow);
  document.body.style.setProperty("--solar-accent-rgb", currentTheme.accent);
  document.body.style.setProperty("--solar-ok-rgb", currentTheme.ok);
  document.body.style.setProperty("--solar-warning-rgb", currentTheme.warning);
  document.body.style.setProperty("--solar-grain-rgb", currentTheme.grain);
  document.body.style.setProperty("--solar-grain-opacity", currentTheme.grainOpacity);
}

function filterPointsByPreset(points, preset) {
  if (preset === "all") return points;
  const latestTs = points[points.length - 1]?.timestamp ?? Date.now();
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  let windowMs = day;
  if (preset === "1h") windowMs = hour;
  if (preset === "6h") windowMs = 6 * hour;
  if (preset === "24h") windowMs = day;
  if (preset === "7d") windowMs = 7 * day;
  const start = latestTs - windowMs;
  return points.filter((p) => p.timestamp >= start && p.timestamp <= latestTs);
}

function buildChartOption(points) {
  const filtered = filterPointsByPreset(points, rangePresetEl.value);
  const hasAcSeries = filtered.some((p) => Number.isFinite(Number(p.acWatts)));
  const textColor = currentTheme ? `rgb(${currentTheme.text})` : "#2c2218";
  const subtleColor = currentTheme ? `rgb(${currentTheme.subtle})` : "#4f4132";
  const gridColor = currentTheme ? `rgba(${currentTheme.subtle}, 0.2)` : "rgba(89, 70, 48, 0.16)";
  const accentColor = currentTheme ? `rgb(${currentTheme.accent})` : "#bc6d1d";
  const acColor = currentTheme ? `rgb(${currentTheme.subtle})` : "#5a6b7d";

  const series = [
    {
      name: "Solar input (W)",
      type: "line",
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: accentColor },
      data: filtered.map((p) => [p.timestamp, p.watts])
    }
  ];

  if (hasAcSeries) {
    series.push({
      name: "EcoFlow AC output (W)",
      type: "line",
      smooth: true,
      showSymbol: false,
      connectNulls: true,
      lineStyle: { width: 2, color: acColor },
      data: filtered.map((p) => [p.timestamp, Number.isFinite(Number(p.acWatts)) ? Number(p.acWatts) : null])
    });
  }

  return {
    animation: false,
    textStyle: { color: textColor },
    tooltip: {
      trigger: "axis",
      valueFormatter: (value) => `${Number(value).toFixed(0)} W`
    },
    legend: { top: 2, textStyle: { color: textColor } },
    grid: { left: 55, right: 20, top: 46, bottom: 72 },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: subtleColor } },
      axisLabel: { color: subtleColor },
      splitLine: { lineStyle: { color: gridColor } }
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLine: { lineStyle: { color: subtleColor } },
      axisLabel: { color: subtleColor },
      splitLine: { lineStyle: { color: gridColor } }
    },
    dataZoom: [
      { type: "inside", xAxisIndex: 0, filterMode: "none" },
      { type: "slider", xAxisIndex: 0, height: 24, bottom: 24 }
    ],
    series
  };
}

function ensureChart() {
  if (chart) return;
  chart = echarts.init(chartEl);
  window.addEventListener("resize", () => chart.resize());
}

function renderChart(points) {
  ensureChart();
  chart.setOption(buildChartOption(points), true);
}

function bindHistoryControls() {
  rangePresetEl.addEventListener("change", () => renderChart(allHistoryPoints));
}

async function bootstrap() {
  bindHistoryControls();
  try {
    const [currentRes, historyRes] = await Promise.all([fetch("/api/current"), fetch("/api/history")]);
    const currentJson = await currentRes.json();
    const historyJson = await historyRes.json();

    renderCurrent(currentJson.current);
    renderTodaySummary(currentJson.todaySummary);
    applySolarBackground(currentJson.current);
    allHistoryPoints = historyJson.points || [];
    renderChart(allHistoryPoints);
  } catch (err) {
    statusEl.textContent = `Failed to load initial data: ${err.message}`;
    statusEl.className = "status warning";
  }

  const events = new EventSource("/api/stream");
  events.onmessage = async (event) => {
    const payload = JSON.parse(event.data);
    if (!payload?.data) return;

    renderCurrent(payload.data);
    renderTodaySummary(payload.todaySummary);
    applySolarBackground(payload.data);

    try {
      const historyRes = await fetch("/api/history");
      const historyJson = await historyRes.json();
      allHistoryPoints = historyJson.points || [];
      renderChart(allHistoryPoints);
    } catch (_err) {
      // Keep current reading visible even if history refresh fails.
    }
  };

  events.onerror = () => {
    statusEl.textContent = "Connection lost. Retrying...";
    statusEl.className = "status warning";
  };
}

bootstrap();
