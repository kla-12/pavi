# RuFlo v3.5 & Pavi — Project Documentation Guide & Index

> **Status:** Active Master Reference & Sitemapper  
> **Platform Version:** RuFlo v3.5 / Pavi Enterprise  
> **Last Updated:** 2026-09-25  
> This file serves as the primary master directory and navigational roadmap for all system documentation in the project.

---

## 1. Documentation Index & Location Table

All foundational project documentation files reside in the canonical [`docs/`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs) directory:

| Document | Primary Location | Purpose & Core Responsibility | Key Sections Included |
|----------|------------------|-------------------------------|-----------------------|
| **[pre.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/pre.md)** | `docs/pre.md` | **Product Requirements Document (PRD)**: Outlines problem statement, product vision, target audience, and implemented/planned feature scopes. | 1. Executive Summary & Vision<br>2. Target User Personas<br>3. Implemented Features (Swarms, Pavi UI, RuVector, Ollama, PWA)<br>4. Planned Enhancements |
| **[architecture.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/architecture.md)** | `docs/architecture.md` | **System Architecture & Structure**: Explains application topology, routing hierarchy, data flow, micro-APIs, full directory map, and database schemas. | 1. App Flow & Diagrams<br>2. Complete Folder & File Tree<br>3. Tech Stack (Node.js, Express, better-sqlite3, Rust WASM, Ollama)<br>4. Database Schemas (`pavi.db`, `ruvector.db`, `agentdb.db`) |
| **[rules.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/rules.md)** | `docs/rules.md` | **Development & AI Rules**: Strict standards governing developer and AI actions, approved dependency whitelist, fail-closed verification policies, and anti-patterns. | 1. Core Operating Rules<br>2. Concurrency Mandate (1 Message = All Ops)<br>3. Anti-Drift Swarms (Hierarchical, Raft, 3-Tier Routing)<br>4. Code Quality & Security Standards |
| **[phases.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/phases.md)** | `docs/phases.md` | **Project Phases & Roadmap**: Comprehensive tracking of completed phases (0 through E), active phase (Phase F Hive Mind), and forward roadmap. | 1. Phase Overview Matrix<br>2. Completed Phase Deliverables (Phases 0–E)<br>3. Active Phase F (Autonomous Hive Mind)<br>4. Forward Roadmap (Distributed Swarms & Sandboxing) |
| **[design.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/design.md)** | `docs/design.md` | **Design System & UI Specs**: Single source of truth for visual tokens, dark cyberpunk glassmorphic palette, typography scales, and UI components. | 1. Visual Philosophy & Glassmorphism<br>2. Color Palette & Gradients<br>3. Typography Scale & Fonts (Outfit, Inter, JetBrains Mono)<br>4. Mobile PWA & Touch Rules (44px targets) |
| **[memory.md](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/memory.md)** | `docs/memory.md` | **Session Memory & Progress Log**: Persistent state bridge between sessions. Tracks active files, historical changelogs, configuration parameters, and open technical debt. | 1. Current System Status<br>2. Active & Monitored Files<br>3. Historical Changelog & Recent Bugfixes (ngrok, auth removal, Ollama)<br>4. Key Config & Facts<br>5. Open Technical Debt |

---

## 2. Navigational Direction & Usage Guide

### When to Consult Each File

```
                                  [START HERE]
                                       │
                                       ▼
                             ┌──────────────────┐
                             │  docs/memory.md  │ ──► Understand recent work, active server state,
                             └──────────────────┘     and current technical debt / bugfixes.
                                       │
                                       ├─────────────────────────────────────┐
                                       ▼                                     ▼
                             ┌──────────────────┐                  ┌──────────────────┐
                             │   docs/pre.md    │                  │  docs/rules.md   │
                             └──────────────────┘                  └──────────────────┘
                                       │                                     │
                        Understand product scope,              Check approved libraries,
                        user roles, and capabilities.          AI boundaries & anti-drift rules.
                                       │                                     │
                   ┌───────────────────┴───────────────────┐                 │
                   ▼                                       ▼                 ▼
         ┌───────────────────┐                   ┌───────────────────┐       │
         │docs/architecture.md│                   │  docs/phases.md   │       │
         └───────────────────┘                   └───────────────────┘       │
                   │                                       │                 │
            Inspect folder tree,                     Track milestone         │
            APIs, and data models.                   progress & roadmap.     │
                   │                                       │                 │
                   └───────────────────┬───────────────────┘                 │
                                       ▼                                     ▼
                             ┌──────────────────┐                  ┌──────────────────┐
                             │  docs/design.md  │                  │  Implementation  │
                             └──────────────────┘                  │  & Code Editing  │
                                       │                           └──────────────────┘
                              Apply dark glassmorphic tokens,
                              typography & UI components.
```

1. **Before Starting Any Development Task:**
   - Read [`docs/memory.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/memory.md) to understand current daemon status, recent bugfixes, and active files.
   - Review [`docs/rules.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/rules.md) for anti-drift guidelines, 1-message concurrency rules, and fail-safe process spawning.

2. **When Building Features or Expanding Endpoints:**
   - Check [`docs/pre.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/pre.md) for feature scope and persona requirements.
   - Check [`docs/architecture.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/architecture.md) for router placement, SQLite schema definitions, and WASM engine integration.
   - Check [`docs/design.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/design.md) for cyberpunk glassmorphic CSS variables, gradients, and touch target rules.

3. **At the Conclusion of a Working Session:**
   - Update [`docs/memory.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/memory.md) with newly resolved bugs, modified files, and updated state.
   - If milestones were reached, update [`docs/phases.md`](file:///c:/Users/sabri786/Desktop/ruflo-main/ruflo-main/docs/phases.md).
