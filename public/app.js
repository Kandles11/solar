const currentWattsEl = document.getElementById("currentWatts");
const lastUpdatedEl = document.getElementById("lastUpdated");
const statusEl = document.getElementById("status");
const todayKwhEl = document.getElementById("todayKwh");
const todayValueEl = document.getElementById("todayValue");
const acWattsEl = document.getElementById("acWatts");
const chartCanvas = document.getElementById("historyChart");
const MAX_SOLAR_WATTS = 91;

let chart;
let currentTheme = null;

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

function applySolarBackground(reading, todaySummary) {
  const currentWatts = Number(reading?.watts ?? 0);
  const ratio = Math.max(0, Math.min(1, currentWatts / MAX_SOLAR_WATTS));
  const blend = 1 - ratio;
  // Ease theme transitions to avoid low-contrast muddy middle tones.
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

  if (chart) {
    const legendColor = `rgb(${currentTheme.text})`;
    const tickColor = `rgb(${currentTheme.subtle})`;
    const gridBase = currentTheme.subtle;
    chart.options.scales.y.grid.color = `rgba(${gridBase}, 0.24)`;
    chart.options.scales.x.grid.color = `rgba(${gridBase}, 0.18)`;
    chart.options.scales.y.ticks.color = tickColor;
    chart.options.scales.x.ticks.color = tickColor;
    chart.options.plugins.legend.labels.color = legendColor;
  }
}

function renderChart(points) {
  const labels = points.map((p) => new Date(p.timestamp).toLocaleTimeString());
  const solarValues = points.map((p) => p.watts);
  const hasAcSeries = points.some((p) => Number.isFinite(Number(p.acWatts)));
  const acValues = points.map((p) =>
    Number.isFinite(Number(p.acWatts)) ? Number(p.acWatts) : null
  );

  const datasets = [
    {
      label: "Solar input (W)",
      data: solarValues,
      borderColor: currentTheme ? `rgb(${currentTheme.accent})` : "#bc6d1d",
      backgroundColor: currentTheme
        ? `rgba(${currentTheme.accent}, 0.16)`
        : "rgba(188, 109, 29, 0.16)",
      borderWidth: 2,
      tension: 0.2,
      pointRadius: 0
    }
  ];

  if (hasAcSeries) {
    datasets.push({
      label: "EcoFlow AC output (W)",
      data: acValues,
      borderColor: currentTheme ? `rgb(${currentTheme.subtle})` : "#5a6b7d",
      backgroundColor: currentTheme
        ? `rgba(${currentTheme.subtle}, 0.2)`
        : "rgba(90, 107, 125, 0.14)",
      borderWidth: 2,
      tension: 0.2,
      pointRadius: 0,
      spanGaps: true
    });
  }

  if (!chart) {
    chart = new Chart(chartCanvas, {
      type: "line",
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: "rgba(89, 70, 48, 0.16)"
            },
            ticks: {
              color: currentTheme ? `rgb(${currentTheme.subtle})` : "#4f4132"
            }
          },
          x: {
            grid: {
              color: "rgba(89, 70, 48, 0.12)"
            },
            ticks: {
              color: currentTheme ? `rgb(${currentTheme.subtle})` : "#4f4132",
              maxTicksLimit: 9
            }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: currentTheme ? `rgb(${currentTheme.text})` : "#2c2218"
            }
          }
        }
      }
    });
    return;
  }

  chart.data.labels = labels;
  chart.data.datasets = datasets;
  chart.update("none");
}

async function bootstrap() {
  try {
    const [currentRes, historyRes] = await Promise.all([
      fetch("/api/current"),
      fetch("/api/history")
    ]);

    const currentJson = await currentRes.json();
    const historyJson = await historyRes.json();

    renderCurrent(currentJson.current);
    renderTodaySummary(currentJson.todaySummary);
    applySolarBackground(currentJson.current, currentJson.todaySummary);
    renderChart(historyJson.points || []);
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
    applySolarBackground(payload.data, payload.todaySummary);

    try {
      const historyRes = await fetch("/api/history");
      const historyJson = await historyRes.json();
      renderChart(historyJson.points || []);
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
