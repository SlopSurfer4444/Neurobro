import type { Json } from '../contracts.ts';
import type { RegisteredTool } from '../capabilities/types.ts';
import { obj, str } from '../capabilities/schema.ts';
import { OwnerControlService } from './service.ts';
import type { OwnerProposalPublication, OwnerScopeProposal, ResolvedOwnerPeer } from './types.ts';

export interface OwnerControlToolsOptions {
  service: OwnerControlService;
  resolveSource(selector: string): Promise<ResolvedOwnerPeer>;
  /** Trusted host delivers one concrete private card and records its receipt via registerCard. */
  onProposal(proposal: OwnerScopeProposal): Promise<OwnerProposalPublication | void>;
}
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** Natural language reaches exact source proposals through the model; approval remains an owner event. */
export function ownerControlTools(options: OwnerControlToolsOptions): RegisteredTool[] {
  return [{
    name: 'owner.sources.propose', capability: 'owner.sources.propose', mutates: false,
    description: 'Propose exact sources selected from this owner request. This grants no history access. The owner accepts one concrete private card; do not claim subscription before acceptance.',
    inputSchema: obj({ selectors: { type: 'array', items: str(512), minItems: 1, maxItems: 32 }, monitor: { type: 'boolean' }, title: str(1024) }, ['selectors', 'monitor']),
    resources: () => ['owner-controls'],
    async execute({ args, context }) {
      const sources: ResolvedOwnerPeer[] = [];
      for (const selector of args.selectors as string[]) sources.push(await options.resolveSource(selector));
      const proposal = await options.service.proposeSources({ context, sources, monitor: args.monitor === true,
        ...(typeof args.title === 'string' ? { title: args.title } : {}) });
      const publication = await options.onProposal(proposal);
      const saved = options.service.proposal(proposal.id);
      return asJson({ proposalId: proposal.id, state: saved.state, sources: saved.sources, expiresAt: saved.expiresAt,
        ...(publication ? { publication } : {}), ...(saved.cardRef ? { cardRef: saved.cardRef } : {}),
        instruction: saved.cardRef ? 'Reply yes or no to the proposal card. Monitoring is not subscribed until owner acceptance and monitors.subscribe.'
          : 'The proposal is saved but its approval card is not verified. Do not claim approval or subscription; inspect publication status without resending.' });
    },
  }, {
    name: 'owner.sources.inspect', capability: 'owner.sources.inspect', mutates: false,
    description: 'Inspect this task’s current source scope and pending owner proposals. This does not grant or renew scope.',
    inputSchema: obj({}, []), resources: () => ['owner-controls'],
    async execute({ context }) {
      const proposals = options.service.listProposals(context);
      return asJson({ readPeers: options.service.getReadPeers(context.taskId), monitors: options.service.getMonitorPolicies(context.taskId), proposals });
    },
  }];
}
