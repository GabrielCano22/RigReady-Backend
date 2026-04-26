import "dotenv/config";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { catalogRouter } from "./routes/catalog";
import { evaluateRawgRouter } from "./routes/evaluateRawg";
import { steamRouter } from "./routes/steam";

const DEFAULT_PORT = 4000;
const DEFAULT_ORIGIN = "http://localhost:5173";
const JSON_BODY_LIMIT = "16kb";
const ONE_MINUTE_MS = 60 * 1000;
const API_RATE_LIMIT_PER_MINUTE = 60;
const STEAM_RATE_LIMIT_PER_MINUTE = 20;
const HSTS_MAX_AGE_SECONDS = 31536000;
const PREFLIGHT_CACHE_SECONDS = 600;

const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Resolves the CORS allowlist from environment configuration.
 * Accepts comma-separated origins via `FRONTEND_ORIGIN` (preferred) or the
 * legacy `CORS_ORIGIN`; falls back to the Vite dev server for local work.
 */
function resolveAllowedOrigins(): string[] {
  const raw =
    process.env.FRONTEND_ORIGIN ?? process.env.CORS_ORIGIN ?? DEFAULT_ORIGIN;
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const ALLOWED_ORIGINS = resolveAllowedOrigins();

/**
 * Builds the helmet middleware tuned for a pure JSON API.
 * No HTML is served, so `default-src 'none'` blocks every subresource by
 * default and any accidentally returned HTML becomes inert.
 */
function buildSecurityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: {
      maxAge: HSTS_MAX_AGE_SECONDS,
      includeSubDomains: true,
    },
  });
}

/**
 * CORS origin validator. Requests without an `Origin` header (same-origin,
 * curl, server-to-server) are allowed; everything else must be on the
 * configured allowlist.
 */
function corsOriginCheck(
  origin: string | undefined,
  done: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin || ALLOWED_ORIGINS.includes(origin)) {
    return done(null, true);
  }
  return done(new Error("Not allowed by CORS"));
}

function buildCors() {
  return cors({
    origin: corsOriginCheck,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    maxAge: PREFLIGHT_CACHE_SECONDS,
  });
}

/**
 * Factory for a per-IP rate limiter keyed on the resolved client IP.
 * The tighter Steam limit protects the most expensive endpoint, which
 * drives outbound traffic to the Steam Store API.
 */
function buildRateLimiter(limit: number) {
  return rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "too_many_requests", code: "RATE_LIMITED" },
  });
}

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(buildSecurityHeaders());
app.use(buildCors());
app.use(express.json({ limit: JSON_BODY_LIMIT }));

app.use("/api", buildRateLimiter(API_RATE_LIMIT_PER_MINUTE));
app.use("/api/steam", buildRateLimiter(STEAM_RATE_LIMIT_PER_MINUTE));

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use("/api", catalogRouter);
app.use("/api", evaluateRawgRouter);
app.use("/api/steam", steamRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
});

/**
 * Central error handler. Never leaks stack traces or upstream error text to
 * clients in production; the real error is logged server-side and the
 * response carries only a stable error code.
 */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[error]", message);

  if (message === "Not allowed by CORS") {
    return res.status(403).json({ error: "forbidden", code: "CORS_DENIED" });
  }
  return res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL_ERROR",
    ...(IS_PROD ? {} : { detail: message }),
  });
});

app.listen(PORT, () => {
  console.log(`[rigready-backend] listening on http://localhost:${PORT}`);
  console.log(
    `[rigready-backend] CORS allowlist: ${ALLOWED_ORIGINS.join(", ")}`,
  );
});
