# Architecture

```mermaid
flowchart LR
  subgraph Edge["Beam Pro (chest, PWA)"]
    CAM[Camera 2 fps + 6 s JPEG ring] --> GATE[Trigger gate]
    MIC[Mic + VAD] --> UTT[Utterance WAV]
    IMU[IMU + orientation] --> PDR[Heading + step PDR]
    HUD[HUD arrow, black bg]
  end
  subgraph CF["Cloudflare"]
    GW[Worker gateway<br/>auth, static assets, budget KV]
    AG[(TrackerAgent<br/>Durable Object + SQLite)]
    WF[[IngestPlacement Workflow]]
    VEC[(Vectorize)]
    AI[Workers AI embeddings]
    R2[(R2 keyframes)]
  end
  OMNI[[Qwen3.5-Omni via yibuapi]]
  DASH[Dashboard /dash]

  GATE -- keyframes + pose log --> GW
  UTT -- audio + latest frame --> GW
  PDR -- pose 2 Hz --> GW
  GW <-- WebSocket --> AG
  AG -- runWorkflow --> WF
  WF -- extractPlacements --> OMNI
  WF --> AI --> VEC
  WF --> R2
  AG -- understandUtterance, verifyVisible --> OMNI
  AG -- find_object --> VEC
  AG -- setState: target, status --> HUD
  AG <-- WebSocket --> DASH
```

## Where the "agent with a brain" lives

`TrackerAgent` (one Durable Object per device):

- **State** (`setState`, synced to the PWA and the dashboard): pose, target, status, last reply, budget.
- **Memory** (SQLite): `objects`, `sightings`, `zones`, `pose_log`, `traces`, plus short multi-turn context for clarifying questions.
- **Tools**: `find_object`, `guide_to`, `verify_visible`, `list_recent`, `mark_moved`, `forget`, `clarify`.
- **Planning loop**: at most 4 OMNI steps per utterance, each step is a tool call or a final answer; every step is written to `traces` and streamed to the dashboard.
- **Workflows**: `IngestPlacementWorkflow` is durable and retried (OMNI extraction, embedding, reconcile, upsert).
- **Scheduling**: `schedule()` runs retention purge and optional "still there?" re-verification.

## Latency path for a spoken query

`arrow first, voice second`: `guide_to` calls `setState` immediately, so the HUD arrow appears as soon as the tool runs, before the final answer is synthesized.
