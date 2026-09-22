const APPROVAL_PATTERNS = [
  /\bproduction\b.*\b(restart|deploy|switch|write|migration?)\b/i,
  /\b(restart|deploy|switch|write|migration?)\b.*\bproduction\b/i,
  /\b(database|db)\b.*\b(write|migration?|modify)\b/i,
  /\b(secret|token|key|credential)\b.*\b(access|read|show)\b/i,
  /\b(paid|spend|billing|firewall|network security)\b/i,
  /\b(git reset|force push|delete important)\b/i,
];

function resultText(result) {
  return [
    result.task,
    result.next_action,
    result.blocker,
    ...(result.changes ?? []),
    ...(result.tests ?? []),
  ]
    .filter(Boolean)
    .join("\n");
}

export function classifyPermission(state, result) {
  const text = resultText(result);
  const forbidden = state.forbidden_actions.find(
    (item) => item && text.toLowerCase().includes(item.toLowerCase())
  );
  const outOfScope = /\b(unrelated architecture|bypass supervisor|ignore (?:scope|policy))\b/i.test(
    text
  );
  if (forbidden || outOfScope) {
    return {
      decision: "FORBIDDEN",
      reason: forbidden ? `Forbidden context: ${forbidden}` : "Outside task scope",
    };
  }
  if (result.requires_approval || APPROVAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return { decision: "REQUIRES_USER_APPROVAL", reason: "Risky action requires Louis approval" };
  }
  return { decision: "AUTO_CONTINUE", reason: "Action is within the bounded task" };
}
