# Agent Studio

Espacio de trabajo personal de agentes de IA. Crea agentes con prompts de sistema propios, chatea con ellos en streaming, ejecuta herramientas reales (comandos en tu propio PC, sandbox en la nube, navegación web, ficheros), conecta servidores MCP, define **skills** reutilizables y haz deliberar a varios modelos a la vez (**Model Council**) — todo desde una interfaz oscura cuidada ("Obsidian Atelier"), responsive y pensada para escritorio y móvil.

No depende de un único proveedor: puedes hablar con más de 300 modelos vía **OpenRouter**, directamente con **DeepSeek**, con los modelos de tu cuenta de **ChatGPT (Codex)** o con modelos **locales de llama.cpp** ejecutándose en tu propia máquina.

---

## Índice

1. [Características](#características)
2. [Arquitectura](#arquitectura)
3. [Stack tecnológico](#stack-tecnológico)
4. [Requisitos previos](#requisitos-previos)
5. [Inicio rápido (desarrollo)](#inicio-rápido-desarrollo)
6. [Proveedores de modelos](#proveedores-de-modelos)
7. [Conceptos clave](#conceptos-clave)
   - [Agentes](#agentes) · [Conversaciones y árbol de mensajes](#conversaciones-y-árbol-de-mensajes) · [Chat general](#chat-general) · [Model Council](#model-council) · [Herramientas integradas](#herramientas-integradas) · [MCP](#mcp-model-context-protocol) · [Skills](#skills) · [Ejecución de comandos](#ejecución-de-comandos-local--e2b) · [Archivos](#archivos) · [Compartir conversaciones](#compartir-conversaciones-y-deep-links)
8. [El agente local (`local-agent/`)](#el-agente-local-local-agent)
9. [Modelo de seguridad](#modelo-de-seguridad)
10. [Variables de entorno](#variables-de-entorno)
11. [Base de datos](#base-de-datos)
12. [Scripts npm](#scripts-npm)
13. [Tests](#tests)
14. [Despliegue en producción](#despliegue-en-producción)
15. [Estructura del proyecto](#estructura-del-proyecto)
16. [Notas y peculiaridades importantes](#notas-y-peculiaridades-importantes)

---

## Características

**Chat**
- Streaming en tiempo real con markdown, resaltado de sintaxis y *thinking/razonamiento* plegable por mensaje (con control de esfuerzo: `minimal → low → medium → high → xhigh → max`).
- Árbol de mensajes: **edita y relanza** cualquier mensaje de usuario creando una variante hermana; navega entre variantes con el paginador `‹ n/N ›`; reintenta la última respuesta; botón **Stop** (cancelación real en servidor y cliente).
- La generación **sobrevive a la desconexión del cliente**: el borrador se persiste en base de datos y al reabrir la conversación se recupera por sondeo (`active_turn_id`). Desconectar no cancela nada.
- Adjuntos **PDF** (hasta 5 × 20 MB, archivo o URL) con motor elegible: Auto / extracción de texto / OCR (Mistral) / nativo del proveedor.
- Menciona agentes con `@` e invoca skills con `/` directamente en el compositor.
- Contadores de tokens y coste por mensaje/conversación; títulos de conversación generados automáticamente.
- Deep links `/c/:id` a cualquier conversación.

**Proveedores**
- OpenRouter (300+ modelos, selección de proveedor inferior (*endpoint pinning*) con precios/uptime, OAuth PKCE o clave manual).
- DeepSeek directo (clave propia, validación y saldo en vivo).
- ChatGPT/Codex mediante inicio de sesión por código de dispositivo (*device-code*) — usa tu plan de ChatGPT, sin clave de API.
- llama.cpp local: lanza/supervisa un `llama-server` en tu PC desde la app (presets RÁPIDO/EQUILIBRADO/PROFUNDO, muestreo por modelo, logs, descarga por inactividad).

**Agentes y orquestación**
- Estudio de agentes: emoji, prompt de sistema, modelo, temperatura/máx. tokens, razonamiento, salida estructurada (JSON schema), reparación de respuesta (*response healing*), `tool_choice`, llamadas a herramientas paralelas.
- **Model Council**: varios modelos responden en paralelo, se comparan (acuerdos/desacuerdos/hallazgos únicos) y un modelo sintetizador redacta la respuesta final. Ejecuciones persistentes y consultables.
- Herramientas personalizadas tipo HTTP (GET/POST con esquema JSON) además de las integradas.

**Extensibilidad**
- **MCP**: servidores por URL (StreamableHTTP/SSE), `stdio` (opcional, apagado por defecto) o `relay` (alojados en tu PC emparejado); prueba de conexión, credenciales cifradas y **aprobación humana por llamada**.
- **Skills** al estilo Claude (`SKILL.md`): creación pegando el Markdown, validación previa, importación ZIP, gestión de recursos y scripts ejecutables (`.py/.sh/.js/.ts/.rb/.ps1`).

**Tu ordenador como backend**
- Empareja tu PC con un código (válido 10 min, un solo uso) y el agente local da acceso a: ejecutar comandos reales, leer/escribir/editar/borrar/listar ficheros, enviar/recibir archivos y servir MCP stdio + llama.cpp locales.
- Alternativa en nube: ejecución de comandos en sandbox **E2B**.

**Otros**
- Enlaces públicos de compartición `/s/:token` con instantánea congelada, revocable, token mostrado una sola vez.
- Exportación/importación JSON de agentes/herramientas/MCP.
- Panel de crédito y uso de OpenRouter; buscadores web configurables (Exa/Brave/Tavily); lectura web vía Jina Reader con reserva (*fallback*) a Wayback Machine.
- Autenticación opcional multiusuario (JWT) o modo local sin login.
- UI completamente responsive: cajón lateral (*drawer*), barra inferior, *sheets*, compositor consciente del teclado móvil.

---

## Arquitectura

Despliegue dividido: **frontend estático en Vercel** + **API en Railway** (o todo local en desarrollo). El backend es **solo API**: no sirve ningún fichero estático.

```text
┌─────────────────────────┐         ┌──────────────────────────────┐
│  Frontend (Vercel/local) │  /api   │      Backend API (Express)    │
│  React 18 · Vite · Zustand│◄──────►│  :3001 (dev) / PORT (Railway) │
│  http://localhost:5173   │  SSE    │  better-sqlite3 (WAL)         │
└─────────────────────────┘         └──────────┬───────────────────┘
                                               │
                    ┌──────────────────────────┼─────────────────────────┐
                    ▼                          ▼                         ▼
        ┌──────────────────────┐   ┌────────────────────┐   ┌─────────────────────────┐
        │ Proveedores LLM       │   │  Agente local (WS)  │   │ Servicios externos       │
        │ OpenRouter/DeepSeek/  │   │  Tu PC emparejado:  │   │ E2B · Jina Reader ·      │
        │ Codex · llama.cpp     │   │  comandos, ficheros,│   │ Exa/Brave/Tavily ·       │
        │                       │   │  llama-server, MCP  │   │ Wayback · OpenRouter     │
        └──────────────────────┘   └────────────────────┘   └─────────────────────────┘
```

- **Frontend → backend**: REST + streaming **SSE leído a mano sobre `fetch`** (sin EventSource ni WebSocket en el cliente). El WebSocket del servidor (`/api/agent/connect`) existe solo para el agente local emparejado.
- **Estado del stream** por conversación en el cliente (`streamsByConversation`): puedes cambiar de conversación mientras otra sigue generando.
- **Base de datos**: un único fichero SQLite (WAL) con todas las tablas multiusuario; migraciones idempotentes al arrancar.

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Frontend | React 18, TypeScript, Vite 6, Zustand 5, Framer Motion 11, lucide-react |
| Markdown | react-markdown + remark-gfm + rehype-highlight + highlight.js |
| Backend | Node.js ≥ 20.19, Express 4, TypeScript ejecutado con `tsx` (dev) / `tsc` (prod) |
| Base de datos | SQLite vía better-sqlite3 (modo WAL, síncrona) |
| Tiempo real | SSE (chat) · ws/WebSocket (agente local) |
| Seguridad | bcrypt, jsonwebtoken (HS256), AES-256-GCM, express-rate-limit |
| IA / herramientas | @modelcontextprotocol client/sdk/server, @openai/codex, e2b, jsdom + @mozilla/readability, undici, js-yaml, adm-zip |
| Estilos | CSS artesanal — sistema de diseño "Obsidian Atelier" (solo oscuro) |

Tipografías: Cormorant Garamond (títulos), DM Sans (interfaz), JetBrains Mono (código), cargadas de Google Fonts.

## Requisitos previos

- **Node.js ≥ 20.19.0** (impuesto por `engines` en ambos paquetes).
- Una **clave de OpenRouter** (u otra fuente de modelos) — se configura desde la UI, no por entorno.
- Opcional: claves de E2B, Jina, Exa/Brave/Tavily según las funciones que uses.
- Para el agente local: un PC con Windows (macOS/Linux previsto) y Node ≥ 20.19.

## Inicio rápido (desarrollo)

```bash
npm install

# Arranca backend (:3001) y frontend (:5173) juntos
npm run dev
```

`npm run dev` levanta primero el servidor Express y espera a que responda `http://localhost:3001/api/health` antes de abrir Vite. La app queda en **http://localhost:5173** (Vite hace proxy de `/api` → `http://localhost:3001`).

Scripts individuales: `npm run dev:server`, `npm run dev:client`.

### Primer arranque

Sin configurar nada, el servidor arranca en **modo local**: no hay login y todo pertenece al usuario único `local@localhost`.

1. Abre http://localhost:5173.
2. Entra en **Ajustes** (engranaje de la barra lateral).
3. Conecta tu cuenta de OpenRouter con **Connect** (OAuth PKCE) o pega tu clave manualmente ([crear clave](https://openrouter.ai/settings/keys)).
4. Guarda y crea tu primer agente, o usa el que viene por defecto ("AI Assistant").
5. ¡A chatear!

Configuración por defecto del chat: modelo `openrouter/auto`, temperatura 0.7, máx. 4096 tokens (todo editable en Ajustes → General o por agente/conversación/mensaje).

## Proveedores de modelos

El proveedor se deduce del **prefijo del ID de modelo** (campo de texto libre):

| Prefijo | Proveedor | Autenticación | Notas |
|---|---|---|---|
| *(ninguno)* | **OpenRouter** | Clave de settings (cifrada) | Ej.: `openai/gpt-4o`, `anthropic/claude-sonnet-4.5`, `openrouter/auto`. Soporta *provider routing* (fijar proveedor inferior + fallbacks), plugins PDF y *response healing*. |
| `deepseek:` | **DeepSeek directo** | Clave de settings (cifrada) | Coste calculado localmente con tabla de precios estática; requiere `reasoning_content` en historial de turnos con herramientas. |
| `codex:` | **ChatGPT (Codex)** | Login por device-code, usa tu plan | Sin clave API. Requiere estar en `CODEX_ALLOWED_EMAILS` (vacío = desactivado para todos). Un hilo (*thread*) persistente por conversación; un proceso `codex app-server` por usuario. |
| `llamacpp:` | **llama.cpp local** | Ninguna (loopback) | `llama-server` se lanza en **tu PC** a través del agente emparejado (puerto por defecto 8712). Requiere `LLAMACPP_EXE_PATH` (o configurarlo en Ajustes). Escanea `.gguf` del directorio de modelos (colapsa shards divididos). Presets y muestreo editables; descarga por inactividad (45 min por defecto). |
| `lmstudio:` | *(eliminado)* | — | Stub que siempre responde HTTP 400. LM Studio fue sustituido por llama.cpp. |

Precedencia de configuración (modelo y *provider routing*): **mensaje > conversación > agente > valores generales**.

## Conceptos clave

### Agentes

Un agente es una persona digital: nombre, emoji, descripción, prompt de sistema y configuración completa de generación (modelo, temperatura, máximo de tokens, esfuerzo de razonamiento + máximo de tokens de razonamiento, esquema de salida estructurada, *response healing*, `tool_choice` auto/none, llamadas paralelas, búsqueda web) más los vínculos a herramientas, servidores MCP y skills que puede usar. Se invocan seleccionándolos en "Nuevo chat" o mencionándolos con `@agente` dentro del compositor.

### Conversaciones y árbol de mensajes

Los mensajes forman un **árbol**, no una lista: cada uno tiene `parent_id`, `turn_id` y `variant_seq`. Editar un mensaje de usuario crea una **variante hermana** del mismo turno; el cursor `active_leaf_id` señala la rama visible y se guarda en la BD, así que al volver a abrir la conversación estás donde estabas.

Cada turno nuevo toma un "claim" atómico sobre la conversación (`active_turn_id`): dos pestañas no pueden generar a la vez sobre la misma conversación (la perdedora recibe 409). El asistente se persiste como **borrador** (`generation_status='streaming'`) con escrituras diferidas ≥1 s y se finaliza como `complete`, `error` o `stopped`. Si el navegador se desconecta, el turno sigue en marcha (gracia de 10 min, `CHAT_ORPHAN_TURN_TIMEOUT_MS`) y la pestaña que vuelve lo recupera sondeando `active_turn_id`. Cancelar de verdad exige el botón Stop (`POST /api/chat/stop`) o esperar el timeout de huérfano.

Los títulos se autogeneran con `openrouter/free` (sanitizados ≤80 caracteres, sin filtrar razonamiento); el primero llega además con un título provisional inmediato.

### Chat general

Sin agente asociado: un agente virtual configurable en Ajustes → General (modelo, prompt, herramientas…), ideal para uso suelto.

### Model Council

Ejecución multiestilo Perplexity: tu pregunta viaja **en paralelo a N modelos miembros** (por defecto 3), cada respuesta se guarda (tokens/coste/tiempo), un esquema estructurado compara acuerdos/desacuerdos/hallazgos únicos, y un **modelo sintetizador** redacta la final en streaming. Los miembros pueden usar herramientas (incluidas MCP con su aprobación). Timeouts: 240 s por miembro (1 reintento). Todo queda persistido (`council_runs`, `council_members`, `council_responses`) y puede revisarse después en el chat. Límite de tasa propio: 20 req/15 min. Hay councils preconfigurables desde la vista "Councils" (miembros, sintetizador, plantilla del prompt de síntesis, mostrar respuestas individuales). Diseño detallado en [`MODEL_COUNCIL_DESIGN.md`](./MODEL_COUNCIL_DESIGN.md).

### Herramientas integradas

Diez herramientas disponibles para cualquier agente (sembradas por usuario):

| Herramienta | Qué hace |
|---|---|
| `web_search` | Búsqueda web vía Exa, Brave o Tavily (según `search_api_key`). |
| `web_fetch` | Extrae contenido de URLs: Jina Reader → fetch directo con Readability → Wayback CDX como último recurso; anti-paywall/captcha heurístico, paginación `max_chars`/`offset`. |
| `get_current_time` | Hora actual (la fecha/hora también se inyecta en cada turno de usuario para caché de prefijos). |
| `run_command` | Ejecuta comandos: en tu PC (agente emparejado) o en sandbox **E2B**. Clasificación de peligro por niveles (`shared/commandSafety.ts`): nivel 1 bloqueado siempre; nivel 2 exige confirmación humana. Salida stdout/stderr en streaming. Timeout por defecto 120 s (techo 1800 s). |
| `read_file` / `write_file` / `edit_file` / `delete_file` / `list_directory` | Operaciones de ficheros contra el workspace del agente emparejado (ver [agente local](#el-agente-local-local-agent)): con guardia de lectura previa antes de editar y confirmación humana para borrados peligrosos. Tope de escritura 10 MB. |
| `send_file` | El agente te entrega un fichero descargable (enlace ~72 h). |

Las herramientas personalizadas de tipo **HTTP** permiten GET/POST a tus endpoints con esquema de parámetros (100 KB de respuesta, 30 s, localhost prohibido).

Auditoría: cada ejecución relevante queda en la tabla `tool_executions` (backend usado, exit code, patrón bloqueado, confirmación).

### MCP (Model Context Protocol)

Plataforma cliente completa: registra servidores con transporte **URL** (StreamableHTTP/SSE, con OAuth client-credentials opcional), **stdio** (desactivado salvo `MCP_ALLOW_BACKEND_STDIO=true`; pensado solo para despliegues monousuario de confianza) o **relay** (el servidor MCP vive en tu PC emparejado; sesiones agrupadas con teardown a los 15 min de inactividad).

- Las credenciales se guardan **cifradas** (`mcp:v1:` con AES-256-GCM) y crear/importar servidores **exige `ENCRYPTION_KEY`**.
- Cada llamada a herramienta MCP pide **aprobación humana**: evento SSE `mcp_approval_required` con huella SHA-256 de los argumentos; ventana de 60 s, un solo uso, fail-closed (si nadie aprueba, se deniega; si abortas, se deniega).
- Interruptores explícitos de riesgo: permitir destinos de red privada, permitir HTTP en claro.
- Nombres de herramientas expuestos al modelo con prefijo `mcp_<servidor>__<herramienta>`; revelado progresivo de esquemas cuando hay muchas herramientas (>20 o >3000 tokens).

### Skills

Skills estilo Claude: un directorio con `SKILL.md` (frontmatter YAML: nombre, descripción, licencia, compatibilidad, metadatos, allowed-tools) y recursos. Desde la UI puedes pegar el SKILL.md crudo (con validación previa), rellenar campos estructurados o importar un ZIP (≤20 MB, debe contener SKILL.md). Los bundles viven en disco junto a la BD (`<directorio BD>/skills/<userId>/<skillId>`; límites: 20 MB y 500 ficheros por bundle, 5 MB por recurso).

Activación: vinculadas a un agente/conversación o invocadas con `/skill` en el compositor. Al activarse se inyectan tres herramientas dinámicas: `activate_skill`, `read_skill_resource` y `run_skill_script` (scripts `.py/.sh/.js/.ts/.rb/.ps1` ejecutados vía agente emparejado o E2B, con auditoría y citación entre comillas segura según POSIX/PowerShell). Los choques de nombre con herramientas reservadas se resuelven solos.

### Ejecución de comandos (local vs E2B)

`run_command` admite backend `auto | local | e2b`:
- **local**: pasa por el agente emparejado (tu PC, tus permisos reales — ver seguridad abajo).
- **e2b**: microVM en la nube con tu `e2b_api_key` (con mitigación de firewall de metadatos, cwd `/home/user`, internet configurable).

En ambos casos actúa `shared/commandSafety.ts`, clasificador por niveles compartido por servidor y agente local: nivel 0 libre, nivel 1 bloqueado (fork bombs, formatear disco, `diskpart`, `mkfs`…), nivel 2 con confirmación humana (borrados recursivos fuera del workspace, `git push --force`, borrados de registro, apagado/reinicio). Su propia documentación es clara: **es un cinturón de seguridad, no una sandbox**.

### Archivos

- **Adjuntar PDF** al chat (≤5 × 20 MB, archivo o URL, con motor elegible).
- **Enviar un fichero desde la app a tu PC** (`POST /api/conversations/:id/agent-uploads`, octet-stream ≤100 MB, nombre en cabecera `X-File-Name-B64`): aparece como mensaje de usuario con la ruta donde quedó guardado.
- **Recibir ficheros del agente** (`send_file`): enlace público de descarga no adivinable con caducidad de ~72 h (barrido horario).
- Entrantes al agente: staging en memoria con recogida única en 5 minutos.

### Compartir conversaciones y deep links

Cualquier conversación puede publicarse: se genera un token `nanoid(48)` (se muestra **una vez**, solo se guarda su SHA-256) y una **instantánea congelada** (`snapshot_json`) que ya no cambia aunque sigas chateando. La página pública `/s/:token` es anónima, `noindex`, y responde 404 uniforme para tokens desconocidos/revocados (sin oráculo de existencia). Revocable cuando quieras. Deshabilitado en modo local. Diseño del contrato de la instantánea congelado en `shared/shareTypes.ts` (recorta razonamiento, costes, plomería de herramientas).

## El agente local (`local-agent/`)

Subproyecto independiente (`agent-studio-local-agent`): aplicación de consola que corre **en tu PC** y mantiene una conexión WebSocket persistente con el backend. Es requisito para: `run_command`/ficheros locales, `send_file`/recepción, servidores MCP `relay` y modelos `llamacpp:*`.

```bash
cd local-agent
npm install
npm run build
npm start          # (npm run dev = tsx sin build)
```

Primer arranque = flujo de emparejamiento guiado: URL del backend → carpeta raíz del espacio de trabajo (workspace root) → nombre del dispositivo → código de 8 caracteres generado en **Ajustes → Agente local → Pair a new device** (10 min, un solo uso) → advertencia de seguridad que exige teclear `yes`. El token (mostrado una sola vez; en el servidor solo queda su hash) y la config se guardan en `%APPDATA%\agent-studio-local-agent\config.json` (trátalo como una contraseña).

Detalles importantes:
- Ejecuta con **los permisos de tu cuenta de Windows**; el workspace es una comodidad, no una jaula. Ampliarlo exige editar `allowOutsideWorkspace: true` **en ese fichero local** — nunca remotamente.
- Detección de shell una sola vez por arranque: `pwsh → powershell → cmd.exe` (usa `-EncodedCommand` para robustez de citas).
- Ficheros: `write_file` se niega a sobrescribir y `edit_file` a tocar un fichero no leído antes en la conversación; borrados recursivos grandes (>50 ficheros/50 MB) o fuera del workspace piden confirmación en la consola del agente.
- También ejecuta los `run_skill_script`, aloja servidores MCP relay y lanza/detiene/supervisa `llama-server` (frames dedicados del protocolo), con proxy HTTP de solo-bucle-local (loopback-only) restringido por lista de permitidos (allowlist) (`AGENT_HTTP_PROXY_ALLOW_HOSTS`).
- Sus propios tests: `npm test` dentro de `local-agent/` (8 suites).

Documentación completa y honesta (incluido "qué NO es"): [`local-agent/README.md`](./local-agent/README.md).

## Modelo de seguridad

**Dos modos de autenticación:**

| | Modo local (defecto sin `JWT_SECRET`, o `DISABLE_AUTH=true`) | Modo multiusuario (`JWT_SECRET` puesto) |
|---|---|---|
| Login | No existe; todo es del usuario único `local@localhost` | Registro/login email+contraseña (bcrypt 10; admin bcrypt 12) |
| Token | — | JWT HS256, 7 días, cookie httpOnly `agent_studio_token` **y** body |
| Compartir enlaces | Deshabilitado | Habilitado |
| Registro | Rechazado | Copia las herramientas integradas al nuevo usuario |

Si defines `INITIAL_ADMIN_EMAIL`, al primer arranque con auth se crea ese usuario administrador; su contraseña viene de `INITIAL_ADMIN_PASSWORD` (si no, una aleatoria se imprime **una vez en los logs**). Todos los datos se reasignan del usuario local al admin. Multi-arrendatario (multi-tenant) real: todas las tablas llevan `user_id` y toda consulta está acotada a su dueño; recursos ajenos devuelven 404 uniforme.

**Capas adicionales:**
- **Cifrado en reposo** (AES-256-GCM) de claves sensibles (openrouter/deepseek/search/jina/e2b) con `ENCRYPTION_KEY` (≥32 chars). ⚠️ Si falta o es corta, esas settings se guardan **en claro** (única excepción dura: no podrás crear servidores MCP). Lecturas enmascaradas (`abcd****wxyz`).
- **Rate limiting por IP** (detrás de proxy confiable): 300 req/15 min en `/api`, 60/15 min en `/api/chat`, 20/15 min en `/api/chat/council`.
- **CORS** con lista de permitidos (allowlist) vía `CORS_ORIGIN` (sin ella se permite cualquier origen — solo aceptable en local).
- **Aprobaciones MCP** fail-closed por llamada (arriba).
- **commandSafety** por niveles + confirmaciones humanas en consola del agente; tier 1 sin override.
- **SSRF**: el proxy HTTP del relay solo alcanza `host:port` de la lista de permitidos (`AGENT_HTTP_PROXY_ALLOW_HOSTS`); localhost prohibido en herramientas HTTP personalizadas; `web_fetch` valida URLs con zod.
- Tokens de agente local: aleatorios de 32 bytes, mostrados una vez, solo hash SHA-256 en BD; revocables desde la UI.

## Variables de entorno

Todas opcionales salvo indicación. `.env.example` está totalmente comentado. Precedencia general en llamacpp: **setting de UI > variable de entorno > defecto**.

**Frontend (Vercel / build)**

| Variable | Descripción |
|---|---|
| `VITE_API_URL` | URL base del backend **sin barra final ni `/api`** (ej.: `https://mi-api.up.railway.app`). Se hornea en el build: cambiarla exige recompilar. |

**Backend — núcleo**

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP (Railway lo inyecta; no lo fijes allí). |
| `DATABASE_PATH` | `<raíz>/agent-studio.db` | Ruta del SQLite (crea directorios). En producción: `/data/agent-studio.db` con volumen montado. |
| `CORS_ORIGIN` | *(cualquiera)* | Orígenes permitidos separados por comas. |
| `JWT_SECRET` | — | ≥32 chars. Ponerlo activa el login multiusuario; omitirlo = modo local sin login. |
| `DISABLE_AUTH` | `false` | `true` fuerza modo local aunque haya `JWT_SECRET`. |
| `ENCRYPTION_KEY` | — | ≥32 chars. Necesaria para cifrar claves API; **obligatoria de facto para crear/importar servidores MCP**. |
| `INITIAL_ADMIN_PASSWORD` | aleatoria (log) | Contraseña del admin inicial creado al primer arranque con auth. |

**Backend — MCP**

| Variable | Defecto | Descripción |
|---|---|---|
| `MCP_ALLOW_BACKEND_STDIO` | `false` | Permitir transporte stdio alojado en el propio backend. Solo despliegues monousuario de confianza. |
| `MCP_CONNECT_CONCURRENCY` | `4` | Conexiones MCP simultáneas. |
| `MCP_PROGRESSIVE_TOOL_THRESHOLD` | `20` | nº de herramientas a partir del cual se revelan progresivamente. |
| `MCP_PROGRESSIVE_SCHEMA_TOKEN_THRESHOLD` | `3000` | tokens de esquema para revelado progresivo. |
| `MCP_HTTP_RESPONSE_MAX_BYTES` | `16777216` | Tope de bytes por respuesta HTTP MCP (16 MiB). |

**Backend — ChatGPT/Codex**

| Variable | Defecto | Descripción |
|---|---|---|
| `CODEX_ALLOWED_EMAILS` | vacío (= **feature desactivada**) | Emails autorizados a usar el proveedor `codex:`. |
| `CODEX_HOME_ROOT` | `<dir BD>/codex/` | Raíz de los homes aislados por usuario de Codex. |
| `CODEX_IDLE_TIMEOUT_MS` | `1800000` | Reaper del proceso `app-server` inactivo (30 min). |
| `CODEX_TURN_TIMEOUT_MS` | `300000` | Timeout de un turno Codex (5 min). |

**Backend — llama.cpp** (fallbacks; la UI manda)

| Variable | Defecto | Descripción |
|---|---|---|
| `LLAMACPP_EXE_PATH` | *(ninguno)* | Ruta al binario `llama-server`. **Sin ella, Start falla.** |
| `LLAMACPP_MODELS_DIR` | *(ninguno)* | Directorio de `.gguf` (los shards divididos se colapsan a una entrada). |
| `LLAMACPP_PORT` | `8712` | Puerto del `llama-server` local. |
| `LLAMACPP_IDLE_UNLOAD_MINUTES` | `45` | Descarga del modelo por inactividad (`0` = off). |
| `AGENT_HTTP_PROXY_ALLOW_HOSTS` | loopback | `host:port` que el agente remoto puede proxear. ⚠️ cada entrada queda alcanzable por el agente. |

**Diagnóstico (no están en `.env.example`)**: `ENABLE_WS_PROBE=true` + `WS_PROBE_TOKEN` habilitan `/api/agent/ws-probe`, usado por `npm run test:ws-probe` contra un despliegue real. Otros ajustes finos internos existen (`CHAT_ORPHAN_TURN_TIMEOUT_MS`, `RELAY_*`, `CODEX_LOGIN_TTL_MS`, `MCP_META_TOOL_OUTPUT_MAX_CHARS`) pero sus defectos están bien elegidos.

> ⚠️ **Drift documental**: `.env.example` menciona `OPENROUTER_API_KEY` y `SEARCH_API_KEY` como "semilla", pero **el código del servidor actual no las lee**. Las claves se configuran desde la UI de Ajustes (y quedan cifradas en la BD).

## Base de datos

SQLite con **better-sqlite3 en modo WAL** y claves foráneas activadas. Ubicación por defecto: `agent-studio.db` en la raíz del repo (si existe el legacy `kimi-studio.db`, se renombra solo). Todo lo derivado (bundles de skills, ficheros de agentes, homes de codex) se crea **junto al fichero de BD**.

- **Migraciones**: una única función idempotente `migrate()` en cada arranque (`CREATE TABLE IF NOT EXISTS`, guardas `PRAGMA table_info` para `ALTER TABLE`, reconstrucciones completas cuando cambió un CHECK). Sin numeración de migraciones. Un fallo de migración mata el proceso.
- **Autoreparación al arrancar**: borradores `'streaming'` huérfanos → `'error'`; `active_turn_id` limpiado.
- **Semillas**: herramientas integradas por usuario, agente "AI Assistant", usuario `local@localhost`.

Tablas principales: `users`, `settings`, `agents`, `conversations`, `messages` (árbol: `parent_id`,`turn_id`,`variant_seq`,`generation_status`; tokens/costes/razonamiento/anotaciones/adjuntos), `tools`+`agent_tools`+`conversation_tools`, `mcp_servers`+vinculos, `skills`+vínculos, `tool_executions` (auditoría), `paired_agents`, `agent_files`, `conversation_shares`, `council_runs`/`council_members`/`council_responses`.

## Scripts npm

| Script | Qué hace |
|---|---|
| `dev` | Backend + frontend en paralelo (espera al health check del 3001). |
| `dev:server` / `dev:client` | Solo Express (tsx) / solo Vite. |
| `build` | `tsc -b && vite build` (frontend a `dist/`). |
| `build:server` | Compila `server/` + `shared/` a `dist/server` (tsconfig.server.json). |
| `start` | `node dist/server/index.js` (producción). |
| `preview` | Sirve el build de Vite. |
| `test` | Cadena de 31 scripts de test (ver abajo) + `posttest`. |
| `test:mcp` | Los 5 tests de MCP (lo ejecuta `posttest`). |
| `db:restore` | Restaura la BD leyendo bytes crudos de stdin (para subir tu BD local a Railway). |
| `db:migrate-local` | Migra tu `agent-studio.db` local usando el `dist/server/db.js` recién compilado. |
| `test:web-fetch` | Diagnóstico **con red real** del pipeline Jina/fetch/Wayback. |
| `test:ws-probe` | Sonda WebSocket contra un **despliegue real** (requiere `ENABLE_WS_PROBE`). |

Operativos sin alias (en `scripts/`): `check-local-db.mjs` (volcado rápido de la BD local), `reassign-to-local.cjs` (reasignación de filas entre usuarios), `restore-db-to-railway.cmd/.ps1` (pipes de la BD a Railway en Windows).

## Tests

Suite de **integración propia**: 36 scripts TypeScript con `node:assert`, sin framework. Cadena por `&&`: cualquier fallo aborta.

```bash
npm test                # 31 tests + posttest con 5 tests MCP
npx tsx scripts/test-command-safety.ts   # un test concreto
cd local-agent && npm test               # suite del agente local (8 suites)
```

- **Prerrequisitos: ninguno más allá de `npm install`.** Cada test que toca BD fija `DATABASE_PATH` a un fichero temporal *antes* de importar `server/db`; el test de E2B usa dobles (fakes) (sin claves ni red).
- **Fuera de `npm test` a propósito**: `test-message-tree-client.ts` (nota en su cabecera), `test-web-fetch.mjs` y `test-ws-probe.mjs` (red/despliegue real).
- Cobertura por dominios: sincronización de URLs y seguridad, enrutado de proveedores, títulos, overrides de herramientas por conversación, presupuesto de tool-calls, command safety y auditoría de ejecución, E2B (dobles), relay del agente y ficheros, skills (parser/almacén/resolución/activación/scripts/colisiones), MCP (cliente v2, endurecimiento, seguridad de config, integración, aislamiento multiusuario, stdio, relay con servidores reales de `scripts/fixtures/`), llama.cpp (proveedor/relay/transporte/rutas/compuertas de chat), edición de mensajes, supervivencia de turnos y compartición.

## Despliegue en producción

Arquitectura recomendada (y la que automatizan los configs incluidos): **frontend en Vercel + API en Railway**. Guía paso a paso completa (en español) en [`DEPLOY.md`](./DEPLOY.md). Resumen:

**Railway (API)**
- Builder Nixpacks (`nixpacks.toml`, Node 22): `npm ci` → `npm run build:server` → `node dist/server/index.js`.
- Healthcheck: `/api/health` (timeout 120 s); drenaje (draining) 30 s; reinicio ON_FAILURE ×3.
- Variables mínimas: `JWT_SECRET`, `ENCRYPTION_KEY`, `CORS_ORIGIN` (URL de Vercel).
- **Persistencia**: crea un volumen montado exactamente en `/data` y pon `DATABASE_PATH=/data/agent-studio.db`. Sin volumen, la BD vive en disco efímero y **se borra en cada redeploy**.
- `keepAliveTimeout=60s` ya está subido en código para evitar 502 intermitentes del proxy de Railway; si ves 502, revisa puerto destino y healthcheck (ver sección de troubleshooting en DEPLOY.md).
- Subir tu BD local: `npm run build:server && npm run db:migrate-local` y luego `type agent-studio.db | railway run npm run db:restore` (requiere `railway link`).

**Vercel (frontend)**
- Preset Vite: `npm run build`, salida `dist`, rewrite SPA `/(.*) → /index.html`, cabeceras nosniff/DENY/strict-origin.
- Variable: `VITE_API_URL` = URL de la API (sin barra final). Se hornea en el build → redespliega tras cambiarla.

**Verificación**: `/api/health` devuelve `{"status":"ok"}`; Ajustes muestra conexión correcta; envía un mensaje de prueba.

## Estructura del proyecto

```text
├── index.html                  # Entry HTML (fuentes, #root)
├── vite.config.ts              # Vite + proxy /api → :3001
├── tsconfig.json               # App (src, noEmit, strict)
├── tsconfig.server.json        # server+shared → dist/server (emite JS)
├── package.json                # ESM, engines >=20.19, todos los scripts
├── vercel.json                 # SPA + cabeceras de seguridad
├── railway.json / nixpacks.toml# Deploy API en Railway
├── .env.example                # Todas las variables comentadas
│
├── server/                     # Backend Express (solo API)
│   ├── index.ts                # Boot: CORS, rate limits, mounts, WS, shutdown
│   ├── db.ts                   # Esquema SQLite + migraciones idempotentes + semillas
│   ├── crypto.ts               # AES-256-GCM para settings sensibles
│   ├── providerRouting.ts      # Provider preference de OpenRouter
│   ├── chatTurnRegistry.ts     # Registro de turnos vivos (claims/stop/orphans)
│   ├── messageTree.ts          # Semántica del árbol de mensajes
│   ├── conversationTitles.ts   # Títulos automáticos
│   ├── dateTimeContext.ts      # Fecha/hora por turno (cache-friendly)
│   ├── shutdown.ts             # Apagado elegante (SIGTERM/SIGINT)
│   ├── middleware/auth.ts      # JWT cookie/bearer + modo local
│   ├── routes/                 # 21 routers REST (auth, agents, conversations,
│   │                           #  messages, chat(SSE), council, chatgpt, models,
│   │                           #  mcpServers, skills, tools, settings, shares,
│   │                           #  exportImport, credits, usage, agent, agentFiles...)
│   ├── providers/              # Registro de proveedores + llama.cpp (dominio+transporte)
│   ├── tools/                  # registry/resolve/run + execCommand(E2B) +
│   │                           #  fileOps + sendFile + web(jina/fetch/wayback/search)
│   ├── skills/                 # parser SKILL.md, storage, activación dinámica
│   ├── mcp/                    # Cliente MCP v2, config cifrada, relay sessions,
│   │                           #  aprobación humana, ownership
│   ├── agentRelay/             # Protocolo WS zod + registro de conexiones + allowlist SSRF
│   ├── codex/                  # RPC codex app-server, instancias por usuario, chat bridge
│   ├── services/councilExecutor.ts  # Motor del Model Council
│   ├── shares/                 # Instantáneas públicas congeladas
│   ├── agentFiles/             # Almacenamiento TTL + staging entrante
│   └── schemas/ utils/         # Export/import zod, MIME, parse de tool-calls
│
├── src/                        # Frontend React
│   ├── main.tsx / App.tsx      # Entry + routing a mano (/, /c/:id, /s/:token)
│   ├── index.css               # Sistema "Obsidian Atelier" (tokens, temas, tipografías)
│   ├── components/             # ChatView, MessageBubble, Sidebar, SettingsPanel,
│   │   │                       #  AgentEditor, McpView, SkillsView, ToolsView,
│   │   │                       #  Council*(manager/editor/streaming/comparison),
│   │   │                       #  ModelSelectorCore, ProviderRoutingSelector,
│   │   │                       #  ShareDialog, AuthView, ui/ (kit premium)…
│   │   └── mobile/             # TopBar, BottomNav
│   ├── stores/store.ts         # Estado global Zustand único (streams por conversación)
│   ├── api/client.ts           # Cliente REST + streamChat SSE (reintentos 503)
│   ├── api/councilClient.ts    # Cliente SSE del Council
│   ├── hooks/                  # useChat, useTurnReconciliation, useAutoScroll…
│   ├── types/index.ts          # Tipos de dominio completos
│   └── utils/                  # url, threads, providers, llamacppKnobs, pkce…
│
├── shared/                     # Código compartido servidor⇄cliente⇄agente local
│   ├── commandSafety.ts        # Clasificador por niveles de peligro de comandos
│   └── shareTypes.ts           # Contrato wire de instantáneas compartidas (congelado)
│
├── local-agent/                # Subproyecto independiente: agente emparejado (PC)
│   ├── src/                    # transport, commandExecutor, fileOpsExecutor,
│   │                           #  send/receiveFile, mcp, httpProxy, llamaServer,
│   │                           #  shellDetection, config (+ 8 suites de test)
│   └── README.md               # Documentación completa del agente
│
├── scripts/                    # 40+ tests de integración + utilidades operativas
│   └── fixtures/               # Servidores MCP reales para tests de relay
├── public/                     # favicon.svg, noise.svg (textura del tema)
├── skills/                     # (runtime) bundles de skills junto a la BD
├── plans/                      # Documentos de planificación por feature (gitignored)
├── dist/                       # Salida de builds (gitignored)
├── DEPLOY.md                   # Guía de despliegue completa (español)
├── MODEL_COUNCIL_DESIGN.md     # Diseño del Model Council (inglés)
└── agent-studio.db             # SQLite local (gitignored)
```

## Notas y peculiaridades importantes

Cosas que conviene saber antes de tocar nada (todas verificadas en el código):

1. **El servidor no sirve estáticos.** Ni `dist/` ni `public/`: frontend siempre aparte (dev: Vite con proxy; prod: Vercel).
2. **Modo local por defecto.** Sin `JWT_SECRET` no hay login y todo pertenece a `local@localhost` (contraseña 'changeme', irrelevante porque no hay login). Con auth, el admin inicial tiene email fijo en `server/db.ts` — cámbialo ahí si quieres otro.
3. **`ENCRYPTION_KEY` silenciosa.** Si no está, las claves API se guardan en claro y solo sabrás que algo va mal al intentar crear un servidor MCP.
4. **El arranque muta datos**: repara borradores huérfanos, renombra BD legacy, limpia claims de turnos y restos de LM Studio.
5. **Puertos**: API dev 3001, web dev 5173, `llama-server` 8712 (¡no 8080!).
6. **Desconectar no cancela**: la generación continúa hasta 10 min (huérfana) aunque cierres la pestaña; Stop es explícito.
7. **Rate limits por IP** detrás de `trust proxy 1`; detrás de otro proxy en cascada ajústalos.
8. **OpenRouter envía** `HTTP-Referer: http://localhost:5173` y `X-Title: Agent Studio` fijados en código.
9. **Idiomas mixtos**: DEPLOY.md y planes en español; MODEL_COUNCIL_DESIGN.md y comentarios en inglés.
10. **Overrides de express**: `path-to-regexp` fijado a 0.1.13 por compatibilidad con Express 4.
11. **Nixpacks usa Node 22** mientras `engines` pide ≥20.19 — compatible, pero tenlo presente si fijas versiones exactas.
12. **Los enlaces de `send_file` caducan a las ~72 h** y los ficheros entrantes al agente se recogen en 5 min (un solo intento).
13. `plans/` está gitignored: contiene los documentos de diseño por feature (contexto histórico útil).
