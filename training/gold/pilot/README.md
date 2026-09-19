# Pilot gold set — 12 NZ product-role cases (2026-09-20)

Hand-written by Claude Fable 5.1 in a Claude Code session (no API credits): each case is a
synthetic candidate (CV + profile.yml) and a job posting at a planned fit level, plus the
gold A–G evaluation in exactly the format the Pi Evaluator is trained to emit.

| # | Company | Fit | Gold | Legitimacy | Split |
|---|---|---|---|---|---|
| 01 | Sharesies — Senior PO | strong | 4.7 | High | train |
| 02 | Fonterra — PM Supply Chain | good | 4.2 | High | train |
| 03 | Xero — Group PM Payments | borderline (over-levelled) | 2.9 | High | train |
| 04 | MSD — PO | poor (under-experienced) | 1.6 | High | train |
| 05 | Halter — PM Rancher App | good | 4.1 | High | train |
| 06 | Lightspeed — PO POS | borderline | 3.6 | High | **exam** |
| 07 | Air NZ — Senior PM Airpoints | strong | 4.8 | High | train |
| 08 | Rocket Lab — PO Mission Ops | poor (export-control blocker) | 1.7 | High | train |
| 09 | Kiwibank via agency — PO/Delivery Lead contract | borderline | 3.5 | Caution | train |
| 10 | Trade Me — PM Trust & Safety | good | 4.3 | High | train |
| 11 | GrowthPay — Head of Product | poor (suspicious posting) | 2.0 | Suspicious | train |
| 12 | Datacom — BA/PO | good | 4.1 | High | **exam** |

Import: `node scripts/import-gold.mjs training/gold/pilot` → `trainingExamples`.

## Pilot run results (dataset `evaluator-pilot-v1`: 10 train / 2 exam, ~2.9k tokens each)

| Model | Score MAE | ±0.5 | Summary block | s/case | Notes |
|---|---|---|---|---|---|
| `llama3.2:3b` (stock), run 1 | 0.45 | 50% | 100% | 223 | answered 3.4 for both cases |
| `llama3.2:3b` (stock), run 2 | 0.20 | 100% (n=1) | 50% | 203 | Lightspeed 3.4 / "Other: Technical AI PM" / High Confidence; no block on Datacom — run-to-run variance is large at n=2 |
| `qwen2.5:1.5b-instruct` (stock) | 0.40 | 100% (n=1) | 50% | 139 | |
| `careerops-evaluator:pilot1-1.5b` (LoRA, 3 epochs, 15 steps, loss 2.14) | 1.10 | 0% (n=1) | 50% | 153 | 4.7 vs gold 3.6; lost the block on Datacom |
| `careerops-evaluator:pilot1-3b` | — | — | — | — | training fails on the RTX 3060 Laptop (6 GB): `CUDA driver error: device not ready` in backward, 3/3 attempts (1.5B trains fine) |

Conclusions: the pipeline works end to end (gold → dataset → LoRA on `gpu` → GGUF → Ollama →
exam), but 10 examples × 15 optimizer steps is far too little to move a model — it degraded
format adherence. Plan: 100–200 gold cases (Claude API `generate_gold`, ~$0.50/case) before the
next fine-tune; prefer the 1.5B base on this GPU, or train 3B elsewhere and use Import.
Infrastructure lessons baked into the job: Python 3.12 venv, detached training with polling,
resumable GGUF fetch, exam parser tolerant of `**KEY:**`.
