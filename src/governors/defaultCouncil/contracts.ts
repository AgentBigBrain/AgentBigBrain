/**
 * @fileoverview Re-exports the typed contracts used by the default governor council subsystem.
 */

import {
  GovernanceProposal,
  GovernorId,
  GovernorRejectCategory,
  GovernorVote
} from "../../core/types";
import { Governor, GovernorContext } from "../types";

export type DefaultGovernor = Governor;
export type DefaultGovernorContext = GovernorContext;
export type DefaultGovernanceProposal = GovernanceProposal;
export type DefaultGovernorId = GovernorId;
export type DefaultGovernorRejectCategory = GovernorRejectCategory;
export type DefaultGovernorVote = GovernorVote;
