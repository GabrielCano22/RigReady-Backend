import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { cpus } from "../data/cpus";
import { gpus } from "../data/gpus";
import { evaluate } from "../lib/evaluator";
import { estimateTiers } from "../lib/rawgEstimator";
import type { EvaluateRawgResponse, Game } from "../lib/types";

export const evaluateRawgRouter: Router = Router();

const MAX_REASONABLE_RAM_GB = 1024;

const rawgGameSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  released: z.string().nullable(),
  genres: z.array(z.string()),
});

const evaluateRawgSchema = z.object({
  cpuId: z.string().min(1),
  gpuId: z.string().min(1),
  ram: z.number().int().positive().max(MAX_REASONABLE_RAM_GB),
  formFactor: z.enum(["desktop", "laptop"]),
  rawgGame: rawgGameSchema,
});

type EvaluateRawgRequest = z.infer<typeof evaluateRawgSchema>;

/**
 * Pulls the 4-digit year out of a Steam/RAWG release date string.
 * Returns `null` when the date is missing or malformed.
 */
function parseReleasedYear(released: string | null): number | null {
  if (!released || released.length < 4) return null;
  const year = parseInt(released.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Assembles a synthetic `Game` from estimated tiers so the evaluator can run
 * against a Steam search result without needing a curated requirements row.
 */
function buildSyntheticGame(
  rawgGame: EvaluateRawgRequest["rawgGame"],
): Game {
  const { minimum, recommended, ultra } = estimateTiers(
    parseReleasedYear(rawgGame.released),
    rawgGame.genres,
  );
  return {
    id: `rawg:${rawgGame.slug}`,
    name: rawgGame.name,
    minimum,
    recommended,
    ultra,
  };
}

/**
 * `POST /api/evaluate/rawg`
 *
 * Evaluates a rig against a Steam-sourced game whose requirements are
 * estimated from its genres and release year.
 */
evaluateRawgRouter.post("/evaluate/rawg", (req: Request, res: Response) => {
  const parsed = evaluateRawgSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      code: "VALIDATION_ERROR",
      issues: parsed.error.issues,
    });
  }

  const { cpuId, gpuId, ram, formFactor, rawgGame } = parsed.data;

  const cpu = cpus.find((c) => c.id === cpuId);
  if (!cpu) {
    return res
      .status(404)
      .json({ error: `CPU not found: ${cpuId}`, code: "CPU_NOT_FOUND" });
  }

  const gpu = gpus.find((g) => g.id === gpuId);
  if (!gpu) {
    return res
      .status(404)
      .json({ error: `GPU not found: ${gpuId}`, code: "GPU_NOT_FOUND" });
  }

  const result = evaluate({
    cpuScore: cpu.score,
    gpuScore: gpu.score,
    ram,
    game: buildSyntheticGame(rawgGame),
    formFactor,
    cpuPlatform: cpu.platform,
    gpuPlatform: gpu.platform,
  });

  const response: EvaluateRawgResponse = {
    ...result,
    estimated: true,
    rawgName: rawgGame.name,
  };

  return res.json(response);
});
