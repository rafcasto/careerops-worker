# careerops-worker

Raspberry Pi worker behind the **JHG Compass → CareerOps portal**. Polls the `JHG-Compass`
Upstash Redis queue and runs the career-ops agents through n8n + Ollama. The Researcher
(deep, contacto) gets web search from Claude when the Pi has either an `ANTHROPIC_API_KEY`
**or a logged-in Claude Code CLI** (no key — your subscription):

```bash
curl -fsSL https://claude.ai/install.sh | bash   # installs ~/.local/bin/claude
claude login                                     # once, as the user the service runs as
systemctl --user restart careerops-worker        # Admin → CareerOps → Overview shows "Claude: cli"
```

Design and phases:
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
| Tailoring → apply | `apply` (+ `pdf`, `cover`) | Writer + answer bank | note `apply` (+ `data.answers[]`, reused / needs-you flags) |
| Tailoring → apply → read the form | `apply_form` | script (browser) | note `apply_form` (+ `data.questions[]`, files, account gate) |
| Tailoring → apply → fill it in the portal | `apply_fill` | script (browser, signed in) | note `apply_fill` — the application typed into the portal as a draft up to Review; never submitted |
| Tracking → interview-prep | `interview_prep` | Evaluator | note `interview_prep` |
| Tracking → followup | `followup` | Writer | note `followup` (+ `data.body`) |
| Tracking → patterns | `patterns` | Evaluator | note `patterns` (+ `data.stats`) |

Notes land in `users/{uid}/careerOpsNotes/{jobId}`. Task prompts live in `lib/prompts.js`;
the model per agent is chosen in Admin → CareerOps → Models. n8n agent workflows must be
named `careerops/<agent>` (`careerops/evaluator`, …) so the worker can report which are active.

Portal accounts (vault) can also be added from the Pi when the site is unavailable:

```bash
node scripts/vault-add.mjs rafael@example.com westpacnz.wd105.myworkdayjobs.com you+westpac@example.com   # prompts for the password
```

```bash
npm run check   # syntax
npm test        # unit tests (patterns stats, prompt builders, job registry)
```
