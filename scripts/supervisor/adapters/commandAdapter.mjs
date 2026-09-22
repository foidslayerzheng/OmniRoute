import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CommandHermesAdapter {
  constructor({ executable, args = [], timeoutMs = 30_000, maxOutputBytes = 65_536 } = {}) {
    if (!executable) throw new Error("An explicit Hermes executable is required");
    this.executable = executable;
    this.args = [...args];
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.tasks = new Map();
  }

  async send_task(task) {
    const handle = `command-${randomUUID()}`;
    const promise = execFileAsync(this.executable, [...this.args, task.prompt], {
      shell: false,
      timeout: this.timeoutMs,
      maxBuffer: this.maxOutputBytes,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    })
      .then(({ stdout }) => stdout)
      .catch((error) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw new Error("Hermes command output limit exceeded");
        }
        if (error?.killed) throw new Error("Hermes command timed out");
        throw new Error(`Hermes command failed: ${String(error?.message ?? error).slice(0, 500)}`);
      });
    this.tasks.set(handle, promise);
    return handle;
  }

  async poll_status(handle) {
    return this.tasks.has(handle) ? { status: "unsupported" } : { status: "unknown" };
  }

  async wait_for_result(handle) {
    if (!this.tasks.has(handle)) throw new Error("Unknown command adapter handle");
    return this.tasks.get(handle);
  }

  async cancel_task(handle) {
    return this.tasks.has(handle) ? { status: "unsupported" } : { status: "unknown" };
  }

  async health_check() {
    try {
      await access(this.executable, constants.X_OK);
      return { status: "healthy" };
    } catch {
      return { status: "unhealthy" };
    }
  }
}
