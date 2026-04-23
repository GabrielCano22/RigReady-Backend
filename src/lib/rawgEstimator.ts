import type { TierReq } from "./types";

export function estimateTiers(
  releasedYear: number | null,
  genres: string[],
): { minimum: TierReq; recommended: TierReq; ultra: TierReq } {
  // Base by release year
  let baseCpu: number;
  let baseGpu: number;
  let baseRam: number;
  if (releasedYear == null || releasedYear < 2015) {
    baseCpu = 35;
    baseGpu = 25;
    baseRam = 8;
  } else if (releasedYear <= 2019) {
    baseCpu = 50;
    baseGpu = 45;
    baseRam = 12;
  } else if (releasedYear <= 2022) {
    baseCpu = 65;
    baseGpu = 65;
    baseRam = 16;
  } else {
    baseCpu = 75;
    baseGpu = 80;
    baseRam = 16;
  }

  const g = genres.map((x) => x.toLowerCase());
  const hasAny = (...names: string[]): boolean =>
    names.some((n) => g.includes(n));

  if (hasAny("shooter")) {
    baseCpu += 5;
    baseGpu += 5;
  }
  if (hasAny("massively multiplayer", "mmorpg")) {
    baseCpu += 5;
    baseGpu += 5;
  }
  if (hasAny("strategy")) {
    baseCpu += 5;
  }
  if (hasAny("simulation")) {
    baseCpu += 10;
  }
  if (hasAny("racing")) {
    baseCpu += 5;
    baseGpu += 5;
  }
  if (hasAny("fighting")) {
    baseCpu -= 5;
    baseGpu -= 5;
  }
  if (hasAny("platformer")) {
    baseCpu -= 10;
    baseGpu -= 10;
  }
  if (hasAny("indie")) {
    baseCpu -= 15;
    baseGpu -= 15;
  }
  if (hasAny("casual")) {
    baseCpu -= 20;
    baseGpu -= 20;
  }
  if (hasAny("puzzle")) {
    baseCpu -= 25;
    baseGpu -= 25;
  }

  const clamp = (n: number): number => Math.max(15, Math.min(95, n));
  const recCpu = clamp(baseCpu);
  const recGpu = clamp(baseGpu);
  const recRam = baseRam;

  const minimum: TierReq = {
    cpuScore: Math.max(15, recCpu - 15),
    gpuScore: Math.max(15, recGpu - 15),
    ram: Math.max(4, recRam - 4),
  };
  const recommended: TierReq = {
    cpuScore: recCpu,
    gpuScore: recGpu,
    ram: recRam,
  };
  const ultra: TierReq = {
    cpuScore: Math.min(100, recCpu + 15),
    gpuScore: Math.min(100, recGpu + 15),
    ram: Math.max(16, recRam),
  };

  return { minimum, recommended, ultra };
}
