# Despliegue en producción (gratis)

Esta guía usa un VPS gratuito (Oracle Cloud Always Free) + Docker + Caddy + HTTPS.

## 1) Crear infraestructura gratuita

1. Crea cuenta en Oracle Cloud Free Tier.
2. Crea una VM (Ubuntu 22.04, micro ARM always free).
3. Reserva IP pública.
4. Abre puertos en reglas de red: `80`, `443`, `22`.

## 2) Preparar dominio gratis

Puedes usar DuckDNS (gratis):

1. Crea subdominio, por ejemplo `midatam.duckdns.org`.
2. Apunta ese subdominio a la IP pública de la VM.

## 3) Conectar y preparar servidor

Conéctate por SSH:

`ssh ubuntu@TU_IP_PUBLICA`

Instala Docker y Compose plugin:

`sudo apt update`

`sudo apt install -y ca-certificates curl gnupg`

`sudo install -m 0755 -d /etc/apt/keyrings`

`curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg`

`echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null`

`sudo apt update`

`sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`

`sudo usermod -aG docker $USER`

Sal y vuelve a entrar por SSH para aplicar el grupo `docker`.

## 4) Subir el proyecto

Opción Git:

`git clone TU_REPO_URL datam`

`cd datam`

## 5) Configurar variables de producción

`cp .env.prod.example .env.prod`

Edita `.env.prod`:

- `JWT_SECRET`: cadena larga y única.
- `COOKIE_SECURE=true`
- `COOKIE_SAMESITE=lax`
- `DOMAIN=tu_subdominio.duckdns.org`

## 6) Levantar en producción

`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`

Verifica estado:

`docker compose -f docker-compose.prod.yml ps`

Ver logs:

`docker compose -f docker-compose.prod.yml logs -f`

## 7) Verificar app online

Abre:

`https://tu_subdominio.duckdns.org`

## 8) Operación básica

Actualizar a nueva versión:

`git pull`

`docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`

Backup SQLite:

`cp data/app.db data/app_$(date +%F).db.bak`

Backup archivos subidos:

`tar -czf uploads_$(date +%F).tar.gz app/uploads`

## 9) Solución rápida de problemas

- Si no carga HTTPS: valida DNS apuntando a la IP correcta y puertos `80/443` abiertos.
- Si login falla por cookies: confirma `COOKIE_SECURE=true` y acceso por `https://`.
- Si no persisten datos: revisa que exista carpeta `data/` en el host.

## 10) Opción híbrida: Netlify + backend gratis

Si prefieres Netlify para frontend:

1. Despliega backend (pasos 1-8) en Oracle Free/VPS.
2. En Netlify crea sitio apuntando a carpeta `frontend`.
3. Build command: `npm run build`.
4. Publish directory: `dist`.
5. Variable en Netlify:
	- `VITE_API_BASE_URL=https://TU_BACKEND_PUBLICO`

Variables backend recomendadas para esta modalidad:

- `COOKIE_SECURE=true`
- `COOKIE_SAMESITE=none`
- `CORS_ALLOW_ORIGINS=https://TU_APP.netlify.app`

Notas:

- `COOKIE_SAMESITE=none` requiere HTTPS (Netlify y tu backend deben estar en HTTPS).
- Si cambias de dominio Netlify, actualiza `CORS_ALLOW_ORIGINS`.
