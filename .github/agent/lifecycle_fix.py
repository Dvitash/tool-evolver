from pathlib import Path

path = Path("apps/cloud/src/index.ts")
text = path.read_text(encoding="utf-8")
text = text.replace(
    '''import {
  type CandidateLifecycleOrchestrator,
  createCandidateLifecycleOrchestrator,
} from "./evolution/lifecycle/index.js";''',
    '''import { CandidateLifecycleOrchestrator } from "./evolution/lifecycle/index.js";''',
    1,
)
text = text.replace(
    "this.candidateLifecycleOrchestrator = createCandidateLifecycleOrchestrator(this.dbPool, {",
    "this.candidateLifecycleOrchestrator = new CandidateLifecycleOrchestrator(this.dbPool, {",
    1,
)
text = text.replace(
    '''          const result = await this.opportunityService.processSessionEvents(tenant, events);
          sendJson(res, 200, { opportunities: result.opportunities }, headers);''',
    '''          const opportunities = await this.opportunityService.processSessionEvents(tenant, events);
          sendJson(res, 200, { opportunities }, headers);''',
    1,
)
path.write_text(text, encoding="utf-8")
