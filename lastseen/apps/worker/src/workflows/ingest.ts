import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { TrackerAgent } from "../agent";

export interface IngestParams {
  placementId: string;
}

/** M0 stub: proves the Workflows binding deploys. Real pipeline lands in M2. */
export class IngestPlacementWorkflow extends AgentWorkflow<TrackerAgent, IngestParams> {
  override async run(event: AgentWorkflowEvent<IngestParams>, step: AgentWorkflowStep) {
    const result = await step.do("noop", async () => ({ placementId: event.payload.placementId }));
    await step.reportComplete(result);
    return result;
  }
}
