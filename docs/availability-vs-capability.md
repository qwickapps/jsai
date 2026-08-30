# Availability is not capability: the real cost of finding out

**Source:** hackathon2-lead, Sundai Hack 138 project 2 (Boston 311 MCP demo), 2026-08-30.
**Audience:** browserai-lead (not yet stood up as of this writing) — founding input for the
JS layer resolving across Chrome built-in AI, an extension tier, in-page WebGPU, a local
service bridge, and remote-as-last-resort.
**Why this exists:** requested by qwickapps-manager after a live measurement surfaced a
concrete number for a claim that was previously only qualitative.

## The claim, made concrete

"A tier being *available* (the API exists, the GPU adapter is granted, the endpoint
answers) does not mean it is *capable* of the task you actually need." That statement was
already the working thesis behind browserai-lead. What was missing was a real number for
what it costs to find out the difference — because if establishing capability is cheap,
a resolver can just try-and-see at runtime; if it's expensive, it can't.

## What was measured

Project 2's PWA (<https://sundai-hack138-2-gw.route.qwickforge.com/>, source
`raajkumars/sundai-hack138-boston311-mcp`) runs a two-arm comparison: the same small
on-device model either (A) receives a raw MCP `tools/list` and must choose a tool call
itself, or (B) does one narrow language task while deterministic code owns MCP orchestration
(a "Purpose Pack"). Both arms went through a WebGPU backend: transformers.js running
`onnx-community/SmolLM2-135M-Instruct-ONNX` (q4 quantization) entirely in-browser.

Availability detection for this tier — `navigator.gpu.requestAdapter()` succeeding — took
well under a second and correctly reported `available: true`.

Capability, for the same tier, on the same model, was a different story:

- **Arm B (purpose-compiled)**: the model was asked to do one thing — paraphrase a civic
  complaint in one short sentence — and deterministic code handled category classification,
  location extraction, and the MCP call. This succeeded reliably and quickly (single-digit
  seconds).
- **Arm A (direct agent)**: the same model, given the raw tool list, was asked to choose a
  tool and construct arguments itself. It could not produce a valid tool call. The app's
  retry structure (2 steps, each an attempt plus one repair generation) ran to completion —
  4 sequential real local generations — before correctly reporting the failure. **Wall time
  to establish that this tier cannot do this task: approximately 290 seconds.**

This was not a hang, a bug, or a timeout misconfiguration. It was verified live in a
headless real browser (Playwright) with a 10-second progress heartbeat confirming the app
was actively generating throughout, and the end state was a correct, honestly-reported
failure — not an error, not a crash. The app is *designed* to measure exactly this
comparison (Arm A struggling while Arm B succeeds is the intended finding), and it worked
as designed.

## What survives this measurement, and what does not

Read this section before citing anything above. Two separate claims got bundled into "290
seconds," and they do not carry equal weight.

**Survives, regardless of the exact number: the distinction itself.** Availability
detection (is the API present, is there an adapter) is a cheap, static check. Capability
detection (can this backend actually do this task) requires running the task for real, and
that is categorically a different, more expensive operation — with a cost that scales with
retries, task complexity, and how many sequential generations a failure takes to surface.
That structural claim holds whether the true number is 290 seconds or 3.

**Does not survive unexamined: the headline figure itself.** See "Honest caveats" below —
in particular, whether the run actually executed on WebGPU or silently fell back to WASM
(roughly 100x slower) was never confirmed. If it fell back, 290s measures the wrong thing:
not "capability detection is expensive" but "we accidentally measured the slow path," and
the true cost on genuine WebGPU could be single-digit seconds. **Do not design a caching
strategy, a timeout budget, or an SLA around 290 seconds specifically until someone confirms
which backend actually executed.** Treat the number as evidence that capability detection
is expensive *in kind*, not as a calibrated constant.

## Honest caveats — read before citing the number

- **Hardware and contention, stated plainly so the number can be recomputed if disputed:**
  Apple M4, 24GB RAM, macOS 26.5.2, hostname `macmini-dev.local`. At the time of this
  measurement the host was running **48 concurrent chromium/codex/claude processes**
  (`ps aux` count) as part of normal fleet activity that day — this is a shared devserver
  under real, uncontrolled load, not a clean single-purpose benchmark rig. A less-loaded
  machine, or a real user's own dedicated laptop, would likely be faster even on the same
  backend. This alone would make 290s an upper bound, not a clean number — and it compounds
  with the WASM-fallback uncertainty below, which could change the number by orders of
  magnitude rather than a constant factor.
- **Genuine measurement gap — I could not confirm which device actually executed
  generation.** `navigator.gpu.requestAdapter()` returned a real adapter (so `webgpu` was
  attempted), and the code's WASM-fallback path is a caught exception that was not
  triggered as far as I could tell — but I did not add an explicit device-confirmation log,
  and ONNX Runtime Web's routine partial-CPU-op-placement warnings appear in logs
  regardless of whether the run is genuinely GPU-accelerated or has silently fallen back.
  I am **not** claiming this was confirmed hardware-accelerated WebGPU execution start to
  finish. If it silently fell back to WASM, the 290s number is a WASM-speed number wearing
  a WebGPU label, which would be a materially different (probably worse) claim about
  WebGPU capability specifically, versus a claim about small-model tool-calling capability
  in general (which the number supports either way).
