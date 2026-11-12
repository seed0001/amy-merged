# Jev for Amy's face: research notes (2026-11-07)

Requested by Owner in voice, after friend_11 suggested taking the face out of the language model's hands
and driving it with a small fast model. Numbers marked **measured** were run on this machine against
her real logs. Everything else comes from the vendor or model pages and is self-reported.

## Bottom line

- Jev **is** on OpenRouter. It is easy to miss because it is not a chat model: it does not appear in the
  normal chat model list (`/api/v1/models` only shows `typesafe/jev-router`) and uses its own endpoint.
- Jev has **no facial controls of its own**. It picks from options we give it, so the count is whatever
  we define. Amy's avatar has 72 shapes, driven by 14 presets, 10 gestures and 6 gaze directions.
- Realistic use is **3 to 5 calls per turn**, at about **$0.04 per 1,000 calls**.
- The test was only 40 turns, and "agreement" is against her own tags, not a ground truth.

## What Jev is

Jev is a closed, hosted "System One" decision model from TypeSafe, released September 2026 (1.14 is
current). You send it state plus typed questions, and it returns probabilities: Choice, Noul (yes/no),
Score, or Box (locate something in an image). It writes no text and cannot replace her main brain.
friend_11's "it only generates one token" is about right: one decision per question, no decoded text.

- OpenRouter ID: `typesafe/jev-1.14` (or `~typesafe/jev-latest`), `POST https://openrouter.ai/api/alpha/decisions`.
  The endpoint is labelled alpha, so its shape may change.
- Price: $0.042 per million input tokens, output free. Reported limit: 1,200 requests a minute.
- Vendor latency claim 70 to 500 ms. One independent test saw 0.8 to 0.9 s through a gateway; we measured far better.
- Known weak spots: literal reading, arithmetic, multi-hop reasoning. Independent tests found its
  confidence numbers are not well calibrated, so do not lean on them for thresholds.

## Facial controls

| Layer | Count | Driven by today |
| --- | --- | --- |
| Avatar shapes in her GLB | 72 (15 mouth visemes + 57 others) | - |
| Face presets | 14 | `avatar_expression` tool on the main model |
| Gestures | 10 | same |
| Gaze directions | 6 | same |
| Feelings seen in her tags | 24 | word lists in `src/microexpression.js` |
| Lip sync | 15 visemes, every frame | browser, from the audio, no AI call |

Jev would choose feeling, strength and gesture, at sentence rate. It should not touch lip sync or blinks:
those run per frame and need no model. The face model slot in `src/inner-models.js` also has no trained
model yet (219 examples in `data/inner-models/face.jsonl`, no `face/` model), so word lists run today.

## How many calls (from `data/activity.jsonl`, 2026-11-02 to 11-07)

- 487 voice replies: about 97 per active day, peak 240, median 15 per active hour, max 37.
- A reply is typically 29 words and 3 sentences; the 90th percentile is 92 words and 6 sentences.
- Since the avatar logging began: 93 voice replies, 74 mood updates (free, local), 38 `avatar_expression`
  tool calls, 8 logged failures.

Plan: one call per sentence plus one reaction to what she heard, each asking feeling, strength and
gesture together. That is **3 to 5 calls per turn, about 7 on a long reply**, and about 420 a day on
average or 1,030 at peak.

| | Per call | Average day | Peak day | $10 buys |
| --- | --- | --- | --- | --- |
| Jev, three questions per call | $0.00004 | $0.017 | $0.04 | about 250,000 calls |

One Grok 4.20 round today carries about 34,000 prompt tokens (about 20,450 are tool definitions), or
about $0.04 uncached and $0.007 fully cached. A single tool round therefore costs as much as roughly 180
to 1,000 Jev calls. Moving the face off the main model should also shorten her replies, because a
`avatar_expression` call no longer holds up a turn.

## Measured on this PC (AMD RX 9070 XT, Ollama)

