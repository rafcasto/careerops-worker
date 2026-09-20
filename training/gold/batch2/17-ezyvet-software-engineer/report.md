## Block A — Role summary
| Company | Role | Archetype | Domain | Function | Seniority | Remote | Location | Team size | Culture screen | Work authorization |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ezyVet (IDEXX) | Senior Software Engineer — Backend (PHP/Go) | Other: Backend Software Engineer | Healthcare SaaS (veterinary practice management) | Build (backend engineering, tech lead for a squad) | Senior | Hybrid | Auckland | 6 (squad) | pass — explicit reliability commitments, mentoring expectation, defined stack | ➖ Not needed — "Right to work in New Zealand required"; candidate authorised in NZ |

TL;DR: A senior backend role that mirrors the candidate's monolith-to-services work on AWS, with pay inside his target; Go is the one gap and the JD accepts PHP-first engineers willing to learn it.

## Block B — Match with CV
| Requirement | Importance | Match | JD signal | Evidence / gap |
| --- | --- | --- | --- | --- |
| 6+ years backend; strong in PHP or Go, willing to work in both | critical | ✅ Strong | "strong in PHP or Go and willing to work in both" | Eight years PHP; "no production Go" — the JD's "or" is satisfied by PHP, willingness must be stated |
| AWS services (ECS/EKS, RDS, SQS) with infrastructure as code | critical | ✅ Strong | "ECS/EKS, RDS, SQS … infrastructure as code" | Invoicing service on ECS with RDS and SQS; Terraform ownership |
| Improved reliability or performance of a high-traffic system, with numbers | high | ✅ Strong | "with numbers" | p95 1.9s → 0.75s; incident count −45%; 99.9% SLO on-call lead |
| Testing practice and CI/CD ownership | high | ✅ Strong | "unit, integration, contract" | Contract tests for payments and calendar integrations; owned GitHub Actions |
| Lead technical design, review, mentor | high | ✅ Strong | "Lead technical design for your squad … mentor" | Ran design reviews; mentored three engineers |
| Healthcare / practice-management / integration-heavy SaaS (plus) | meaningful | ⚠️ Partial | "integration-heavy SaaS is a plus" | Integration-heavy yes (Xero, MYOB, payments, calendar); no healthcare |
| Go | meaningful | ❌ Missing | "new Go services" | None in production |

## Block C — Level strategy
- At level: senior with squad tech-lead duties matches his Timely scope; "Staff" is the next step, not this one.
- Position the invoicing-service extraction as exactly the carve-out the JD describes, and say plainly that he'll pick up Go on the new services — back it with a small public Go project before interviewing.
- Ask what proportion of the squad's work is Go today versus in a year; it decides how fast the gap matters.

## Block D — Compensation
- Company type: subsidiary of a public company (IDEXX) · comp reliability: High (explicit band plus listed-company equity)
- Advertised range: NZ$150,000–175,000 plus equity
- Estimated market range (estimate): NZ$145,000–180,000 for senior backend engineers in Auckland
- vs candidate: target NZ$155,000–180,000 overlaps most of the band; minimum cleared.

## Block E — Personalisation
- Rewrite the summary to mirror "carving a monolith into services on AWS", "reliability", "integrations".
- Lead with: p95 1.9s → 0.75s, incident count −45%, invoicing service extraction with contract tests.
- Mirror keywords: ECS, RDS, SQS, Terraform, contract tests, 99.9%, post-incident reviews, mentoring.

## Block F — Interview prep
1. "Walk us through a service extraction." — Invoicing out of the Laravel monolith: strangler pattern, dual-write phase, contract tests, cut-over, the latency result.
2. "Tell us about an incident you led." — The SQS backlog incident: detection, mitigation, the alerting change; 45% incident reduction programme.
3. "You've not written Go in production — how will you close that?" — Direct answer plus evidence: a Go side project, familiarity from reviewing, and the TypeScript/PHP-to-Go mapping he has already studied.

## Block G — Posting legitimacy
Tier: High Confidence. Precise stack, squad size, availability commitments, explicit band and equity from a listed parent.

## Verdict
Global score 4.2/5 · Both critical requirements are met and every high one is backed by numbers; the Go gap is real but explicitly tolerated by the JD · Apply.

---SCORE_SUMMARY---
COMPANY: ezyVet (IDEXX)
ROLE: Senior Software Engineer — Backend (PHP/Go)
SCORE: 4.2
ARCHETYPE: Other: Backend Software Engineer
LEGITIMACY: High Confidence
---END_SUMMARY---
