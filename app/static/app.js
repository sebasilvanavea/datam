const authCard = document.getElementById('authCard');
const dashboard = document.getElementById('dashboard');
const authMessage = document.getElementById('authMessage');
const uploadMessage = document.getElementById('uploadMessage');
const recordsBody = document.getElementById('recordsBody');
const welcome = document.getElementById('welcome');
const categorySelect = document.getElementById('category');
const themeToggle = document.getElementById('themeToggle');

const charts = { category: null, flow: null, month: null };

function getThemeColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    text: css.getPropertyValue('--text').trim(),
    muted: css.getPropertyValue('--muted').trim(),
    gridLine: css.getPropertyValue('--grid-line').trim(),
    chartAccent: css.getPropertyValue('--chart-accent').trim(),
    chartBar: css.getPropertyValue('--chart-bar').trim(),
    donut: [
      css.getPropertyValue('--chart-accent').trim(),
      css.getPropertyValue('--chart-donut-2').trim(),
      css.getPropertyValue('--chart-donut-3').trim(),
      css.getPropertyValue('--chart-donut-4').trim(),
      css.getPropertyValue('--chart-donut-5').trim(),
    ],
  };
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('datam-theme', theme);
  if (themeToggle) {
    themeToggle.textContent = theme === 'dark' ? 'Tema claro' : 'Tema oscuro';
  }
}

function initializeTheme() {
  const savedTheme = localStorage.getItem('datam-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);
}

async function api(path, options = {}, retry = true) {
  const response = await fetch(path, { credentials: 'include', ...options });
  if (response.status === 401 && retry) {
    const refresh = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refresh.ok) {
      return api(path, options, false);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'Error inesperado' }));
    throw new Error(payload.detail || 'Error');
  }
  return response.json();
}

function setButtonLoading(button, loading, loadingText = 'Procesando...') {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function toggleLoggedIn(loggedIn) {
  authCard.classList.toggle('hidden', loggedIn);
  dashboard.classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    dashboard.classList.remove('is-visible');
    requestAnimationFrame(() => dashboard.classList.add('is-visible'));
  } else {
    dashboard.classList.remove('is-visible');
  }
}

function paintTable(records) {
  recordsBody.innerHTML = records.map((item) => `
    <tr>
      <td>${item.fecha}</td>
      <td>${item.categoria}</td>
      <td>${item.subcategoria}</td>
      <td>${item.descripcion}</td>
      <td>${item.tipo}</td>
      <td>${item.monto.toFixed(2)}</td>
    </tr>
  `).join('');
}

function buildChart(target, type, labels, values, label) {
  const theme = getThemeColors();
  const dataset = {
    label,
    data: values,
    borderWidth: 2,
    borderRadius: type === 'bar' ? 8 : 0,
  };

  if (type === 'line') {
    dataset.borderColor = theme.chartAccent;
    dataset.backgroundColor = 'transparent';
    dataset.pointBackgroundColor = theme.chartAccent;
    dataset.tension = 0.34;
  } else if (type === 'bar') {
    dataset.backgroundColor = theme.chartBar;
    dataset.borderColor = theme.chartAccent;
  } else if (type === 'doughnut') {
    dataset.backgroundColor = theme.donut;
    dataset.borderColor = 'transparent';
  }

  if (charts[target]) charts[target].destroy();
  const ctx = document.getElementById(`${target}Chart`);
  charts[target] = new Chart(ctx, {
    type,
    data: { labels, datasets: [dataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: theme.text,
          },
        },
      },
      scales: type === 'doughnut' ? {} : {
        x: {
          ticks: { color: theme.muted },
          grid: { color: theme.gridLine },
        },
        y: {
          ticks: { color: theme.muted },
          grid: { color: theme.gridLine },
        },
      },
    }
  });
}

