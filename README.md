# careerops-worker

Raspberry Pi worker behind the **JHG Compass → CareerOps portal**. Polls the `JHG-Compass`
Upstash Redis queue and runs the career-ops agents through n8n + Ollama (and Claude with
web search for the Researcher when `ANTHROPIC_API_KEY` is set). Design and phases:
`jhg-compass/docs/CAREER_OPS_AGENTS.md`.

```bash
cp .env.example .env            # fill in Upstash + Firebase values
npm install
node worker.js                  # foreground
# or as a service:
cp deploy/careerops-worker.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now careerops-worker && journalctl --user -fu careerops-worker
```

## Jobs

| portal tool | job type | agent | output |
|---|---|---|---|
| Sourcing → scan | `scan` | Scout (script) | `careerOpsPipeline` |
| Sourcing → pipeline | `evaluate` + `autoPipeline` | Evaluator → Tailor | report · board card · PDF ≥ 4.0 |
| Sourcing → deep | `deep` | Researcher | note `deep` |
| Scoring → oferta / ofertas / batch | `evaluate` | Evaluator | `careerOpsReports` |
| Scoring → training / project | `advise` | Evaluator | note `training` / `project` |
| Tailoring → contacto | `contacto` | Researcher | note `contacto` (+ `data.dm`) |
| Tailoring → pdf | `pdf` | Tailor | `careerOpsDocs` |
| Tailoring → apply | `apply` (+ `pdf`, `cover`) | Writer | note `apply` (+ `data.answers[]`) |
| Tracking → interview-prep | `interview_prep` | Evaluator | note `interview_prep` |
| Tracking → followup | `followup` | Writer | note `followup` (+ `data.body`) |
| Tracking → patterns | `patterns` | Evaluator | note `patterns` (+ `data.stats`) |

Notes land in `users/{uid}/careerOpsNotes/{jobId}`. Task prompts live in `lib/prompts.js`;
the model per agent is chosen in Admin → CareerOps → Models. n8n agent workflows must be
named `careerops/<agent>` (`careerops/evaluator`, …) so the worker can report which are active.

```bash
npm run check   # syntax
npm test        # unit tests (patterns stats, prompt builders, job registry)
```
