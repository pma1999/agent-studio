# Despliegue: Vercel (frontend) + Railway (backend)

Este proyecto está preparado para desplegar el **frontend** en **Vercel** y el **backend** en **Railway**, de forma segura.

---

## 1. Backend en Railway

### 1.1 Crear proyecto en Railway

1. Entra en [railway.app](https://railway.app) y crea un proyecto nuevo.
2. Añade un **service** desde “Deploy from GitHub repo” (o desde CLI) y conecta este repositorio.
3. Railway detectará Node.js. Asegúrate de que:
   - **Build command**: `npm run build:server` (o deja que Nixpacks use `nixpacks.toml`).
   - **Start command**: `npm run start`.
4. Si usas **Variables**: en el dashboard del service, añade:
   - `CORS_ORIGIN`: URL del frontend en Vercel, por ejemplo:
     - Producción: `https://tu-app.vercel.app`
     - Para permitir también previews: `https://tu-app.vercel.app,https://*.vercel.app`
     - (Si no pones nada, CORS permite cualquier origen; solo recomendable en desarrollo.)
   - `PORT`: lo asigna Railway; no hace falta que lo definas tú.

### 1.2 Obtener la URL del backend

Tras el deploy, Railway te da una URL pública (ej. `https://tu-proyecto.railway.app`). Cópiala; la usarás en Vercel.

### 1.3 Preparar y vincular la base de datos (SQLite)

El backend usa **SQLite** en un solo archivo. No tienes que instalar nada aparte: al arrancar el servidor se ejecutan las migraciones y se crea la BD si no existe.

#### En local (desarrollo)

- No hace falta configurar nada. La BD se crea automáticamente en la raíz del proyecto como `agent-studio.db` (o en `dist/server/` si ejecutas con `npm run start` tras `build:server`).
- Si quieres usar otra ruta, en tu `.env` pon por ejemplo:  
  `DATABASE_PATH=./mi-carpeta/agent-studio.db`

#### En Railway (producción persistente)

Para que la base de datos **no se borre** en cada redeploy:

1. **Crear un Volume en Railway**
   - En el dashboard de Railway, entra en tu **service** (el backend).
   - Pestaña **Variables** (o **Settings** según la UI).
   - Busca la sección **Volumes** y haz clic en **+ Add Volume**.
   - **Mount Path**: escribe exactamente `/data` (esta será la carpeta persistente dentro del contenedor).
   - Guarda.

2. **Vincular la BD al volumen**
   - En el mismo service, ve a **Variables** (Environment Variables).
   - Añade una variable:
     - **Name**: `DATABASE_PATH`
     - **Value**: `/data/agent-studio.db`
   - Así el archivo de la BD queda dentro del volumen montado en `/data` y persiste entre deploys.

3. **Redeploy**
   - Haz un nuevo deploy (push a tu rama o “Redeploy” en Railway). El servidor arrancará, creará `/data/agent-studio.db` si no existe y ejecutará las migraciones.

**Resumen**: Volume con mount path `/data` + variable `DATABASE_PATH=/data/agent-studio.db` = BD persistente en Railway.

Si **no** añades volumen ni `DATABASE_PATH`, la BD se crea en disco efímero y se pierde en cada redeploy (útil solo para pruebas).

#### Usar tu base de datos local en Railway

Si ya tienes un `agent-studio.db` en tu máquina (con tus agentes, conversaciones, etc.) y quieres que Railway use **esa misma base de datos**:

1. **Railway CLI**: instala y vincula el proyecto.
   - Instalar: `npm i -g @railway/cli` (o `brew install railway` en macOS).
   - En la raíz del repo: `railway link` y elige tu proyecto y el service del backend.

2. **Volume y variable**: asegúrate de tener el Volume en `/data` y `DATABASE_PATH=/data/agent-studio.db` (pasos de la sección anterior).

3. **Subir tu archivo** desde tu máquina (el archivo está en `.gitignore`, no se sube con Git). En la raíz del proyecto, donde tengas tu `agent-studio.db` (o indica la ruta):

   ```bash
   cat agent-studio.db | railway run npm run db:restore
   ```

   Si la BD está en otra ruta, por ejemplo `dist/server/agent-studio.db`:

   ```bash
   cat dist/server/agent-studio.db | railway run npm run db:restore
   ```

   El script escribe en el volumen de Railway; al hacer el siguiente deploy o al arrancar el backend, usará esa BD.

4. **Redeploy** el service en Railway (o espera al siguiente deploy). A partir de ahí, tu backend en producción usará la misma base de datos que subiste.

---

## 2. Frontend en Vercel

### 2.1 Conectar el repositorio

1. Entra en [vercel.com](https://vercel.com) y “Add New Project”.
2. Importa el mismo repositorio de GitHub (o Git).
3. Configuración:
   - **Framework Preset**: Vite (o “Other”).
   - **Build Command**: `npm run build` (por defecto; construye solo el cliente).
   - **Output Directory**: `dist`.
   - **Install Command**: `npm install` (o `npm ci`).

No hace falta configurar variables para desarrollo local; para producción sí (siguiente paso).

### 2.2 Variable de entorno en Vercel

En el proyecto de Vercel → **Settings** → **Environment Variables**:

- **Name**: `VITE_API_URL`
- **Value**: URL del backend en Railway **sin** barra final, por ejemplo: `https://tu-proyecto.railway.app`
- **Environment**: Production (y, si quieres, Preview).

Importante: las variables `VITE_*` se embeben en el build; hay que redeployar después de cambiarlas.

### 2.3 Deploy

Haz push a la rama que tengas conectada (p. ej. `main`). Vercel hará build y deploy. La app en `https://tu-app.vercel.app` usará automáticamente el backend de Railway si `VITE_API_URL` está bien configurada.

---

## 3. Resumen de variables

| Dónde   | Variable        | Descripción |
|--------|------------------|-------------|
| Vercel | `VITE_API_URL`   | URL base del backend (Railway), sin `/api` ni barra final. |
| Railway| `CORS_ORIGIN`    | Origen(es) permitidos para CORS (tu dominio Vercel). |
| Railway| `PORT`           | Lo define Railway; no suele hacer falta configurarlo. |

Opcional en ambos: `.env.example` documenta variables opcionales (p. ej. seed de API keys).

---

## 4. Comprobar que todo funciona

1. **Health**: `https://tu-backend.railway.app/api/health` debe devolver `{"status":"ok",...}`.
2. **Frontend**: Abre `https://tu-app.vercel.app`, abre Settings y comprueba que “Backend running” o el test de conexión al API responda bien.
3. **Chat**: Crea un agente, configura OpenRouter en Settings y envía un mensaje; debe responder usando el backend en Railway.

---

## 5. Seguridad aplicada

- CORS restringido en el backend según `CORS_ORIGIN`.
- Rate limit: 300 peticiones / 15 min por IP en la API; 60 / 15 min en `/api/chat`.
- `trust proxy` activado en Express para que Railway use bien la IP del cliente.
- Headers de seguridad en el frontend (Vercel): `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- Código de telemetría/debug eliminado del backend.