function getFilterParams() {
  const params = new URLSearchParams();
  ['search', 'category', 'flowType', 'dateFrom', 'dateTo'].forEach((id) => {
    const value = document.getElementById(id)?.value;
    if (value) {
      params.append(
        id === 'flowType' ? 'flow_type' : id === 'dateFrom' ? 'date_from' : id === 'dateTo' ? 'date_to' : id,
        value
      );
    }
  });
  return params;
}

async function refreshCategoryOptions() {
  const categories = await api('/api/data/categories');
  const selected = categorySelect.value;
  categorySelect.innerHTML = '<option value="">Todas las categorías</option>';
  categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categorySelect.appendChild(option);
  });
  if (categories.includes(selected)) {
    categorySelect.value = selected;
  }
}

async function refreshRecordsAndCharts() {
  const params = getFilterParams();

  const records = await api(`/api/data/records?${params.toString()}`);
  paintTable(records);

  const summary = await api(`/api/data/summary?${params.toString()}`);
  buildChart('category', 'bar', summary.by_category.map(x => x.label), summary.by_category.map(x => x.value), 'Monto por categoría');
  buildChart('flow', 'doughnut', summary.by_flow.map(x => x.label), summary.by_flow.map(x => x.value), 'Distribución por flujo');
  buildChart('month', 'line', summary.by_month.map(x => x.label), summary.by_month.map(x => x.value), 'Tendencia mensual');
}

document.getElementById('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authMessage.textContent = '';
  const submitButton = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitButton, true, 'Creando...');
  try {
    const formData = new FormData(event.target);
    const response = await fetch('/api/auth/register', { method: 'POST', body: formData, credentials: 'include' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || 'No se pudo registrar');
    authMessage.textContent = payload.message;
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    setButtonLoading(submitButton, false);
  }
});

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authMessage.textContent = '';
  const submitButton = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitButton, true, 'Ingresando...');
  try {
    const formData = new FormData(event.target);
    await fetch('/api/auth/login', { method: 'POST', body: formData, credentials: 'include' }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'No autenticado');
      return data;
    });
    const me = await api('/api/me');
    welcome.textContent = `Hola ${me.full_name}.`; 
    toggleLoggedIn(true);
    await refreshCategoryOptions();
    await refreshRecordsAndCharts();
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    setButtonLoading(submitButton, false);
  }
});

document.getElementById('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  uploadMessage.textContent = '';
  const submitButton = event.target.querySelector('button[type="submit"]');
  setButtonLoading(submitButton, true, 'Subiendo...');
  try {
    const formData = new FormData(event.target);
    const response = await fetch('/api/data/upload', { method: 'POST', body: formData, credentials: 'include' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || 'Error al subir archivo');
    uploadMessage.textContent = `${payload.message}: ${payload.rows_inserted} registros insertados`;
    await refreshCategoryOptions();
    await refreshRecordsAndCharts();
  } catch (error) {
    uploadMessage.textContent = error.message;
  } finally {
    setButtonLoading(submitButton, false);
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  toggleLoggedIn(false);
});

document.getElementById('applyFilters').addEventListener('click', async () => {
  try {
    await refreshRecordsAndCharts();
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
});

document.getElementById('clearFilters').addEventListener('click', async () => {
  ['search', 'category', 'flowType', 'dateFrom', 'dateTo'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) element.value = '';
  });
  try {
    await refreshRecordsAndCharts();
  } catch (error) {
    uploadMessage.textContent = error.message;
  }
});

if (themeToggle) {
  themeToggle.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    applyTheme(current === 'dark' ? 'light' : 'dark');
    if (!dashboard.classList.contains('hidden')) {
      try {
        await refreshRecordsAndCharts();
      } catch (error) {
        uploadMessage.textContent = error.message;
      }
    }
  });
}

(async function init() {
  initializeTheme();
  try {
    const me = await api('/api/me');
    welcome.textContent = `Hola ${me.full_name}.`;
    toggleLoggedIn(true);
    await refreshCategoryOptions();
    await refreshRecordsAndCharts();
  } catch {
    toggleLoggedIn(false);
  }
})();