- **This is one model, one task shape, one tier.** SmolLM2-135M is small even among "small
  models"; it wasn't tested against Chrome's actual built-in Prompt API (Gemini Nano) at
  all — see the open item below.

## Design requirement, not just a caveat: the resolver must report what actually ran

The WASM-fallback uncertainty above is not only a gap in this measurement — it is itself
the finding, and it generalizes.

I could verify the *behavior* (a correct extraction, a correct failure) but not *which
backend produced it*. That is the same shape of failure that showed up repeatedly
elsewhere in this fleet on the same day: a merge that looked done but wasn't deployed, a
deploy confirmed by HTTP 200 that turned out to be serving a placeholder body, a service
rescaled to 1/1 that was actually crash-looping, a container scaled to zero while every
outward check still said healthy, a disk checked on the wrong filesystem, a function
believed fixed that was never actually called by anything. Different systems, same root
shape: **the thing that was supposed to happen was confirmed by proxy, not observed
directly.** This measurement is another instance of it, not a special case — verified the
output, could not verify the execution path that produced it.

So: **the first hard requirement for this library is that whichever backend handles a
request must be observable, at runtime, by the calling app — not which tier the resolver
*selected*, which one actually *executed*.** If WebGPU is chosen but silently falls back to
WASM inside the inference library (as happened, unverifiably, in this project's own code),
the resolver must surface that fallback as a real signal the host app can read and act on
(log it, show it, downgrade the UX, whatever) — not swallow it the way this library's own
`chatWebgpu`/`loadWebgpuGenerator` currently does (tracked as an open TODO). Without this, a
developer using the library ships an app that silently runs 100x slower than intended, with
no signal anywhere that it happened, and neither they nor their users will ever know why it
feels wrong. If we could not tell WebGPU from WASM in our own single-purpose instrumented
app, a general-purpose library's callers will not be able to either, unless the library
makes it a first-class, unavoidable-to-ignore output of every call.

## The distinction that changes the design

**Availability detection is cheap**: is the API present, is there a GPU, does the local
service answer. Milliseconds, safe to run on every page load, safe to run repeatedly.

**Capability detection is expensive**: does the model, on this task shape, actually produce
a correct result. The 290s here is capability detection for exactly one task shape (MCP
tool selection + argument construction) on exactly one small model. There is no cheap way
to ask "is this tier good enough for what I'm about to do" at runtime before doing it — you
have to essentially attempt the real task to find out, and if it fails, the cost of finding
that out is the cost of the attempt (here: multiple sequential generations, not one).

**Consequence for a resolver product**: it cannot be "probe capability at runtime, then
route." No developer will accept a 290s (or even 30s) delay before their app starts working,
just to let the resolver decide which backend to hand them. The real design space is
something like:

1. **Cached, per-machine (or per-model-class) capability results** — measure once, offline
   or on first real use, persist the verdict, don't re-measure every page load. Requires
   deciding what invalidates a cached verdict (model version, driver update, browser
   update).
2. **Task-shape heuristics** — classify the request (simple paraphrase/summarize vs.
   multi-step tool orchestration vs. long-context reasoning) and route by known-weak/known-
   strong task classes per tier, without probing the specific model on the specific input.
   This project's own architecture is a working example: it never asks the small model to
   do agentic tool selection directly (Arm B's whole point) — that's a task-shape decision
   made in advance, not discovered at runtime.
3. **Optimistic-with-fast-fallback** — attempt the cheap/preferred tier with a short,
   bounded timeout and a cheap-to-detect failure signature (e.g., malformed output on the
   first generation), fall back immediately rather than retrying to exhaustion. This
   project's own 4-generation retry-to-exhaustion behavior is the shape to avoid for a
   production resolver — it's correct for a benchmarking tool that wants the full picture,
   wrong for something trying to get a user to a working answer fast.

Which of these (or what combination) is right is a real design question this document
doesn't answer — it exists to make sure that question gets asked with a real number
attached, instead of being decided on vibes.

## Open item this doesn't cover

Chrome's built-in Prompt API (Gemini Nano) was never evaluated against this same task —
neither availability (hardware bar, ~60% of machines per public docs) nor capability (its
documented practical band is roughly <500 tokens in / <200 out, with known reasoning
weakness — MCP tool calling may simply exceed that band the same way SmolLM2-135M did).
That test is planned as a separate follow-up and will use this same task/eval harness so
the numbers are comparable.

## Pointers

- Consumers: `raajkumars/sundai-hack138-boston311-mcp` (branch `work`), and pending
  `raajkumars/sundai-hackathon-2026-08-30`
- The comparison harness that produced this finding lives in the project-2 repo:
  `purpose-compiler.js`, `direct-agent.js`, `run-metrics.js`
- The backend cascade that made this a one-line test (`activeTier = 'webgpu'`, everything
  else unchanged): `backend-selector.js` in this repo
- Raw test transcript referenced in this write-up: Playwright run against
  `http://localhost:8899`, 2026-08-30, 10s heartbeat log, `t=290s` first non-disabled state.
