import { test, after } from "node:test";
import assert from "node:assert/strict";

const { registerHook, unregisterHook } = await import("../../src/lib/plugins/hooks.ts");
const { runPluginOnRequestHook } = await import(
  "../../open-sse/handlers/chatCore/pluginOnRequest.ts"
);
const { runPluginOnResponseHook } = await import(
  "../../open-sse/handlers/chatCore/pluginOnResponse.ts"
);

after(() => unregisterHook("onResponse", "metadata-continuity-test"));

test("onResponse receives the same sanitized metadata object established for the request", async () => {
  let captured: Record<string, unknown> | undefined;
  registerHook("onResponse", "metadata-continuity-test", async (ctx: Record<string, unknown>) => {
    captured = ctx;
    return {};
  });
  const metadata = {
    __langfuseSampled: true,
    __langfuseStart: 1234,
    taskClass: "coding",
    selectionReason: "preferred-free-model",
  };

  await runPluginOnResponseHook({
    requestId: "req-correlation",
    body: { model: "local-qwen", messages: [] },
    model: "local-qwen",
    provider: "local-qwen",
    apiKeyInfo: null,
    metadata,
    response: { status: 200, data: { choices: [] } },
  });

  const deadline = Date.now() + 2000;
  while (!captured && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(captured);
  assert.equal(captured.metadata, metadata);
  assert.equal(Object.hasOwn(metadata, "authorization"), false);
  assert.equal(Object.hasOwn(metadata, "apiKeyInfo"), false);
  assert.equal(Object.hasOwn(metadata, "body"), false);
});

test("concurrent request metadata remains isolated", async () => {
  const pluginName = "metadata-isolation-test";
  registerHook("onRequest", pluginName, async (ctx: Record<string, unknown>) => ({
    metadata: { correlation: ctx.requestId },
  }));
  try {
    const args = (requestId: string) => ({
      requestId,
      body: { messages: [] },
      model: "local-qwen",
      provider: "local-qwen",
      apiKeyInfo: { id: "key-id" },
    } as Parameters<typeof runPluginOnRequestHook>[0]);
    const [a, b] = await Promise.all([
      runPluginOnRequestHook(args("request-A")),
      runPluginOnRequestHook(args("request-B")),
    ]);
    assert.equal(a.blocked, false);
    assert.equal(b.blocked, false);
    if (a.blocked || b.blocked) return;
    assert.notEqual(a.metadata, b.metadata);
    assert.deepEqual(a.metadata, { correlation: "request-A" });
    assert.deepEqual(b.metadata, { correlation: "request-B" });
  } finally {
    unregisterHook("onRequest", pluginName);
  }
});
