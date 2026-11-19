# 0002 · Score routing separately and speculate on a snapshot

**Status** Implemented

## Context

Branch operations have consequences beyond the current reply. A false fork clutters the map and changes the context of following turns. Voice endpointing also leaves a window in which useful routing work can begin.

## Decision

Use Jev to score intent, detail changes and candidate targets. Apply a thresholded TypeScript policy to select one operation. Require evidence before a structural change and continue on router failure or when routing is disabled. An assistant suggestion enters the tree when the user takes it up.

Start routing after the same nonempty normalized partial appears twice in a row. Build its input from a cloned session and cache a completed Jev decision for the session revision and normalized text. The final voice turn checks the cache under the session lock. A changed transcript or revision, an unfinished route or a failed speculation falls through to final routing. Only the accepted turn applies the operation and starts the reply.

## Consequences

The policy can be scored from saved model answers and checked independently of the reply model. Speculation can reduce the routing work left at the end of an utterance, with extra router calls on misses. The cache rules are covered by tests. The saved router timings characterize routing on labelled text examples. Spoken latency requires separate measurement.

[Router policy](../../src/route/policy.ts) · [Speculator](../../src/route/speculate.ts) · [Speculation tests](../../test/speculate.test.ts) · [Router evaluation](../results/router-eval.md)
