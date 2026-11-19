# Router evaluation (tuned thresholds)

- date: 2026-11-10
- items: 162 (tune 108, held-out 54); split by a stable hash of id (target 70% / 30%; this set lands at 67% / 33%)
- source: cached Jev answers in eval/router/cache.json; no network calls (`npm run tune:router`)
- router spec version: 2154981c9fdf
- objective: maximise accuracy on the tune split subject to false-fork rate <= 0.1; ties are broken by higher intent, then higher takesUp, then lower detailHigh, then lower target (the order implemented by `beats` in src/route/tune.ts)
- grids: the plan grid (intent, detailHigh, target; takesUp fixed at 0.7) is reported first. The extended grid adds takesUp in {0.7, 0.8, 0.9}, a documented extension of the plan. The chosen thresholds come from the extended grid only if the plan grid has no qualifying point.

## Method notes

- The [first run on 156 items](evidence/router-before-question-revision.md) recorded 86.8% held-out accuracy and a 36.4% false-fork rate. Every false fork came from the takes-up rule. That question was reworded after inspecting errors on both splits. The cache was re-keyed, and the expanded 162-item set includes six demo utterances.
- The held-out figures below are therefore development results, not a blind test. Thresholds were chosen on the tune split only.
- The chosen intent, detailHigh and target are each the lowest value on their grid, so the optimum may lie below the grid; the grid was not extended downwards.
- The takes-up rule can also fire on the user's own idea, so a reason text of 'takes up suggestion' may appear for a fork the user originated. The outcome is a fork either way.
- Samples are small: see the Wilson intervals and the per-kind n < 5 flags.
- These are the saved November 10 results. Run `npm run eval:router -- --offline` to apply the current policy to the cached answers, or `npm run tune:router` to score alternate thresholds without network calls. Generated reports go to `docs/results/generated/`. Running `npm run eval:router` without `--offline` can make billed Jev requests for cache misses.

## Chosen thresholds

- intent 0.6, detailHigh 0.6, target 0.5, takesUp 0.7, taken from the plan grid (other thresholds unchanged: detailLow 0.3, ackHigh 0.85)
- plan grid: a point met the false-fork limit; extended grid: a point met the false-fork limit
- grid result (plan grid): 45 of 45 points qualified on the tune split (n 108).
- the false-fork limit was not binding: every grid point qualified.
- margin: the best qualifying accuracy beats the next-best distinct accuracy by 1 of 108 items (94.4% vs 93.5%).

## Held-out split (the reported numbers)

- n: 54
- accuracy: 92.6%
- accuracy Wilson 95% interval: 82.4% to 97.1% (50 of 54)
- false-fork rate: 0.0% (0 false of 7 predicted forks); upper 95% bound 42.9% (rule of three; exact one-sided Clopper-Pearson bound 34.8%)
- router latency from cached timings: p50 98 ms, p90 120 ms

| kind | precision | recall | n | note |
| --- | --- | --- | --- | --- |
| compare | 100.0% | 100.0% | 2 | n < 5: indicative only |
| continue | 73.3% | 100.0% | 11 |  |
| correct | 100.0% | 92.3% | 13 |  |
| fork | 100.0% | 87.5% | 8 |  |
| merge | 100.0% | 66.7% | 3 | n < 5: indicative only |
| park | 100.0% | 66.7% | 3 | n < 5: indicative only |
| recap | 100.0% | 100.0% | 2 | n < 5: indicative only |
| scratch | 100.0% | 100.0% | 2 | n < 5: indicative only |
| switch | 100.0% | 100.0% | 10 |  |

Correction vs new direction (rows expected, columns got; `correct` is the correction op, `fork` the new-direction op):

| expected / got | correct | fork |
| --- | --- | --- |
| correct | 12 | 0 |
| fork | 0 | 7 |

Full confusion matrix (rows expected, columns got):

| expected / got | compare | continue | correct | fork | merge | park | recap | scratch | switch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| compare | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| continue | 0 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| correct | 0 | 1 | 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| fork | 0 | 1 | 0 | 7 | 0 | 0 | 0 | 0 | 0 |
| merge | 0 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| park | 0 | 1 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| recap | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| scratch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |

## Tune split

