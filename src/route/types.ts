export type Intent = 'continue' | 'newDirection' | 'correction' | 'switchBack' | 'park' | 'scratch' | 'recap' | 'compare' | 'merge';
export interface BranchBrief { id: string; name: string; summary: string }
export interface RouteInput { utterance: string; current: BranchBrief & { provisional: boolean; lastUser: string | null; lastAssistant: string | null }; others: BranchBrief[] }
export interface RawAnswers { intent: { choice: Intent; confidence: number }; target: { choice: string; confidence: number }; detailNotDirection: number; takesUpSuggestion: number }
export type Op = { kind: 'continue' } | { kind: 'fork'; acknowledge: boolean } | { kind: 'correct' } | { kind: 'switch'; targetId: string } | { kind: 'ask-which' }
  | { kind: 'park'; targetId?: string } | { kind: 'scratch' } | { kind: 'recap' } | { kind: 'compare'; otherId: string | null } | { kind: 'merge'; otherId: string } | { kind: 'only-one-thread' } | { kind: 'ask-merge' };
export interface RouteDecision { op: Op; intent: Intent | null; by: 'jev' | 'fallback'; ms: number; reason: string; raw?: RawAnswers }
export interface Router { route(input: RouteInput): Promise<RouteDecision> }
