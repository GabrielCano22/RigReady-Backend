import type {
  EvaluateResponse,
  FormFactor,
  Game,
  Platform,
  Verdict,
} from "./types";

const CPU_SCALE = 3.33;
const GPU_SCALE = 3.33;
const RAM_SCALE = 5.21;
const COMPONENT_CAP = 333;
const TOTAL_CAP = 1000;
const LAPTOP_DESKTOP_GPU_MULTIPLIER = 0.75;
const BOTTLENECK_THRESHOLD = 25;

function capComponent(value: number): number {
  return Math.min(Math.round(value), COMPONENT_CAP);
}

function meetsTier(
  cpu: number,
  gpu: number,
  ram: number,
  tier: { cpuScore: number; gpuScore: number; ram: number },
): boolean {
  return cpu >= tier.cpuScore && gpu >= tier.gpuScore && ram >= tier.ram;
}

export interface EvaluateInput {
  cpuScore: number;
  gpuScore: number;
  ram: number;
  game: Game;
  formFactor: FormFactor;
  /** Optional — when provided, enables platform-aware laptop multiplier + mismatch detection. */
  cpuPlatform?: Platform;
  gpuPlatform?: Platform;
}

export function evaluate(input: EvaluateInput): EvaluateResponse {
  const { cpuScore, gpuScore, ram, game, formFactor, cpuPlatform, gpuPlatform } =
    input;

  // Platform-aware effective GPU score:
  //   - Integrated GPU: score already reflects the chip — no multiplier.
  //   - Laptop form-factor + DESKTOP GPU: penalize with 0.75 (unrealistic combo).
  //   - Laptop form-factor + LAPTOP GPU: no multiplier (score already mobile-calibrated).
  //   - When platform metadata is missing (legacy callers), fall back to the
  //     old behavior: 0.75 whenever formFactor === "laptop".
  let effectiveGpu: number;
  if (gpuPlatform === "integrated") {
    effectiveGpu = gpuScore;
  } else if (gpuPlatform === "laptop") {
    effectiveGpu = gpuScore;
  } else if (gpuPlatform === "desktop" && formFactor === "laptop") {
    effectiveGpu = gpuScore * LAPTOP_DESKTOP_GPU_MULTIPLIER;
  } else if (gpuPlatform === undefined && formFactor === "laptop") {
    effectiveGpu = gpuScore * LAPTOP_DESKTOP_GPU_MULTIPLIER;
  } else {
    effectiveGpu = gpuScore;
  }

  // 1. Verdict
  let verdict: Verdict;
  if (
    cpuScore < game.minimum.cpuScore ||
    effectiveGpu < game.minimum.gpuScore ||
    ram < game.minimum.ram
  ) {
    verdict = "incompatible";
  } else if (meetsTier(cpuScore, effectiveGpu, ram, game.ultra)) {
    verdict = "ultra";
  } else if (meetsTier(cpuScore, effectiveGpu, ram, game.recommended)) {
    verdict = "recommended";
  } else {
    verdict = "low";
  }

  // 2. Bottleneck (only when both are above minimum tier)
  let bottleneck = false;
  let bottleneckMessage: string | undefined;
  const bothAboveMin =
    cpuScore >= game.minimum.cpuScore && effectiveGpu >= game.minimum.gpuScore;
  if (bothAboveMin) {
    const diff = Math.abs(cpuScore - effectiveGpu);
    if (diff >= BOTTLENECK_THRESHOLD) {
      bottleneck = true;
      if (cpuScore < effectiveGpu) {
        bottleneckMessage = "Your CPU might bottleneck your GPU in this game.";
      } else {
        bottleneckMessage = "Your GPU might bottleneck your CPU in this game.";
      }
    }
  }

  // 3. Scoring (0-1000 total, 333 per component cap)
  const userCpu = capComponent(cpuScore * CPU_SCALE);
  const userGpu = capComponent(effectiveGpu * GPU_SCALE);
  const userRam = capComponent(Math.min(ram, 64) * RAM_SCALE);
  const userTotal = Math.min(userCpu + userGpu + userRam, TOTAL_CAP);

  const demandCpu = capComponent(game.recommended.cpuScore * CPU_SCALE);
  const demandGpu = capComponent(game.recommended.gpuScore * GPU_SCALE);
  const demandRam = capComponent(
    Math.min(game.recommended.ram, 64) * RAM_SCALE,
  );
  const demandTotal = Math.min(demandCpu + demandGpu + demandRam, TOTAL_CAP);

  // 4. Checks vs recommended tier
  const checks = {
    cpu: cpuScore >= game.recommended.cpuScore,
    gpu: effectiveGpu >= game.recommended.gpuScore,
    ram: ram >= game.recommended.ram,
  };

  // 5. Platform mismatch detection (metadata-driven)
  let platformMismatch = false;
  let platformMismatchMessage: string | undefined;
  if (cpuPlatform && gpuPlatform) {
    const cpuIsMobile = cpuPlatform === "laptop";
    const gpuIsDedicatedDesktop = gpuPlatform === "desktop";
    const gpuIsDedicatedLaptop = gpuPlatform === "laptop";

    if (formFactor === "laptop" && gpuIsDedicatedDesktop) {
      platformMismatch = true;
      platformMismatchMessage =
        "You selected a desktop GPU on a laptop — estimate may be inaccurate.";
    } else if (formFactor === "desktop" && gpuIsDedicatedLaptop) {
      platformMismatch = true;
      platformMismatchMessage =
        "You selected a laptop GPU on a desktop — estimate may be inaccurate.";
    } else if (formFactor === "desktop" && cpuIsMobile) {
      platformMismatch = true;
      platformMismatchMessage =
        "You selected a laptop CPU on a desktop — estimate may be inaccurate.";
    } else if (formFactor === "laptop" && cpuPlatform === "desktop") {
      platformMismatch = true;
      platformMismatchMessage =
        "You selected a desktop CPU on a laptop — estimate may be inaccurate.";
    }
  }

  const response: EvaluateResponse = {
    verdict,
    bottleneck,
    userScore: { cpu: userCpu, gpu: userGpu, ram: userRam, total: userTotal },
    gameDemand: {
      cpu: demandCpu,
      gpu: demandGpu,
      ram: demandRam,
      total: demandTotal,
    },
    checks,
  };

  if (bottleneckMessage) {
    response.bottleneckMessage = bottleneckMessage;
  }
  if (platformMismatch) {
    response.platformMismatch = true;
    response.platformMismatchMessage = platformMismatchMessage;
  }

  return response;
}
