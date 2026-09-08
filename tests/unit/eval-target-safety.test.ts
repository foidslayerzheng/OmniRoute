import test from "node:test";
import assert from "node:assert/strict";

import {
  APPROVED_LOCAL_QWEN_BASE_URL,
  APPROVED_LOCAL_QWEN_CONNECTION_ID,
  APPROVED_LOCAL_QWEN_MODEL,
  APPROVED_LOCAL_QWEN_TARGET,
  resolveSafeEvalExecution,
} from "../../src/lib/evals/targetSafety.ts";

const approvedConnection = {
  id: APPROVED_LOCAL_QWEN_CONNECTION_ID,
  provider: "openai",
  isActive: true,
  defaultModel: "local-qwen",
  providerSpecificData: { baseUrl: APPROVED_LOCAL_QWEN_BASE_URL },
};

const approvedCatalog = () =>
  new Response(JSON.stringify({ data: [{ id: APPROVED_LOCAL_QWEN_MODEL }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const dependencies = {
  getConnection: async () => approvedConnection,
  fetchImpl: async () => approvedCatalog(),
};

async function resolve(overrides: {
  target?: { type: string; id: string | null };
  connection?: Record<string, unknown> | null;
  response?: Response;
}) {
  return resolveSafeEvalExecution(
    overrides.target ?? { type: "model", id: APPROVED_LOCAL_QWEN_TARGET },
    {
      getConnection: async () =>
        Object.prototype.hasOwnProperty.call(overrides, "connection")
          ? (overrides.connection ?? null)
          : approvedConnection,
      fetchImpl: async () => overrides.response ?? approvedCatalog(),
    }
  );
}

test("accepts only the exact approved local connection and served model", async () => {
  const result = await resolve({});
  assert.deepEqual(result, {
    connectionId: APPROVED_LOCAL_QWEN_CONNECTION_ID,
    model: APPROVED_LOCAL_QWEN_TARGET,
    zeroCostVerified: true,
  });
});

test("rejects names, free suffixes, suite defaults, and combos as cost proof", async () => {
  for (const target of [
    { type: "model", id: "local-qwen" },
    { type: "model", id: "openrouter/model:free" },
    { type: "suite-default", id: null },
    { type: "combo", id: "auto/best-free" },
  ]) {
    await assert.rejects(resolve({ target }), /restricted to model target/);
  }
});

test("fails closed when any authoritative connection field differs", async () => {
  const invalidConnections = [
    { ...approvedConnection, id: "other" },
    { ...approvedConnection, provider: "openrouter" },
    { ...approvedConnection, isActive: false },
    { ...approvedConnection, defaultModel: APPROVED_LOCAL_QWEN_MODEL },
    {
      ...approvedConnection,
      providerSpecificData: { baseUrl: "http://example.com:1234/v1" },
    },
    null,
  ];
  for (const connection of invalidConnections) {
    await assert.rejects(resolve({ connection }), /metadata did not validate/);
  }
});

test("accepts serialized provider metadata but rejects credentials and URL variations", async () => {
  await resolve({
    connection: {
      ...approvedConnection,
      providerSpecificData: JSON.stringify({ baseUrl: APPROVED_LOCAL_QWEN_BASE_URL }),
    },
  });
  for (const baseUrl of [
    "https://100.72.112.61:1234/v1",
    "http://100.72.112.61:1235/v1",
    "http://user:pass@100.72.112.61:1234/v1",
    "http://100.72.112.61:1234/v1?route=other",
    "http://100.72.112.61:1234/other",
  ]) {
    await assert.rejects(
      resolve({
        connection: {
          ...approvedConnection,
          providerSpecificData: { baseUrl },
        },
      }),
      /metadata did not validate/
    );
  }
});

test("fails closed when the model catalog is unavailable, invalid, or missing the model", async () => {
  await assert.rejects(
    resolve({ response: new Response("unavailable", { status: 503 }) }),
    /Could not verify/
  );
  await assert.rejects(
    resolve({
      response: new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    }),
    /invalid model catalog/
  );
  await assert.rejects(
    resolve({
      response: new Response(JSON.stringify({ data: [{ id: "other/model" }] }), {
        status: 200,
      }),
    }),
    /not serving the approved model/
  );
});

test("queries only the approved local model catalog endpoint", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  await resolveSafeEvalExecution(
    { type: "model", id: APPROVED_LOCAL_QWEN_TARGET },
    {
      getConnection: async () => approvedConnection,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method });
        return approvedCatalog();
      },
    }
  );
  assert.deepEqual(requests, [{ url: `${APPROVED_LOCAL_QWEN_BASE_URL}/models`, method: "GET" }]);
});
