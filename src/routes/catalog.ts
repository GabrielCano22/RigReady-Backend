import { Router, type Request, type Response } from "express";
import { cpus } from "../data/cpus";
import { gpus } from "../data/gpus";
import type { Component, Platform } from "../lib/types";

export const catalogRouter: Router = Router();

type FormFactor = "desktop" | "laptop";

/**
 * Narrows an arbitrary query-string value to a supported form factor or `null`
 * when the caller did not ask to filter.
 */
function parseFormFactor(value: unknown): FormFactor | null {
  return value === "desktop" || value === "laptop" ? value : null;
}

/**
 * Returns the GPU platforms that are valid choices for a given form factor.
 * Integrated GPUs are always allowed because they ship on both desktop CPUs
 * and mobile chipsets.
 */
function platformsForFormFactor(formFactor: FormFactor): Platform[] {
  return formFactor === "desktop"
    ? ["desktop", "integrated"]
    : ["laptop", "integrated"];
}

function sortByScoreDesc<T extends Component>(list: T[]): T[] {
  return [...list].sort((a, b) => b.score - a.score);
}

catalogRouter.get("/cpus", (req: Request, res: Response) => {
  const formFactor = parseFormFactor(req.query.platform);
  const filtered = formFactor
    ? cpus.filter((cpu) => cpu.platform === formFactor)
    : cpus;
  res.json(sortByScoreDesc(filtered));
});

catalogRouter.get("/gpus", (req: Request, res: Response) => {
  const formFactor = parseFormFactor(req.query.platform);
  if (!formFactor) {
    res.json(sortByScoreDesc(gpus));
    return;
  }
  const allowed = platformsForFormFactor(formFactor);
  const filtered = gpus.filter((gpu) => allowed.includes(gpu.platform));
  res.json(sortByScoreDesc(filtered));
});
