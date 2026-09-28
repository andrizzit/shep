import { LIMITS, MESSAGES as DISPATCH_MESSAGES } from './contracts.mjs';
import { safeText } from '../terminal.mjs';

// Startup and delivery deliberately have no retry path. The immutable target
// receipt stays attached to failed/uncertain outcomes and remote panes stay open.
export function createLaunchRunner(deps) {
  const { assertLive, hasExecutable, KINDS, pinned, fail, randomHex, createTarget, observe,
    fresh, directory, operationLocks, invoke, compareAgent, checkedAgent, outcome,
    reservations, errorCode, trusted, NEEDS_INPUT, UNCERTAIN, messageFor } = deps;
  async function launch(job) {
    const request = job.request;
    const state = { name: request.name };
    const details = () => ({ ...job.ids, stage: job.stage, ...(state.name ? { agentName: state.name } : {}),
      ...(state.pane ? { paneId: state.pane.pane_id, terminalId: state.pane.terminal_id } : {}),
      ...(job.placement ? { placement: structuredClone(job.placement) } : {}), ...(state.created ? { created: structuredClone(state.created) } : {}) });
    const finish = result => {
      job.result = result; job.finished = true;
      const reservation = reservations.get(job.key);
      if (reservation) { reservation.final = true; if (!job.mutated) reservations.delete(job.key); }
      return result;
    };
    try {
      assertLive();
      if (!await hasExecutable(KINDS.get(request.provider).executable, pinned.env)) fail('unavailable_provider');
      state.name ??= `shep-${request.provider.slice(0, 12)}-${randomHex(5)}`;
      await createTarget(job, state);
      const { pane, name } = state;
      await observe(job, 'start');
      const beforeStart = await fresh();
      if (!beforeStart.snapshot.panes.some(p => p.pane_id === pane.pane_id && p.terminal_id === pane.terminal_id && p.tab_id === pane.tab_id && p.workspace_id === pane.workspace_id)) fail('changed_target');
      if (!job.legacy) {
        const currentPane = beforeStart.snapshot.panes.find(p => p.pane_id === pane.pane_id);
        if (await directory(currentPane.foreground_cwd ?? currentPane.cwd) !== job.placement.cwd) fail('changed_target');
      }
      if (operationLocks.has(`workspace:${pane.workspace_id}`) || operationLocks.has(`pane:${pane.pane_id}`)) fail('busy');
      operationLocks.set(`pane:${pane.pane_id}`, { workspaceId: pane.workspace_id });
      try {
        const start = await invoke(['agent', 'start', name, '--kind', request.provider, '--pane', pane.pane_id, '--timeout', '30000',
          ...(request.args?.length ? ['--', ...request.args] : [])], { timeoutMs: LIMITS.startTransportTimeoutMs });
        const target = { paneId: pane.pane_id, terminalId: pane.terminal_id, provider: request.provider, agentName: name,
          ...(start.result?.agent?.agent_session?.kind === 'id' ? { sessionId: start.result.agent.agent_session.value } : {}) };
        compareAgent(target, start.result?.agent);
        const current = await checkedAgent(target);
        if (current.agent.agent_status === 'blocked' || current.agent.interactive_ready !== true || current.agent.launch_pending === true) {
          return finish(outcome('needs_input', 'The new pane needs attention before receiving a prompt. Review its trust, authentication or approval screen; the prompt was not sent.', { ...details(), code: 'agent_not_ready' }));
        }
        if (!['idle', 'done'].includes(current.agent.agent_status)) return finish(outcome('uncertain', 'The new agent is not ready for a prompt. Inspect the preserved pane before sending work.', { ...details(), code: 'agent_not_ready' }));
        await observe(job, 'prompt');
        const submitted = await invoke(['agent', 'prompt', pane.pane_id, request.prompt], { timeoutMs: LIMITS.followUpTimeoutMs });
        compareAgent(target, submitted.result?.agent);
        return finish(outcome('submitted', 'Prompt submitted. Herdr will report the agent’s live status.', { ...details(), ...(Array.isArray(start.result.argv) ? { argv: [...start.result.argv] } : {}) }));
      } finally { operationLocks.delete(`pane:${pane.pane_id}`); }
    } catch (error) {
      const code = errorCode(error);
      if (error.trust && job.stage === 'target' && !job.trustRetry && !trusted(error.trust.root)) {
        job.trustRoot = error.trust.root;
        return finish(outcome('needs_confirmation', DISPATCH_MESSAGES.needsTrust.replace('{root}', safeText(error.trust.root)), { ...details(), code: 'untrusted_repository' }));
      }
      if (NEEDS_INPUT.has(code)) return finish(outcome('needs_input', 'The agent needs attention in its pane. The prompt was not sent; review trust, authentication or approval there.', { ...details(), code }));
      const uncertain = job.mutated && (UNCERTAIN.has(code) || job.stage === 'prompt');
      return finish(outcome(uncertain ? 'uncertain' : 'failed', uncertain ? 'The action could not be confirmed. Inspect Herdr before trying again; Shep will not retry or remove created resources.' : messageFor(code), { ...details(), code }));
    }
  }

  return launch;
}
