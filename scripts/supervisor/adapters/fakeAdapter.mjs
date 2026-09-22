import { randomUUID } from "node:crypto";

export class FakeHermesAdapter {
  constructor(responses = []) {
    this.responses = [...responses];
    this.sentTasks = [];
    this.tasks = new Map();
  }

  async send_task(task) {
    const handle = `fake-${randomUUID()}`;
    this.sentTasks.push(structuredClone(task));
    this.tasks.set(handle, { result: this.responses.shift(), cancelled: false });
    return handle;
  }

  async poll_status(handle) {
    const task = this.tasks.get(handle);
    if (!task) return { status: "unknown" };
    return { status: task.cancelled ? "cancelled" : "complete" };
  }

  async wait_for_result(handle) {
    const task = this.tasks.get(handle);
    if (!task) throw new Error("Unknown fake adapter handle");
    if (task.result instanceof Error) throw task.result;
    return task.result;
  }

  async cancel_task(handle) {
    const task = this.tasks.get(handle);
    if (!task) return { status: "unknown" };
    task.cancelled = true;
    return { status: "cancelled" };
  }

  async health_check() {
    return { status: "healthy" };
  }
}
