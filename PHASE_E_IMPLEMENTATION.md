# Phase E: Mobile Remote Control — Progressive Web App (PWA)

> See full plan at: C:\Users\MR HACKER\.gemini\antigravity\brain\831e0b96-cabd-47ee-bce8-7a0d22c69668\implementation_plan.md

## Summary of Scope

| # | Component | Files | Priority |
|---|-----------|-------|----------|
| 1 | PWA Manifest + Icons | `pwa/manifest.json`, `pwa/*.png` | P0 |
| 2 | Service Worker (offline + push handler) | `pwa/sw.js` | P0 |
| 3 | Web Push Notifications backend | `services/push-notifications.js`, `routes/push.js`, `db.js` | P1 |
| 4 | Mobile PIN Login | `mobile-login.html`, `routes/auth.js`, `middleware/auth.js` | P1 |
| 5 | Swarm Control Tab + Cancel Action | `mobile.html`, `routes/swarm-control.js`, `swarm-orchestrator.js` | P1 |
| 6 | Phase D CI/CD Mobile Tab | `mobile.html`, `routes/phase-d-status.js` | P2 |
| 7 | Install Prompt + iOS Guide | `mobile.html` | P2 |
| 8 | Background Sync (offline notes) | `mobile.html`, `pwa/sw.js` | P2 |
| 9 | Integration Tests | `tests/integration/phase-e.test.js` | P1 |

**Estimated effort: 3–4 days**
