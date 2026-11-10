export type FactStatus = 'candidate' | 'confirmed' | 'disputed' | 'unknown';
export type FactOrigin = 'fixture' | 'user-report' | 'typed';
export interface Fact<T = string> {
  path: string; // e.g. 'phone.platform'
  value: T | null; // null = unknown
  version: number; // monotonic per field, never reused
  status: FactStatus;
  origin: FactOrigin;
  sourceText?: string; // utterance span that supports it
  updatedAt: number;
  proposed?: T; // value awaiting conflict resolution (status === 'disputed')
}
export type AttemptOutcome = 'not-started' | 'in-progress' | 'succeeded' | 'failed' | 'skipped' | 'unknown';
export interface Attempt {
  id: string;
  checkId: string;
  outcome: AttemptOutcome;
  at: number;
  factSnapshot: Record<string, string | null>;
  applicable: boolean; // false once a correction makes it no longer apply; never deleted
  note?: string;
}
export interface SourceRef {
  id: string;
  url: string;
  publisher: string;
  title: string;
  mode: 'curated' | 'live';
  capturedAt: string;
}
export type Stage =
  | 'prerequisite'
  | 'discovery'
  | 'commissioning'
  | 'connectivity-check'
  | 'post-pair-unavailable'
  | 'unknown';
export interface Check {
  id: string;
  stage: Stage;
  requires: Record<string, string | string[]>; // fact path -> required confirmed value(s); 'unknown' matches a null value
  dependsOn: string[]; // fact paths whose version is stamped
  actionText: string; // reversible; refer to the source rather than inventing menu paths
  expectedObservation: string;
  stopConditions: string;
  sources: SourceRef[];
  terminal?: 'unsupported'; // blocker check
}
export type Outcome = 'next-check' | 'user-reported-recovered' | 'unresolved' | 'unsupported' | 'handoff';
export interface DependencyStamp {
  sessionId: string;
  epoch: number;
  fieldVersions: Record<string, number>;
  checkId?: string;
}
export interface Notice {
  at: number;
  kind: 'superseded' | 'conflict' | 'clarify' | 'hypothetical';
  text: string;
}
export interface CaseState {
  sessionId: string;
  epoch: number;
  revision: number;
  facts: Record<string, Fact>;
  attempts: Attempt[];
  currentCheck: { check: Check; stamp: DependencyStamp } | null;
  notices: Notice[];
  hypothetical: Record<string, string> | null; // never merged into facts
  outcome: Outcome;
  lastActivity: number;
  // Addition beyond the plan's core type: the clarification question currently awaiting an answer, if any.
  pendingQuestion?: 'phone.googleServices' | 'phone.platform' | null;
}
