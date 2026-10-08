// Central as an execution agent: shapes of src-tauri/src/central_commands.rs,
// crates/pcc-orchestrator/src/{central,resume}.rs and crates/pcc-ai/src/capability.rs.

import type { EngineProvider } from "./aiTypes";
import type { CheckpointSummary, LastAction, PowerLevel } from "./types";

/** Settings → Missions → Recovery (every switch defaults to on). */
export interface MissionRecoverySettings {
  autoResumeMissions: boolean;
  autoReconnectMcp: boolean;
  autoRestartAgents: boolean;
  restoreWorld: boolean;
  recoverPermissions: boolean;
  validateFilesBeforeResume: boolean;
}

export const DEFAULT_MISSION_RECOVERY: MissionRecoverySettings = {
  autoResumeMissions: true,
  autoReconnectMcp: true,
  autoRestartAgents: true,
  restoreWorld: true,
  recoverPermissions: true,
  validateFilesBeforeResume: true,
};

/** The mission NEXUS resumed by itself at open. */
export interface AutoResumeNotice {
  missionId: string | null;
  title: string | null;
  summary: string;
  ok: boolean;
  at: string;
}

export interface MissionBlock {
  missionId: string;
  reason: string;
  needs: "user_decision" | "permission" | "external" | "fatal";
  at: string;
}

export type AutonomyLabel = "LOW" | "NORMAL" | "HIGH" | "MAXIMUM" | "CUSTOM";

export interface ResumeMcp {
  server: string;
  state: "ok" | "failed" | "unknown";
  detail: string;
}

export interface ResumeAgent {
  agentId: string;
  name: string;
  rank: string;
  status: string;
  task: string | null;
  session: string;
  action: string | null;
}

export interface ResumeReport {
  trigger: "user" | "auto" | "central";
  recovered: boolean;
  missionId: string;
  title: string;
  status: string;
  previousState: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksVerified: number;
  done: string[];
  remaining: string[];
  filesValidated: boolean;
  filesExpected: number;
  filesPresent: number;
  filesMissing: string[];
  filesSinceCheckpoint: string[];
  branch: string | null;
  head: string | null;
  uncommitted: string[];
  diffStat: string | null;
  mcp: ResumeMcp[];
  claude: string;
  agents: ResumeAgent[];
  lastAction: LastAction | null;
  lastCheckpoint: CheckpointSummary | null;
  nextAction: string;
}

export type CapabilityTest = "chat" | "structured_output" | "tool_call" | "multi_step" | "context" | "recovery";
export type CapabilityStatus = "pass" | "limited" | "fail" | "skipped";
export type CentralMode = "full" | "limited_tools" | "unavailable";

export interface CapabilityResult {
  test: CapabilityTest;
  status: CapabilityStatus;
  detail: string;
  ms: number;
}

export interface CapabilityReport {
  runtime: string;
  baseUrl: string;
  model: string;
  at: string;
  results: CapabilityResult[];
  centralMode: CentralMode;
  summary: string;
}

export interface CentralState {
  autonomy: AutonomyLabel;
  autonomyLevel: PowerLevel | null;
  nudgeLimit: number;
  blocks: MissionBlock[];
  autoResume: AutoResumeNotice | null;
  resumeCandidate: string | null;
  engine: EngineProvider;
  localCapability: CapabilityReport | null;
}
