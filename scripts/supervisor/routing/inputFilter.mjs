function selectedIds(decision, allowed, required) {
  if (decision.fallback) return new Set(allowed.map((item) => item.id));
  const allowedIds = new Set(allowed.map((item) => item.id));
  return new Set([...decision.selected.filter((id) => allowedIds.has(id)), ...required]);
}

export async function filterRoutingInputs(input) {
  const contexts = input.contexts ?? [];
  const tools = input.tools ?? [];
  const requiredContext = new Set([
    ...(input.required_context_ids ?? []),
    ...contexts.filter((item) => item.required).map((item) => item.id),
  ]);
  const requiredTools = new Set([
    ...(input.required_tool_ids ?? []),
    ...tools.filter((item) => item.required).map((item) => item.id),
  ]);
  const [contextDecision, toolDecision] = await Promise.all([
    input.jev.selectContext({
      task_description: input.task_description,
      available: contexts.map(({ id }) => id),
      required: [...requiredContext],
    }),
    input.jev.selectTools({
      task_description: input.task_description,
      available: tools.map(({ id }) => id),
      required: [...requiredTools],
    }),
  ]);
  const contextIds = selectedIds(contextDecision, contexts, requiredContext);
  const toolIds = selectedIds(toolDecision, tools, requiredTools);
  const selectedContext = contexts.filter((item) => contextIds.has(item.id));
  const selectedTools = tools.filter((item) => toolIds.has(item.id));
  const bytes = (items) =>
    items.reduce((total, item) => total + Buffer.byteLength(item.content ?? "", "utf8"), 0);
  const originalBytes = bytes(contexts);
  const selectedBytes = bytes(selectedContext);
  return {
    context: selectedContext,
    tools: selectedTools,
    jev: { context: contextDecision, tools: toolDecision },
    metrics: {
      original_context_bytes: originalBytes,
      selected_context_bytes: selectedBytes,
      context_bytes_saved: originalBytes - selectedBytes,
      estimated_tokens_saved: Math.floor((originalBytes - selectedBytes) / 4),
      original_tool_count: tools.length,
      selected_tool_count: selectedTools.length,
      decision_latency_ms: contextDecision.latency_ms + toolDecision.latency_ms,
      fallback: contextDecision.fallback || toolDecision.fallback,
    },
  };
}
