# Development Standards & Operating Rules — RuFlo & Pavi

> **Status:** Mandatory Enforcement Policy  
> **Platform Version:** RuFlo v3.5 / Pavi Enterprise  
> **Last Updated:** 2026-09-25

---

## 1. Core Operating Rules (Always Enforced)

1. **Strict Scope Discipline:** Do exactly what has been asked; nothing more, nothing less. Never introduce unrequested architectural refactors.
2. **File Creation Restraint:** Never create files unless they are explicitly requested or strictly required to achieve the user's objective.
3. **Prefer In-Place Edits:** Always prefer editing an existing file to creating a new one.
4. **No Root Littering:** Never save working files, scratch scripts, tests, or documentation in the repository root folder. Always use the canonical directory structure:
   - Source code: `/src` or `/dashboard`
   - Documentation: `/docs`
   - Test suites: `/tests`
   - Utility scripts: `/scripts`
5. **Read Before Writing:** Always view and inspect existing file contents and context before modifying code.
6. **Zero Secrets in Git:** Never commit API keys, tokens, session cookies, or `.env` files to git.

---

## 2. Concurrency Mandate: 1 Message = All Related Operations

To optimize latency, token usage, and swarm coordination:
* **Batch Operations:** Always execute all related tool calls together in a single step whenever feasible.
* **Batch Spawning:** When launching agents, define and spawn all required agents concurrently with complete role definitions.
* **Batch Storage Operations:** When storing or querying vector embeddings or database records, batch transactions into single calls.

---

## 3. Swarm Orchestration & Anti-Drift Guidelines

When constructing or modifying agent swarms, adhere to the **Anti-Drift Coding Swarm** pattern:

| Parameter | Mandatory Standard | Rationale |
|-----------|--------------------|-----------|
| **Topology** | `hierarchical` | Strict coordinator-worker chain prevents infinite circular loops |
| **Max Agents** | `6 - 8` | Prevents token explosion and excessive inter-agent communication overhead |
| **Consensus Protocol** | `raft` | Single leader maintains authoritative state; workers vote on proposals |
| **Execution Strategy** | `specialized` | Distinct roles (Coder, Reviewer, Tester) prevent role confusion |
| **Checkpoints** | `post-task` hooks | Verification gate after each step verifies build and test health |

### 3.1 3-Tier Model Routing Protocol (ADR-026)

Always route agent tasks according to cognitive demand:
* **Tier 1 — Agent Booster (Rust WASM):** Zero cost, `<1ms` latency. Used for standard AST transformations (`var-to-const`, `add-types`, `add-error-handling`). Skip LLMs entirely for these operations.
* **Tier 2 — Fast Local/Cloud Tier (`phi3:mini`, Haiku):** Low latency, zero or minimal cost. Used for formatting, initial drafting, and status checks.
* **Tier 3 — Heavy Reasoning Tier (Sonnet, Opus, Qwen 72B):** Used exclusively for high-complexity tasks: system architecture, multi-file refactoring, and security audits.

---

## 4. Code Quality & Security Standards

### 4.1 Process Spawning & Error Handling
* Any invocation of external binaries (e.g., `ngrok`, `ollama`, `docker`) via `spawn()` or `exec()` must implement explicit `.on('error', ...)` handlers.
* **Fail-Safe Principle:** If an optional background utility (such as `ngrok`) is not installed or fails with `ENOENT`, the core application must log a warning and continue normal localhost operation without crashing.

### 4.2 Database Access & Integrity
* All SQLite queries in `dashboard/db.js` must use **parameterized prepared statements** (`db.prepare(...)`). Never concatenate raw strings into SQL queries.
* Database connections must enable **WAL mode** (`db.pragma('journal_mode = WAL')`) and a busy timeout of at least `5000ms`.

### 4.3 Input Sanitization & Sandboxing
* Any code execution service (e.g. `code-runner` plugin) must execute inside a restricted sandbox with timeouts and memory caps.
* Webhook endpoints (e.g. `/webhooks/github`) must verify HMAC signatures against `GITHUB_WEBHOOK_SECRET`.

---

## 5. Approved Technology Whitelist

| Category | Approved Libraries / Tools | Prohibited Alternatives |
|----------|----------------------------|-------------------------|
| **Node.js Runtime** | Node.js `>=20.0.0` | Node.js `<18` |
| **Database** | `better-sqlite3` | Raw `sqlite3` (unbuffered/slow) |
| **Schema Validation** | `zod` | Unchecked `any` objects |
| **Testing** | `vitest` | Heavy legacy test runners |
| **Logging** | `pino`, `pino-pretty` | Uncontrolled `console.log` in production |
| **Local LLM Runner** | `ollama` | Untracked raw python bindings |
