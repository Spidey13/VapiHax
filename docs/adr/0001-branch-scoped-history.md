# 0001 · Scope context to the active branch and preserve corrections

**Status** Implemented

## Context

A conversation can move from an original idea to a detour and back. The original reply context needs to stay coherent. A detail update like “Furano, not Niseko” also needs to reach a later comparison, merge and report.

## Decision

Keep one turn store with branch ownership. A branch records its parent and the last inherited turn. Resolve its history by walking each ancestor to that fork point and then adding the branch’s own turns. This shares history while excluding sibling conversations from ordinary replies.

A correction creates a successor copy on the same logical topic. Keep the earlier turns, fade the previous version and add a note that gives the corrected detail precedence. Build reply and digest input from effective history, including correction notes and inherited merge digests. Compare explicitly reads the chosen branches. A merge tracks both sources, starts at their shared ancestry and carries their digests forward. Group correction versions into one topic when building end notes.

## Consequences

Forks extend an existing path without copying the entire turn store. Audit and map views can retain prior structure while the reply sees a scoped history. Merge context depends on the fidelity of the digests. Corrections are instructions backed by preserved history, so the summarizer can fold them in while the raw conversation remains recoverable during the session.

[Tree operations](../../src/tree/tree.ts) · [Effective history](../../src/tree/history.ts) · [Operation application](../../src/turn/apply.ts) · [History tests](../../test/history.test.ts)
