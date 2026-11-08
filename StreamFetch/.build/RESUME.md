# StreamFetch 1.0.0 — build state at the pause of 2026-11-08 23:43 UTC

Temporary folder: the build's working papers, removed before the PR leaves draft. `SPEC-1.0.0.md` is the
binding specification (with Addendum A: bilibili.tv, the SnapAny-like page, the owner's link rules);
`workflow.js` is the orchestration script (Implement → Integrate → Review + Docs → Fix → Verify).

## Finished and committed (their own tests and a scoped strict type check green)

- impl:B-parsers
- impl:A-lib-core
- impl:C2-mp4
- impl:C1-ts-demuxer

## Interrupted mid-work (files on disk are PARTIAL: read them, then complete them against the spec)

- impl:D-app — `extension/manifest.json`, `_locales/*`, `icons/`, `tools/make_icons.py`, `src/app/*`, `types/chrome.d.ts`, the app tests
- impl:E-e2e — `tests/conftest.py`, `tests/fake_sites.py`, `tests/extension_harness.py`, `tests/e2e_checks.py`, `tests/encrypted_mp4.py`, `tests/test_*.py`, `pyproject.toml`

## Not started

- impl:B2-bilibilitv (lib/bilibilitv.js + fixtures + tests; extends urls/naming/report/messages per Addendum A)
- the integrator, the three reviewers, the docs writer, the fixer, the verifier (see workflow.js)

## How to resume

Re-launch `workflow.js` with `resumeFromRunId: "wf_77787957-c9f"` when the run's journal still exists (A, B, C1, C2
return from cache; D, E, B2 and the rest run live — tell D and E in their prompts that partial files exist), or
re-launch the script from scratch with the same note. Everything the spec needs is in this folder.
