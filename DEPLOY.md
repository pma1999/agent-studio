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
   - `CORS_ORIGIN`: URL del frontend en Vercel (ej. `https://tu-app.vercel.app`). Si no pones nada, CORS permite cualquier origen (solo desarrollo).
   - **`JWT_SECRET`** (recomendado en producción): secreto para firmar sesiones (mín. 32 caracteres). **Si no lo defines, la app corre en "modo local"**: no pide login y todo el mundo entra como usuario local; en producción debes definirlo para que se exija inicio de sesión. Opcionalmente puedes definir **`DISABLE_AUTH=true`** para forzar modo local (sin login) incluso si `JWT_SECRET` está definido.
   - `PORT`: lo asigna Railway; no hace falta definirlo.
   - **`ENCRYPTION_KEY`** (mín. 32 caracteres): cifra API keys y credenciales MCP en la BD. Es obligatoria si vas a crear, editar o importar servidores MCP.
   - Opcional: `INITIAL_ADMIN_PASSWORD` (contraseña del admin inicial).

### 1.2 Si ves 502 "Application failed to respond"

Si el backend hace deploy pero las peticiones devuelven **502** y en los logs aparece "Agent Studio server running", el proxy de Railway no está llegando al proceso. Comprueba:

1. **Puerto de destino (target port)**  
   En Railway → tu **service** → **Settings** → **Networking** (o **Domains**). Busca **Port** / **Target port**.  
   La app escucha en la variable `PORT` que Railway inyecta (suele ser **8080**). El valor configurado aquí **debe coincidir** con ese puerto (o dejar la opción por defecto para que Railway use `PORT`). Si pone por ejemplo 3000 y la app escucha en 8080, cambia a **8080** o borra el valor para usar el automático.

2. **Health check**  
   En **Settings** del service, en **Health Check** (si existe), pon la ruta: **`/api/health`**. Así Railway comprueba que la app responde antes de enviar tráfico. La app devuelve **200** en `GET /` y `GET /api/health`.

3. **Redeploy**  
   Después de cambiar el puerto o el health check, haz **Redeploy** del service.

### 1.3 Obtener la URL del backend

Tras el deploy, Railway te da una URL pública (ej. `https://tu-proyecto.railway.app`). Cópiala; la usarás en Vercel.

### 1.4 Preparar y vincular la base de datos (SQLite)

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

1. **Migrar la BD en local** (asigna todos los datos al usuario admin para que al subir veas tus agentes):
   - En la raíz del proyecto:
     ```bash
     npm run build:server
     npm run db:migrate-local
     ```
   - Esto ejecuta las migraciones sobre tu `agent-studio.db` local: crea o actualiza el usuario indicado en `INITIAL_ADMIN_EMAIL` y le asigna todos los agentes, conversaciones y ajustes que estaban en el usuario por defecto. El archivo `agent-studio.db` queda listo para subir.

2. **Volume y variable en Railway**: asegúrate de tener el Volume en `/data` y `DATABASE_PATH=/data/agent-studio.db` (pasos de la sección anterior).

3. **Railway CLI** (si no lo tienes): `npm i -g @railway/cli`, luego en la raíz del repo: `npx @railway/cli link` y elige proyecto y service del backend.

4. **Subir la BD** desde tu máquina (PowerShell, con el proyecto enlazado):
   ```powershell
   cmd /c "type agent-studio.db | npx @railway/cli run npm run db:restore"
   ```
   Si la BD está en otra ruta (p. ej. `dist\server\agent-studio.db`), ajusta la ruta en `type ...`.

5. **Redeploy** del service en Railway. A partir de ahí, el backend usará la BD que subiste y verás tus agentes al iniciar sesión.

### 1.5 Coste: modo Serverless y watch paths

Railway factura **memoria y CPU por minuto encendido**, no por petición atendida. Un backend personal pasa la mayor parte del día ocioso, así que casi toda la factura es memoria parada. Dos ajustes en **Settings** del service la recortan:

