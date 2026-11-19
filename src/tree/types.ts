import type { SessionSummary } from '../reply/summary.js';

export type BranchStatus = 'provisional' | 'live' | 'faded' | 'parked';

export interface Turn {
  id: string;
  branchId: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  kind?: 'correction' | 'merge-opening' | 'recap' | 'compare';
  scratched?: boolean;
}

export interface Branch {
  id: string;
  parentId: string | null;
  forkAfterTurnId: string | null;
  name: string;
  status: BranchStatus;
  origin: 'root' | 'fork' | 'correction' | 'merge';
  mergedFrom?: [string, string];
  mergeOffered?: string[];
  offeredBack?: boolean;
  /** A merged branch's source digests, kept for every later reply. */
  mergeDigests?: string[];
  /** Consecutive `continue` turns on this branch; reset by any other op. */
  continueStreak?: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface Session {
  id: string;
  epoch: number;
  revision: number;
  branches: Record<string, Branch>;
  turns: Turn[];
  currentBranchId: string;
  lastActivity: number;
  counters: { branch: number; turn: number };
  /** Hold-to-talk: while true the assistant stays silent and nothing is recorded. */
  hold: boolean;
  /** A fork hit the live-branch limit: the new provisional branch waits for the user to name one to set aside. */
  awaitingSetAside?: { branchId: string; asked: number };
  /** A compare just offered to combine these two; the next turn may accept. */
  pendingMergeOffer?: { a: string; b: string };
  /** An unclear merge asked which thread to combine with; the next turn's target answers. */
  pendingMerge?: boolean;
  /** Set once the session is ended: read-only from then on, kept 24 h for the share page. */
  ended?: { at: number; summary: SessionSummary | null; shareId: string };
}
