/**
 * @fileoverview Defines governor interfaces and evaluation context contracts.
 */

import { BrainConfig } from "../core/config";
import {
  BrainState,
  GovernanceMemoryReadView,
  GovernanceProposal,
  GovernorId,
  ProfileMemoryStatus,
  GovernorVote,
  TaskRequest
} from "../core/types";
import { ModelClient } from "../models/types";

export interface GovernorContext {
  task: TaskRequest;
  config: BrainConfig;
  state: BrainState;
  governanceMemory: GovernanceMemoryReadView;
  profileMemoryStatus?: ProfileMemoryStatus;
  model: string;
  modelClient: ModelClient;
}

export interface Governor {
  id: GovernorId;
  evaluate(proposal: GovernanceProposal, context: GovernorContext): Promise<GovernorVote>;
}

