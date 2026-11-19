# Router evaluation

## Overall

- n: 156
- accuracy: 88.5%
- falseForkRate: 25.6%
- p50: 97 ms
- p90: 111 ms

| kind | precision | recall | n |
| --- | --- | --- | --- |
| compare | 100.0% | 100.0% | 5 |
| continue | 77.1% | 77.1% | 35 |
| correct | 100.0% | 84.8% | 33 |
| fork | 74.4% | 93.5% | 31 |
| merge | 100.0% | 87.5% | 8 |
| park | 100.0% | 71.4% | 7 |
| recap | 100.0% | 100.0% | 5 |
| scratch | 100.0% | 100.0% | 5 |
| switch | 100.0% | 100.0% | 27 |

Confusion matrix (rows expected, columns got)

| expected \\ got | compare | continue | correct | fork | merge | park | recap | scratch | switch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| compare | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| continue | 0 | 27 | 0 | 8 | 0 | 0 | 0 | 0 | 0 |
| correct | 0 | 5 | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| fork | 0 | 2 | 0 | 29 | 0 | 0 | 0 | 0 | 0 |
| merge | 0 | 0 | 0 | 1 | 7 | 0 | 0 | 0 | 0 |
| park | 0 | 1 | 0 | 1 | 0 | 5 | 0 | 0 | 0 |
| recap | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 | 0 |
| scratch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0 |
| switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 27 |

## Tune split

- n: 103
- accuracy: 89.3%
- falseForkRate: 21.4%
- p50: 97 ms
- p90: 111 ms

| kind | precision | recall | n |
| --- | --- | --- | --- |
| compare | 100.0% | 100.0% | 3 |
| continue | 79.2% | 76.0% | 25 |
| correct | 100.0% | 80.0% | 20 |
| fork | 78.6% | 95.7% | 23 |
| merge | 100.0% | 100.0% | 5 |
| park | 100.0% | 100.0% | 4 |
| recap | 100.0% | 100.0% | 3 |
| scratch | 100.0% | 100.0% | 3 |
| switch | 100.0% | 100.0% | 17 |

Confusion matrix (rows expected, columns got)

| expected \\ got | compare | continue | correct | fork | merge | park | recap | scratch | switch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| compare | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| continue | 0 | 19 | 0 | 6 | 0 | 0 | 0 | 0 | 0 |
| correct | 0 | 4 | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| fork | 0 | 1 | 0 | 22 | 0 | 0 | 0 | 0 | 0 |
| merge | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0 |
| park | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 |
| recap | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 |
| scratch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 |
| switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 17 |

## Held-out split

- n: 53
- accuracy: 86.8%
- falseForkRate: 36.4%
- p50: 99 ms
- p90: 110 ms

| kind | precision | recall | n |
| --- | --- | --- | --- |
| compare | 100.0% | 100.0% | 2 |
| continue | 72.7% | 80.0% | 10 |
| correct | 100.0% | 92.3% | 13 |
| fork | 63.6% | 87.5% | 8 |
| merge | 100.0% | 66.7% | 3 |
| park | 100.0% | 33.3% | 3 |
| recap | 100.0% | 100.0% | 2 |
| scratch | 100.0% | 100.0% | 2 |
| switch | 100.0% | 100.0% | 10 |

Confusion matrix (rows expected, columns got)

| expected \\ got | compare | continue | correct | fork | merge | park | recap | scratch | switch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| compare | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| continue | 0 | 8 | 0 | 2 | 0 | 0 | 0 | 0 | 0 |
| correct | 0 | 1 | 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| fork | 0 | 1 | 0 | 7 | 0 | 0 | 0 | 0 | 0 |
| merge | 0 | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 0 |
| park | 0 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 |
| recap | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| scratch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 |
| switch | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 10 |
