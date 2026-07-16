/** Shared app types for generation state and OpenCode bridge payloads. */

export interface GenerationState {
  isGenerating: boolean;
  tokenCount: number;
  opacity: number;
  panelOpen: boolean;
  settingsOpen: boolean;
  showTokenCount: boolean;
  userIntensity: number;
  particleSpeed: number;
  motionAngle: number;
  motionSpread: number;
  /** Who last drove the generation state */
  source: "manual" | "opencode";
  /** True while a live OpenCode session owns show/hide */
  liveSessionActive: boolean;
  /** If true, hide window after live generation_end */
  autoHideOnEnd: boolean;
  lastModel: string | null;
  lastProvider: string | null;
  lastSessionId: string | null;
  bridgeConnected: boolean;
  eventPort: number | null;
}

export type GenerationEvent =
  | { type: "start" }
  | { type: "stop" }
  | { type: "tokens"; count: number };

/** Payload for generation_start from Python monitor */
export interface GenerationStartData {
  provider?: string | null;
  model?: string | null;
  session_id?: string | null;
  [key: string]: unknown;
}

/** Token breakdown from OpenCode logs */
export interface TokenBreakdown {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
  total?: number;
  tokens?: number;
  final_tokens?: TokenBreakdown | Record<string, number>;
  [key: string]: unknown;
}

export interface GenerationEndData extends TokenBreakdown {
  session_id?: string | null;
  final_tokens?: TokenBreakdown | Record<string, number>;
}

export interface ServerReadyPayload {
  port: number;
  url: string;
}
