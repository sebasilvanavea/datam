# DataM - App contable full stack

Aplicación contable sin costos de infraestructura, construida con **FastAPI + SQLite + frontend vanilla**.

## Funcionalidades

- Login y registro seguros con hash bcrypt.
- Autenticación por JWT (access + refresh) en cookies HttpOnly con SameSite strict.
- Dashboard contable moderno y minimalista.
- Carga de Excel para insertar movimientos contables.
- Filtros dinámicos por categoría, tipo de flujo, fechas y texto.
- Gráficos dinámicos con Chart.js:
  - Monto por categoría.
  - Distribución ingreso/egreso.
  - Tendencia mensual.

## Estructura

- `app/main.py`: backend FastAPI, modelos, autenticación, APIs.
- `app/templates/index.html`: layout login + dashboard.
- `app/static/styles.css`: estilos minimalistas.
- `app/static/app.js`: lógica de UX + gráficos + consumo de APIs.

## Formato Excel esperado

Tu archivo debe incluir estas columnas (no sensibles a mayúsculas/minúsculas):

- `fecha`
- `categoria`
- `subcategoria`
- `descripcion`
- `tipo` (`ingreso` o `egreso`)
- `monto`

## Ejecución local

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Abrir: `http://127.0.0.1:8000`

## Variables de entorno recomendadas

```bash
export JWT_SECRET="una_clave_larga_y_segura"
export ACCESS_TOKEN_MINUTES=30
export REFRESH_TOKEN_DAYS=7
export DATABASE_URL="sqlite:///./app.db"
```

## Flujo de uso

1. Crear usuario desde la pantalla principal.
2. Iniciar sesión.
3. Cargar Excel con formato definido.
4. Aplicar filtros y analizar gráficos.

