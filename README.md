# RigReady Backend

API de evaluación de compatibilidad PC / videojuego construida en **Node.js + Express + TypeScript**. Recibe el hardware del usuario (CPU, GPU, RAM, form factor) y un juego objetivo, y devuelve un veredicto preciso (Mínimo / Recomendado / Ultra) junto con detección de cuellos de botella CPU↔GPU.

Es el motor de cálculo detrás de [RigReady](https://github.com/GabrielCano22/RigReady).

---

## Tabla de contenido

- [Stack técnico](#stack-técnico)
- [Arquitectura](#arquitectura)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Endpoints](#endpoints)
- [Motor de evaluación](#motor-de-evaluación)
- [Integración con Steam](#integración-con-steam)
- [Seguridad](#seguridad)
- [Variables de entorno](#variables-de-entorno)
- [Puesta en marcha](#puesta-en-marcha)
- [Scripts](#scripts)
- [Flujo de trabajo Git](#flujo-de-trabajo-git)

---

## Stack técnico

| Categoría | Tecnología |
|---|---|
| Runtime | Node.js 20+ |
| Framework HTTP | Express 5 |
| Lenguaje | TypeScript (modo estricto) |
| Validación | Zod |
| Seguridad | Helmet, CORS, express-rate-limit |
| Datos | Datasets normalizados de PassMark (CPUs y GPUs) |
| Integración externa | Steam Store API (búsqueda y detalles de juegos) |

---

## Arquitectura

```
┌──────────────┐      HTTP        ┌────────────────────┐
│  Frontend    │ ───────────────► │ Express (hardened) │
│  (React SPA) │                  │ helmet + cors + RL │
└──────────────┘                  └─────────┬──────────┘
                                            │
                        ┌───────────────────┼────────────────────┐
                        ▼                   ▼                    ▼
                 /api/cpus            /api/evaluate        /api/steam/*
                 /api/gpus            /rawg                      │
                 (catálogo)           (zod + evaluator)          ▼
                                                           Steam Store API
                                                           (con cache TTL)
```

Capa de presentación (rutas Express) → capa de dominio (`lib/evaluator`, `lib/rawgEstimator`) → capa de datos (datasets estáticos de `data/`). Sin base de datos: el catálogo de hardware vive en memoria, sembrado desde los dumps crudos de PassMark en `scripts/data/`.

---

## Estructura del proyecto

```
RigReady-Backend/
├── src/
│   ├── index.ts                # Entry point: Express + middlewares de seguridad
│   ├── routes/
│   │   ├── catalog.ts          # GET /api/cpus, GET /api/gpus
│   │   ├── steam.ts            # Proxy Steam con cache y sanitización
│   │   └── evaluateRawg.ts     # POST /api/evaluate/rawg
│   ├── lib/
│   │   ├── types.ts            # Tipos del dominio
│   │   ├── evaluator.ts        # Motor de evaluación por tiers y bottleneck
│   │   └── rawgEstimator.ts    # Estimador de requisitos por género + año
│   └── data/
│       ├── cpus.ts             # Catálogo normalizado de CPUs
│       └── gpus.ts             # Catálogo normalizado de GPUs
├── scripts/
│   ├── seed-hardware.ts        # Genera data/cpus.ts y data/gpus.ts desde JSON crudo
│   └── data/
│       ├── cpu_mega.json       # Dump crudo PassMark CPU
│       └── gpu_mega.json       # Dump crudo PassMark GPU
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Endpoints

### `GET /api/health`

Healthcheck liviano para probes de orquestador.

```json
{ "status": "ok" }
```

### `GET /api/cpus?platform=desktop|laptop`

Devuelve el catálogo de CPUs ordenado por `score` descendente. `platform` es opcional; sin filtro devuelve todo.

```json
[
  { "id": "i9-14900K", "name": "Intel Core i9-14900K", "score": 59821, "platform": "desktop" },
  { "id": "ryzen-9-7950x", "name": "AMD Ryzen 9 7950X", "score": 58210, "platform": "desktop" }
]
```

### `GET /api/gpus?platform=desktop|laptop`

Mismo contrato que `/api/cpus`. Las GPUs integradas siempre se incluyen (sirven para ambos form factors).

### `GET /api/steam/search?q=<término>`

Búsqueda de juegos contra la Steam Store API. Query obligatoria, 2–100 caracteres, sanitizada contra caracteres de control y zero-width. Respuesta recortada a los 10 primeros resultados Windows-compatibles.

```json
{
  "results": [
    {
      "id": 1245620,
      "slug": "1245620",
      "name": "ELDEN RING",
      "released": null,
      "background_image": "https://.../header.jpg",
      "rating": 0,
      "genres": []
    }
  ]
}
```

### `GET /api/steam/game/:slug`

Detalles de un juego por `appid` numérico. El `slug` se valida contra `/^\d+$/` antes de construir la URL upstream (bloquea SSRF).

### `POST /api/evaluate/rawg`

Evalúa un rig contra un juego de Steam cuyas specs se estiman a partir de género y año.

```jsonc
// Request
{
  "cpuId": "i9-14900K",
  "gpuId": "rtx-4090",
  "ram": 32,
  "formFactor": "desktop",
  "rawgGame": {
    "slug": "1245620",
    "name": "ELDEN RING",
    "released": "2022-02-25",
    "genres": ["Action", "RPG"]
  }
}
```

```jsonc
// Response (resumido)
{
  "verdict": "ultra",
  "bottleneck": "none",
  "tiers": { "minimum": true, "recommended": true, "ultra": true },
  "estimated": true,
  "rawgName": "ELDEN RING"
}
```

---

## Motor de evaluación

`lib/evaluator.ts` resuelve tres tiers (Mínimo, Recomendado, Ultra) comparando el `score` PassMark del CPU y GPU del usuario contra el score requerido por el juego. El veredicto se reporta al tier más alto que el rig satisface.

Reglas adicionales:

- **RAM**: cada tier tiene un piso de RAM; no se pasa al siguiente tier si la RAM es insuficiente.
- **Form factor**: GPUs `desktop` solo aplican a CPUs `desktop`; las `laptop` solo a CPUs `laptop`. Las integradas son comodín.
- **Bottleneck**: si la brecha relativa entre CPU y GPU supera un umbral, se marca `cpu-bound` o `gpu-bound`.

### Estimador RAWG

`lib/rawgEstimator.ts` deriva un set sintético de requisitos (mínimo, recomendado, ultra) a partir del género y el año de lanzamiento, permitiendo evaluar cualquier juego de Steam sin necesidad de una fila curada de requisitos. Los pesos de género se calibraron a mano para alinearse con los requisitos reales publicados.

---

## Integración con Steam

El router `routes/steam.ts` actúa como proxy delgado sobre la API pública de Steam Store con:

- **Cache TTL** en memoria (10 minutos) por URL — reduce dramáticamente el hit a Steam.
- **Timeout duro** de 5 segundos con `AbortController`.
- **Sanitización de query**: se eliminan caracteres de control ASCII y zero-width (U+200B..U+200F, U+2028..U+202F) antes de `encodeURIComponent`.
- **Anti-SSRF**: el `slug` del endpoint de detalles debe ser un `appid` numérico (`/^\d+$/`). Cualquier otra entrada se rechaza antes de la llamada de red.
- **Whitelisting**: la URL upstream se compone de constantes hardcodeadas + query codificada; imposible redirigir a otro host.

---

## Seguridad

El entry point `src/index.ts` aplica, en orden:

1. **Helmet** con HSTS (1 año, `includeSubDomains`, `preload`).
2. **CORS con allowlist** derivada de `FRONTEND_ORIGIN` (coma-separada). Request sin origin permitido solo en `NODE_ENV=development`.
3. **Trust proxy** = 1 (para que rate-limit vea la IP real detrás de un LB).
4. **`x-powered-by`** deshabilitado.
5. **Body limit** de 16 kB — protege contra payload bombs.
6. **Rate limit**: 60 req/min global en `/api/*`, 20 req/min adicionales en `/api/steam/*`.
7. **Handler central de errores** que oculta stacks en producción.
8. **Zod** valida cada body de POST; fallo → 400 con detalles de issues.

---

## Variables de entorno

Copiar `.env.example` a `.env` y ajustar:

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `4000` | Puerto donde escucha Express. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | Lista coma-separada de orígenes permitidos por CORS. |
| `NODE_ENV` | `development` | En `production` se ocultan stacks y se cierra CORS estrictamente. |
| `RAPIDAPI_KEY` | *(vacío)* | Legacy; no usado actualmente (se sustituyó RAWG por Steam). |

---

## Puesta en marcha

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar entorno
cp .env.example .env

# 3. Desarrollo (hot reload con tsx)
npm run dev

# 4. Build + arranque productivo
npm run build
npm start
```

Servidor disponible en `http://localhost:4000`. Probar con:

```bash
curl http://localhost:4000/api/health
curl "http://localhost:4000/api/cpus?platform=desktop"
```

---

## Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor con recarga en caliente (`tsx watch`). |
| `npm run build` | Compila TypeScript a `dist/`. |
| `npm start` | Ejecuta el build productivo. |
| `npm run seed` | Regenera `src/data/cpus.ts` y `src/data/gpus.ts` desde `scripts/data/*.json`. |
| `npx tsc --noEmit` | Typecheck sin emitir archivos. |

---

## Flujo de trabajo Git

Ramas del repositorio:

- `main` — estable, solo recibe merges desde `prod`.
- `prod` — producción.
- `qa` — rama de QA / staging.
- `dev` — integración. **Toda feature parte de aquí.**
- `feat/<accion>` — ramas de feature; PR con título `feat: <accion>` contra `dev`.

Convenciones de commit: `feat: <descripción>` en español, una línea de título + cuerpo explicativo cuando aplique.

---

## Autor

Proyecto desarrollado por [Gabriel Cano](https://github.com/GabrielCano22).
