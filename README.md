# DataM - App contable full stack

Aplicación contable construida con **FastAPI + SQLite + React (Vite)**.

## Funcionalidades

- Login y registro seguros con hash bcrypt.
- Autenticación por JWT (access + refresh) en cookies HttpOnly con SameSite strict.
- Dashboard contable moderno con tabs por flujo de trabajo.
- Carga de Excel con deduplicación, historial y actualización de periodos.
- Filtros dinámicos avanzados por categoría, proyecto, cuenta, fechas, tipo y búsqueda.
- Gráficos interactivos conectados con informe detallado.
- Informe exportable CSV/PDF con resumen ejecutivo y detalle de movimientos.
- Multi-compañía y multi-vault (mensual/trimestral/anual/personalizado).

## Estructura

- `app/main.py`: backend FastAPI, modelos, autenticación y APIs.
- `frontend/`: SPA React + Vite + Tailwind.
- `tests/test_app.py`: prueba de flujo principal auth + carga + consultas.

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
# Windows
.venv\Scripts\activate
# Linux/Mac
source .venv/bin/activate

pip install -r requirements.txt

cd frontend
npm install
npm run build
cd ..

uvicorn app.main:app --reload
```

Abrir: `http://127.0.0.1:8000`

## Variables de entorno recomendadas

```bash
JWT_SECRET=una_clave_larga_y_segura
ACCESS_TOKEN_MINUTES=30
REFRESH_TOKEN_DAYS=7
DATABASE_URL=sqlite:///./app.db
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
```

## Producción (opción Docker)

Construir imagen:

```bash
docker build -t datam:prod .
```

Ejecutar contenedor:

```bash
docker run -d --name datam-prod -p 8000:8000 \
  -e JWT_SECRET="cambia_esta_clave" \
  -e ACCESS_TOKEN_MINUTES=30 \
  -e REFRESH_TOKEN_DAYS=7 \
  -e DATABASE_URL="sqlite:///./app.db" \
  -e COOKIE_SECURE=true \
  -e COOKIE_SAMESITE=lax \
  datam:prod
```

## Producción (sin Docker)

1. Build de frontend:

```bash
cd frontend
npm ci
npm run build
cd ..
```

2. Instalar backend:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

3. Levantar API en modo productivo:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
```

Recomendado: publicar detrás de un reverse proxy (Nginx/Caddy) con HTTPS.

## Flujo de uso

1. Crear usuario e iniciar sesión.
2. Seleccionar o crear compañía.
3. Seleccionar o crear vault (mensual/trimestral/anual/personalizado).
4. Cargar Excel, aplicar filtros, analizar gráficos y exportar informe detallado.

