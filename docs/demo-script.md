# Demo walkthrough

The selected 78-second V3 edit follows a recorded Japan-planning voice session. The desktop sequence replays the recorded app state with edited transcript timing and explanatory captions. You hear the assistant’s opening greeting and read the conversation on screen. The mobile shot separately stages the app’s real mobile-web branch controls.

| What happens | What to look for |
| --- | --- |
| Start with seven nights in Tokyo and Kyoto. | The first plan takes shape in a single thread. |
| Consider Hokkaido and a ryokan near Niseko. | A second thread appears and the city plan stays available. |
| Correct Niseko to Furano. | The detail changes within the Hokkaido topic. |
| Return to Tokyo and Kyoto and compare the plans. | The city context comes back and comparison uses both plans. |
| Combine and end the session. | The merged plan carries Furano forward. The final map and report retain the paths and notes. |
| Open the map on mobile and select the Tokyo thread. | The compact mobile map opens a sheet with the available threads. |

The partial-routing overlay explains the implementation. Routing behavior and timings are described in the [routing ADR](adr/0002-routing-and-speculation.md) and [evaluation](results/router-eval.md).

## Try it locally

Follow [local setup](setup.md), start a fresh session and say or type these lines in order. Let each reply finish. The phrasing and branch names can vary.

1. “I’m planning seven nights in Japan. I’m thinking Tokyo and Kyoto for food and temples.”
2. “What if we went to Hokkaido instead? A ryokan near Niseko and a couple of mornings skiing.”
3. “I meant Furano, not Niseko.”
4. “Go back to the Tokyo and Kyoto plan.”
5. “Compare the cities with Furano.”
6. “Okay, let’s combine them into one plan.”

Choose **End session**, then open the map and download the notes.

## Film credits

Music is “Chill Wave” by Kevin MacLeod (incompetech.com), licensed under Creative Commons Attribution 4.0. The edit uses a 78-second excerpt from 0:12 to 1:30 with level normalization, a 40 Hz high-pass filter, entrance and exit fades, and ducking under the greeting. The UI sound effects were synthesized for the film. [Source track](https://remote.incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1600048) · [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/)
