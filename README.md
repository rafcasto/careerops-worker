# careerops-worker

Raspberry Pi worker for **JHG Compass → Agents**. Polls the `JHG-Compass` Upstash
Redis queue and runs career-ops agents through n8n + Ollama. Design and phases:
`jhg-compass/docs/CAREER_OPS_AGENTS.md`.

```bash
cp .env.example .env            # fill in Upstash + Firebase values
npm install
node worker.js                  # foreground
# or as a service:
cp deploy/careerops-worker.service ~/.config/systemd/user/ && systemctl --user daemon-reload
systemctl --user enable --now careerops-worker && journalctl --user -fu careerops-worker
```

n8n agent workflows must be named `careerops/<agent>` (`careerops/evaluator`, …)
so the worker can report which are active.
