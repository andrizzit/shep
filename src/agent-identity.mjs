// Codex 0.160 runs hooks in a shared codex app-server whose environment keeps
// the first pane's HERDR_PANE_ID. Herdr can therefore report another Codex
// session on that pane. Claude and Grok hooks run in-process and stay trusted.
export const trustedSession = (provider, sessionId) => provider === 'codex' ? undefined : sessionId;

export function sessionMatches(provider, expected, actual, supplied = false) {
  const sessionId = trustedSession(provider, expected);
  return (supplied ? sessionId == null : !sessionId) || sessionId === actual;
}
