export type FormFactor = "desktop" | "laptop";
export type Verdict = "incompatible" | "low" | "recommended" | "ultra";
export type Platform = "desktop" | "laptop" | "integrated";
export type Vendor = "Intel" | "AMD" | "NVIDIA" | "Apple" | "Qualcomm" | "Other";

export interface Component {
  id: string;
  name: string;
  score: number;
  platform: Platform;
  vendor?: Vendor;
  integratedGpuId?: string;
}

export interface TierReq {
  cpuScore: number;
  gpuScore: number;
  ram: number;
}

export interface Game {
  id: string;
  name: string;
  minimum: TierReq;
  recommended: TierReq;
  ultra: TierReq;
}

export interface EvaluateRequest {
  cpuId: string;
  gpuId: string;
  ram: number;
  gameId: string;
  formFactor: FormFactor;
}

export interface EvaluateResponse {
  verdict: Verdict;
  bottleneck: boolean;
  bottleneckMessage?: string;
  userScore: { cpu: number; gpu: number; ram: number; total: number };
  gameDemand: { cpu: number; gpu: number; ram: number; total: number };
  checks: { cpu: boolean; gpu: boolean; ram: boolean };
  platformMismatch?: boolean;
  platformMismatchMessage?: string;
}

export interface EvaluateRawgRequest {
  cpuId: string;
  gpuId: string;
  ram: number;
  formFactor: FormFactor;
  rawgGame: {
    slug: string;
    name: string;
    released: string | null;
    genres: string[];
  };
}

export interface EvaluateRawgResponse extends EvaluateResponse {
  estimated: true;
  rawgName: string;
}