- **Serverless** (antes "App Sleeping"): está **activado**, pero medido el 2026-09-02 **no llega a dormirse**. Con el flag confirmado en la config y el contenedor recreado después, 13 min sin una sola petición dejaron el servicio en `online`, la memoria nunca bajó de 0,144 GB y la primera petición posterior respondió 200 en 0,31 s: contenedor caliente, no arranque en frío. Railway duerme un servicio en función de los **paquetes salientes**, y aquí queda un suelo constante de ~224 B/min que la app no genera (sus únicos timers son barridos locales `unref`, no hay telemetría, ni sondeo saliente, ni pool de conexiones: SQLite es local). La hipótesis —**inferida, no confirmada**, y que la documentación de Railway no cubre— es que sea keep-alive TCP entre el proxy de borde y el contenedor. Bajar `keepAliveTimeout` no es salida: los 60 s están puestos a propósito por encima de los ~15 s de reutilización del proxy para evitar 502 intermitentes. Confirmarlo requiere abrir hilo con soporte de Railway para ver la telemetría de red de la cuenta. Se deja activado porque no cuesta nada y aprovecharía el día que ese tráfico residual desaparezca; **no cuentes con el ahorro mientras no se observe el servicio en `sleeping`**.
- Si algún día sí duerme: la primera petición tarda unos segundos y **puede devolver un 502** (documentado por Railway). El cliente ya reintenta 502/503/504 con back-off (`fetchWithGatewayRetry` en `src/api/client.ts`), así que el arranque en frío se vería como una carga lenta, no como un error, y el volumen `/data` sobrevive al ciclo. Mientras el **agente local** esté emparejado y conectado, su heartbeat cada 20 s mantiene el servicio despierto: es el comportamiento correcto, pero conviene cerrarlo cuando no se use.
- **Watch paths**: el repo es único (frontend en Vercel, backend en Railway), así que sin filtro un commit de documentación o de `src/` reconstruye el backend. Los patrones activos limitan el build a `/server/**`, `/shared/**`, `/package.json`, `/package-lock.json`, `/tsconfig.server.json`, `/railway.json`, `/nixpacks.toml` y los dos scripts de BD que se ejecutan con `railway run`.

Del lado del código, `jsdom` (~80 MB de RSS medidos en local) y el SDK de `e2b` (~16 MB) se cargan con `import()` dinámico la primera vez que se usan en vez de en el arranque, porque la mayoría de las peticiones no pasan por extracción de artículos ni por sandbox en la nube.

Ojo al medir el efecto: el suelo de arranque en producción **no se movió** (0,143 GB antes, 0,144 GB después), así que esos 80 MB de local no se trasladan al contenedor Linux en la misma proporción. Además las promesas de carga se cachean a nivel de módulo, de modo que el primer `web_fetch` que extraiga un artículo deja jsdom cargado para el resto de la vida del contenedor —y, mientras el servicio no duerma, esa vida son días. La cifra comparable es la media de 7 días (0,288 GB antes de este cambio); no la des por mejorada hasta releerla con varios días de uso real encima.

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
| Railway| `JWT_SECRET`     | **Producción:** obligatorio para exigir login. Sin él, la app corre en modo local (sin login). Mín. 32 caracteres. |
| Railway| `DISABLE_AUTH`   | Opcional. Si es `true` o `1`, desactiva login/registro (modo local) aunque exista `JWT_SECRET`. |
| Railway| `PORT`           | Lo define Railway; no suele hacer falta configurarlo. |
| Railway| `ENCRYPTION_KEY` | Cifra secretos; obligatoria para guardar configuraciones MCP. Mín. 32 caracteres. |
| Railway| `MCP_ALLOW_BACKEND_STDIO` | Mantener sin definir salvo despliegue monousuario de confianza; los procesos MCP locales deben usar normalmente el agente emparejado. |

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