Same real turns from `face.jsonl`. "Agreement" means the pick matched her top logged feeling (16 options).

| Model | Latency median / p90 | Agreement | Questions per call | Where |
| --- | --- | --- | --- | --- |
| Jev 1.14 | 141 / 179 ms | 16 of 40 (21 in her tag set) | 3 | OpenRouter |
| OpenJev Flash 9B Q4 | 136 / 149 ms | 15 of 40 (22 in her tag set) | 1 | local, 5.3 GB VRAM |
| qwen3:0.6b | 166 / 184 ms | 5 of 20 (10 in her tag set) | 3 | local |
| qwen3:4b | 885 / 937 ms | 5 of 20 (9 in her tag set) | 3 | local |

- All 40 Jev calls succeeded, averaging about 935 input tokens, total cost $0.0016.
- Jev matched 8 of 25 logged gestures, but several tagged gestures (wink, sigh, laugh, eyeroll) were not
  options in this test, so that number is not meaningful yet.
- OpenJev asks one question per call, so feeling + strength + gesture is about 400 ms in a row. Its first
  call took 5.2 s to load the model, so it would need to stay loaded, holding 5.3 GB of the card.
- The local chat models used 20 samples, not 40, so treat those rows as rough.
- OpenJev's strict JSON typed API is not available through GGUF; the test read the answer letter directly.

## Local alternatives

- **OpenJev Flash 9B GGUF**: best local match. Installed in Ollama as
  `hf.co/openjev/OpenJev-Flash-9B-GGUF:Q4_K_M` (5.6 GB). Licence CC BY-NC 4.0, so non-commercial only.
- **JEV-9B / JEV-27B** (AutoTrust, Apache-2.0): closest to Jev, but 18 GB and 54 GB and benchmarked on
  data centre GPUs with vLLM. Not stated for AMD consumer cards.
- **LAM A2E** (Apache-2.0, 192 MB): a different approach. It turns audio into all 52 ARKit shapes at 30 fps
  and runs in the browser on WebGPU, with no calls at all. No published latency, and not tested here.
  It would add speech-driven expression rather than deciding mood, and could sit alongside Jev.
- **NVIDIA Audio2Face-3D**: open weights, benchmarked on RTX cards, so a poor fit for his AMD GPU.
- **EchoAvatar**: 52 shapes plus body, 216 ms per 266 ms of audio on an RTX 4090. Heavy, and untested on AMD.

## Recommendation

Use Jev through OpenRouter for the sentence-level face: it is as fast as local, costs almost nothing,
needs no VRAM, and answers all three questions in one call. Keep OpenJev Flash as the fallback when
OpenRouter is down or out of credit. Leave lip sync as it is. Nothing is wired in yet; this was research only.
Note that her conversation text would go to TypeSafe through OpenRouter on each call.

## Sources

- [Jev on OpenRouter](https://openrouter.ai/docs/guides/community/jev) and its [tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial)
- [Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md)
- [Jev 1.13 on OpenRouter](https://openrouter.ai/typesafe/jev-1.13)
- [SocialVik: what Jev costs and where it breaks](https://www.socialvik.com/blog/typesafe-jev-system-one-model)
- [OmniaKey: Jev explained](https://omniakey.com/blog/jev-model-explained)
- [Jev vs Laya](https://huggingface.co/blog/sora-2/jev-vs-laya-hosted-api-or-open-weights-2026-guide)
- [OpenJev](https://huggingface.co/openjev) and [Flash 9B GGUF](https://huggingface.co/openjev/OpenJev-Flash-9B-GGUF)
- [JEV-9B](https://huggingface.co/autotrust/JEV-9B), [JEV-27B](https://huggingface.co/autotrust/JEV-27B)
- [LAM A2E](https://huggingface.co/adolon-ai/lam-a2e)
- [EchoAvatar](https://arxiv.org/abs/2605.28272), [Audio2Face-3D](https://arxiv.org/abs/2508.16401)
