import { build } from "./utils.js";
import { type CircuitState, circuitStore } from "../../lib/routerEval/index.js";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeoutMs: number;
}

export class ZeroInferenceCircuitManager {
  private readonly statePath: string;
  private readonly config: Required<CircuitBreakerConfig>;
  private readonly forceNoOp: boolean;

  constructor(statePath: string, config: CircuitBreakerConfig, forceNoOp?: boolean) {
    this.statePath = statePath;
    this.config = {
      failureThreshold: config.failureThreshold,
      recoveryTimeoutMs: config.recoveryTimeoutMs,
    };
    this.forceNoOp = forceNoOp ?? false;
  }

  private async loadState(): Promise<CircuitState> {
    try {
      const content = await build.readFile(this.statePath);
      return JSON.parse(content);
    } catch {
      return { failures: 0, lastFailureTime: null, totalRequests: 0 };
    }
  }

  private async saveState(state: CircuitState): Promise<void> {
    try {
      const content = JSON.stringify(state, null, 2);
      await build.writeFile(this.statePath, content);
    } catch {}
  }

  async beforeRequest(method?: string): Promise<boolean> {
    if (this.forceNoOp) {
      return true;
    }

    let state: CircuitState = await this.loadState();

    // On request arrival, increment total requests counter
    state.totalRequests += 1;

    // If there was a recent failure within recovery window, reset on successful request
    const now = Date.now();
    if (state.lastFailureTime) {
      const timeSinceLastFailure = now - state.lastFailureTime;
      if (timeSinceLastFailure < this.config.recoveryTimeoutMs) {
        // Successful request during recovery window - reset circuit
        state.failures = 0;
        state.lastFailureTime = null;
        await this.saveState(state);
      }
    }

    // Check if circuit is open (failures >= threshold)
    if (state.failures >= this.config.failureThreshold) {
      return false;
    }

    return true;
  }

  async afterError(method: string, error?: unknown): Promise<void> {
    if (this.forceNoOp) {
      return;
    }

    let state: CircuitState = await this.loadState();

    // Increment failure count
    state.failures += 1;
    state.lastFailureTime = Date.now();

    // Save updated state
    await this.saveState(state);
  }
}
