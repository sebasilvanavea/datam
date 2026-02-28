const authCard = document.getElementById('authCard');
const dashboard = document.getElementById('dashboard');
const authMessage = document.getElementById('authMessage');
const uploadMessage = document.getElementById('uploadMessage');
const recordsBody = document.getElementById('recordsBody');
const welcome = document.getElementById('welcome');

const charts = { category: null, flow: null, month: null };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: 'Error inesperado' }));
    throw new Error(payload.detail || 'Error');
  }
  return response.json();
}

function toggleLoggedIn(loggedIn) {
  authCard.classList.toggle('hidden', loggedIn);
  dashboard.classList.toggle('hidden', !loggedIn);
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
  if (charts[target]) charts[target].destroy();
  const ctx = document.getElementById(`${target}Chart`);
  charts[target] = new Chart(ctx, {
    type,
    data: { labels, datasets: [{ label, data: values, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false }
  });
}

async function refreshRecordsAndCharts() {
  const params = new URLSearchParams();
  ['search', 'category', 'flowType', 'dateFrom', 'dateTo'].forEach((id) => {
    const value = document.getElementById(id)?.value;
    if (value) params.append(id === 'flowType' ? 'flow_type' : id === 'dateFrom' ? 'date_from' : id === 'dateTo' ? 'date_to' : id, value);
  });

  const records = await api(`/api/data/records?${params.toString()}`);
  paintTable(records);

  const summary = await api('/api/data/summary');
  buildChart('category', 'bar', summary.by_category.map(x => x.label), summary.by_category.map(x => x.value), 'Monto por categoría');
  buildChart('flow', 'doughnut', summary.by_flow.map(x => x.label), summary.by_flow.map(x => x.value), 'Distribución por flujo');
  buildChart('month', 'line', summary.by_month.map(x => x.label), summary.by_month.map(x => x.value), 'Tendencia mensual');
}

document.getElementById('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authMessage.textContent = '';
  try {
    const formData = new FormData(event.target);
    const response = await fetch('/api/auth/register', { method: 'POST', body: formData, credentials: 'include' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || 'No se pudo registrar');
    authMessage.textContent = payload.message;
  } catch (error) {
    authMessage.textContent = error.message;
  }
});

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  authMessage.textContent = '';
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
    await refreshRecordsAndCharts();
  } catch (error) {
    authMessage.textContent = error.message;
  }
});

document.getElementById('uploadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  uploadMessage.textContent = '';
  try {
    const formData = new FormData(event.target);
    const response = await fetch('/api/data/upload', { method: 'POST', body: formData, credentials: 'include' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || 'Error al subir archivo');
    uploadMessage.textContent = `${payload.message}: ${payload.rows_inserted} registros insertados`;
    await refreshRecordsAndCharts();
  } catch (error) {
    uploadMessage.textContent = error.message;
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

(async function init() {
  try {
    const me = await api('/api/me');
    welcome.textContent = `Hola ${me.full_name}.`;
    toggleLoggedIn(true);
    await refreshRecordsAndCharts();
  } catch {
    toggleLoggedIn(false);
  }
})();
