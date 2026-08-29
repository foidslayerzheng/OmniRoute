import { isModelUnavailableError } from "../modelFamilyFallback.ts";
import {
  recordModelLockoutFailure,
  type ProviderProfile,
} from "../accountFallback.ts";

export const AUTO_BEST_FREE_COMBO_NAME = "auto/best-free";

/**
 * Persist candidate-specific failures observed by the hard-free virtual combo.
 * This deliberately reuses the model-lock runtime consumed by
 * resilienceCandidateFilter; it does not create a second health registry.
 */
export function recordAutoBestFreeCandidateFailure(options: {
  comboName: string;
  provider: string | null | undefined;
  connectionId: string | null | undefined;
  model: string | null | undefined;
  status: number;
  errorText: string;
  baseCooldownMs: number;
  maxCooldownMs: number;
  profile?: ProviderProfile | null;
  retryAfterMs?: number;
}): boolean {
  const {
    comboName,
    provider,
    connectionId,
    model,
    status,
    errorText,
    baseCooldownMs,
    maxCooldownMs,
    profile = null,
    retryAfterMs = 0,
  } = options;
  if (comboName !== AUTO_BEST_FREE_COMBO_NAME || !provider || !connectionId || !model) {
    return false;
  }

  const modelUnavailable = isModelUnavailableError(status, errorText);
  if (!modelUnavailable && status !== 429) return false;

  const reason = modelUnavailable ? "not_found" : "rate_limit";
  recordModelLockoutFailure(provider, connectionId, model, reason, status, baseCooldownMs, profile, {
    exactCooldownMs: retryAfterMs > 0 ? retryAfterMs : undefined,
    maxCooldownMs,
    exactCooldownIsUpstreamReset: retryAfterMs > 0,
  });
  return true;
}
