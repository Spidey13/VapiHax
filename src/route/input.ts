import type { Session, Turn } from '../tree/types.js';
import { pathTurns } from '../tree/tree.js';
import type { BranchBrief, RouteInput } from './types.js';

const SUMMARY_LENGTH = 120;
const MAX_OTHERS = 5;

function lastOfRole(turns: Turn[], role: Turn['role']): string | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === role && !turns[i].scratched) return turns[i].text;
  return null;
}

function brief(s: Session, id: string): BranchBrief {
  const lastUser = lastOfRole(pathTurns(s, id), 'user') ?? '';
  return { id, name: s.branches[id].name, summary: lastUser.slice(0, SUMMARY_LENGTH) };
}

export function buildRouteInput(s: Session, utterance: string): RouteInput {
  const cur = s.branches[s.currentBranchId];
  const path = pathTurns(s, cur.id);
  const others = Object.values(s.branches)
    .filter((b) => b.id !== cur.id && b.status !== 'faded')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_OTHERS)
    .map((b) => brief(s, b.id));
  return {
    utterance,
    current: {
      ...brief(s, cur.id),
      provisional: cur.status === 'provisional',
      lastUser: lastOfRole(path, 'user'),
      lastAssistant: lastOfRole(path, 'assistant'),
    },
    others,
  };
}