- n: 108
- accuracy: 94.4%
- accuracy Wilson 95% interval: 88.4% to 97.4% (102 of 108)
- false-fork rate: 0.0% (0 false of 21 predicted forks); upper 95% bound 14.3% (rule of three; exact one-sided Clopper-Pearson bound 13.3%)
- router latency from cached timings: p50 101 ms, p90 126 ms

| kind | precision | recall | n | note |
| --- | --- | --- | --- | --- |
| compare | 100.0% | 100.0% | 4 | n < 5: indicative only |
| continue | 81.3% | 100.0% | 26 |  |
| correct | 100.0% | 85.0% | 20 |  |
| fork | 100.0% | 87.5% | 24 |  |
| merge | 100.0% | 100.0% | 6 |  |
| park | 100.0% | 100.0% | 4 | n < 5: indicative only |
| recap | 100.0% | 100.0% | 3 | n < 5: indicative only |
| scratch | 100.0% | 100.0% | 3 | n < 5: indicative only |
| switch | 100.0% | 100.0% | 18 |  |

Correction vs new direction (rows expected, columns got; `correct` is the correction op, `fork` the new-direction op):

| expected / got | correct | fork |
| --- | --- | --- |
| correct | 17 | 0 |
| fork | 0 | 21 |

Full confusion matrix (rows expected, columns got):

| expected / got | compare | continue | correct | fork | merge | park | recap | scratch | switch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| compare | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| continue | 0 | 26 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| correct | 0 | 3 | 17 | 0 | 0 | 0 | 0 | 0 | 0 |
| fork | 0 | 3 | 0 | 21 | 0 | 0 | 0 | 0 | 0 |
| merge | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 |
| park | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| recap | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 |
| scratch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 18 |

## Plan grid (tune split, top 10 of 45)

45 of 45 points met the false-fork limit of 0.1.

| rank | intent | detailHigh | target | takesUp | accuracy | false-fork rate | meets limit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.6 | 0.6 | 0.5 | 0.7 | 94.4% | 0.0% | yes |
| 2 | 0.6 | 0.7 | 0.5 | 0.7 | 94.4% | 0.0% | yes |
| 3 | 0.65 | 0.6 | 0.5 | 0.7 | 93.5% | 0.0% | yes |
| 4 | 0.65 | 0.7 | 0.5 | 0.7 | 93.5% | 0.0% | yes |
| 5 | 0.6 | 0.6 | 0.6 | 0.7 | 93.5% | 0.0% | yes |
| 6 | 0.6 | 0.6 | 0.7 | 0.7 | 93.5% | 0.0% | yes |
| 7 | 0.6 | 0.7 | 0.6 | 0.7 | 93.5% | 0.0% | yes |
| 8 | 0.6 | 0.7 | 0.7 | 0.7 | 93.5% | 0.0% | yes |
| 9 | 0.6 | 0.8 | 0.5 | 0.7 | 93.5% | 4.5% | yes |
| 10 | 0.7 | 0.6 | 0.5 | 0.7 | 92.6% | 0.0% | yes |

## Extended grid with takesUp (tune split, top 10 of 135)

135 of 135 points met the false-fork limit of 0.1.

| rank | intent | detailHigh | target | takesUp | accuracy | false-fork rate | meets limit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.6 | 0.6 | 0.5 | 0.7 | 94.4% | 0.0% | yes |
| 2 | 0.6 | 0.7 | 0.5 | 0.7 | 94.4% | 0.0% | yes |
| 3 | 0.65 | 0.6 | 0.5 | 0.7 | 93.5% | 0.0% | yes |
| 4 | 0.65 | 0.7 | 0.5 | 0.7 | 93.5% | 0.0% | yes |
| 5 | 0.6 | 0.6 | 0.5 | 0.8 | 93.5% | 0.0% | yes |
| 6 | 0.6 | 0.7 | 0.5 | 0.8 | 93.5% | 0.0% | yes |
| 7 | 0.6 | 0.6 | 0.6 | 0.7 | 93.5% | 0.0% | yes |
| 8 | 0.6 | 0.6 | 0.7 | 0.7 | 93.5% | 0.0% | yes |
| 9 | 0.6 | 0.7 | 0.6 | 0.7 | 93.5% | 0.0% | yes |
| 10 | 0.6 | 0.7 | 0.7 | 0.7 | 93.5% | 0.0% | yes |

## False forks

No false forks on either split at the chosen thresholds.
