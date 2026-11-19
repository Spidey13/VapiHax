import Anthropic from '@anthropic-ai/sdk';
import { logicalThreads, withoutMetaExchanges } from '../tree/history.js';
import { fallbackDigest } from './digest.js';
import type { Session } from '../tree/types.js';

export interface SessionSummary {
  covered: string;
  branches: { id: string; line: string }[];
  /** What the user said mattered. Absent on summaries written before this field existed. */
  considerations?: string[];
  open: string[];
}

export interface Summarizer {
  summarize(s: Session, signal?: AbortSignal): Promise<SessionSummary>;
}

const SUMMARY_SYSTEM = [
  'Write notes of this spoken conversation for the person who had it. It can be about any subject. Plain, specific sentences in their own terms; no praise.',
  'Never invent decisions, reasons, deadlines, commitments or tasks. Switching between threads is not a decision.',
  '`covered`: two to four plain sentences, led by where they landed, with the decisions they made and the reasons they actually gave. Exploration without a decision stays exploration.',
  '`branches`: one entry per thread, with `id` copied exactly from the bracketed id in the header of that thread (for example b2) and a `line` with its latest corrected plan, corrections folded in. A "User (correction)" turn replaces what it corrects.',
  '`considerations`: up to four things the user said mattered, constraints or tradeoffs they weighed. A caution only the assistant raised may appear only worded as a suggestion ("Suggested: ..."). Facts or figures the assistant supplied (temperatures, prices, distances, dates) belong to the assistant, not the user: mark them "Suggested:" or leave them out, and never list them as decisions or as things to keep in mind as settled.',
  '`open`: up to three material unresolved choices. A question the assistant asked is not automatically open.',
].join(' ');

/** Built per call so a branch line can only name a branch that is in the input. */
function summarySchema(ids: string[]) {
  return {
    type: 'object',
    properties: {
      covered: { type: 'string' },
      branches: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: ids }, line: { type: 'string' } },
          required: ['id', 'line'],
          additionalProperties: false,
        },
      },
      considerations: { type: 'array', items: { type: 'string' } },
      open: { type: 'array', items: { type: 'string' } },
    },
    required: ['covered', 'branches', 'considerations', 'open'],
    additionalProperties: false,
  };
}

/** Ids of the branches that belong in the summary: one representative per logical topic with a live user turn. */
export function listedBranchIds(s: Session): string[] {
  return logicalThreads(s).map(({ branch }) => branch.id);
}

/** Trims, drops blanks and case-insensitive repeats, and keeps at most `max`. */
function tidyList(items: string[] | undefined, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items ?? []) {
    const text = raw.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out.slice(0, max);
}

/**
 * Makes a summary safe to show: drops lines for unknown branches (and repeats), adds a fallback line for any listed
 * topic the summary missed, and tidies and caps considerations (4) and open (3).
 */
export function normaliseSummary(s: Session, summary: SessionSummary): SessionSummary {
  const listed = new Set(listedBranchIds(s));
  const seen = new Set<string>();
  const branches = summary.branches.filter((l) => {
    if (!listed.has(l.id) || seen.has(l.id) || l.line.trim() === '') return false;
    seen.add(l.id);
    return true;
  });
  const fallback = fallbackSummary(s);
  for (const l of fallback.branches) if (!seen.has(l.id)) branches.push(l);
  return {
    covered: summary.covered.trim() ? summary.covered.trim() : fallback.covered,
    branches,
    considerations: tidyList(summary.considerations, 4),
    open: tidyList(summary.open, 3),
  };
}

const roleLabel = (t: { role: string; kind?: string }) =>
  t.role === 'user' ? (t.kind === 'correction' ? 'User (correction)' : 'User') : 'Assistant';

export function summaryInput(s: Session): string {
  return logicalThreads(s)
    .map(({ branch: b, turns, notes }) => {
      const lines = [...notes.map((n) => `Note: ${n}`), ...withoutMetaExchanges(turns).map((t) => `${roleLabel(t)}: ${t.text}`)];
      return `## [${b.id}] ${b.name} (${b.status})\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

export function fallbackSummary(s: Session): SessionSummary {
  return {
    covered: 'Notes from your session.',
    // The topic's own user words (earliest constraints plus the latest correction), so a corrected plan is not reduced to its correction.
    branches: logicalThreads(s).map(({ branch: b, turns }) => ({ id: b.id, line: fallbackDigest(b.name, withoutMetaExchanges(turns)) })),
    considerations: [],
    open: [],
  };
}

function parseSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.covered !== 'string' || !Array.isArray(r.branches) || !Array.isArray(r.open)) return null;
  const branches: SessionSummary['branches'] = [];
  for (const x of r.branches) {
    if (!x || typeof x !== 'object') return null;
    const { id, line } = x as Record<string, unknown>;
    if (typeof id !== 'string' || typeof line !== 'string') return null;
    branches.push({ id, line });
  }
  if (!r.open.every((o) => typeof o === 'string')) return null;
  if (r.considerations !== undefined && (!Array.isArray(r.considerations) || !r.considerations.every((c) => typeof c === 'string'))) return null;
  return { covered: r.covered, branches, considerations: (r.considerations as string[] | undefined) ?? [], open: r.open as string[] };
}

export class ClaudeSummarizer implements Summarizer {
  private client: Anthropic;
  private model: string;

  constructor(opts: { client?: Anthropic; model?: string } = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? (process.env.BACKGROUND_MODEL || 'claude-opus-5-5');
  }

  /** Never throws: any failure, truncation or malformed output gives the fallback. */
  async summarize(s: Session, signal?: AbortSignal): Promise<SessionSummary> {
    try {
      const res = await this.client.messages.create(
        {
        model: this.model,
        // Thinking tokens count against max_tokens.
        max_tokens: 2000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: summarySchema(listedBranchIds(s)) } },
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: summaryInput(s) }],
        },
        { signal },
      );
      if (res.stop_reason === 'max_tokens') return fallbackSummary(s);
      const block = res.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text' || !block.text.trim()) return fallbackSummary(s);
      return parseSummary(JSON.parse(block.text)) ?? fallbackSummary(s);
    } catch {
      return fallbackSummary(s);
    }
  }
}
