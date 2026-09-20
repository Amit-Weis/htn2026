import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { TrackerAgent } from "../agent";

export interface IngestParams {
  /** row in the agent's `candidates` table; frames stay in the agent's storage (workflow params are size-limited) */
  candidateId: string;
}

const retry = { retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }, timeout: "90 seconds" } as const;

/**
 * Durable, retried ingest of one accepted placement candidate. Each step is an idempotent RPC into the
 * TrackerAgent that owns the data: extract (OMNI + detector boxes) -> describe-crop -> reconcile -> notify.
 */
export class IngestPlacementWorkflow extends AgentWorkflow<TrackerAgent, IngestParams> {
  override async run(event: AgentWorkflowEvent<IngestParams>, step: AgentWorkflowStep) {
    const { candidateId } = event.payload;
    // RPC results are not plain-serializable in the type system; return fresh plain objects from each step.
    const ex = await step.do("extract", retry, async () => {
      const r = await this.agent.ingestExtract(candidateId);
      return { events: r.events, skipped: r.skipped ?? null };
    });
    const cropped = await step.do("describe-crop", retry, async () => {
      const r = await this.agent.ingestDescribeCrop(candidateId);
      return { cropped: r.cropped };
    });
    const summary = await step.do("reconcile", retry, async () => {
      const r = await this.agent.ingestReconcile(candidateId);
      return { objectIds: [...r.objectIds], created: r.created, updated: r.updated, held: r.held };
    });
    await step.do("notify", async () => {
      await this.agent.ingestNotify(candidateId, ex.skipped ?? undefined, summary);
      return { ok: true };
    });
    const result = { candidateId, extract: ex, cropped, summary };
    await step.reportComplete(result);
    return result;
  }
}
