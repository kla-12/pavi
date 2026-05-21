const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, PageBreak, Header, Footer, Tab,
  TabStopType, TabStopPosition, UnderlineType
} = require('docx');
const fs = require('fs');

// ── Color palette ──
const C = {
  black:    "000000",
  white:    "FFFFFF",
  dark:     "0D1117",
  accent:   "00B894",   // teal-green
  warn:     "E17055",   // orange-red
  muted:    "636E72",
  light:    "DFE6E9",
  bg1:      "F0FAF8",   // very light teal bg
  bg2:      "FFF5F2",   // very light coral bg
  bgGray:   "F4F6F8",
  border:   "B2BEC3",
  heading:  "0D1117",
  code:     "2D3436",
  codeBg:   "EEF2F5",
};

const border = (color = C.border) => ({ style: BorderStyle.SINGLE, size: 1, color });
const borders = (color) => ({ top: border(color), bottom: border(color), left: border(color), right: border(color) });
const noBorder = { style: BorderStyle.NIL };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

// helpers
const gap = (pt = 6) => new Paragraph({ children: [new TextRun("")], spacing: { after: pt * 20 } });

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, font: "Arial", size: 32, bold: true, color: C.heading })],
    spacing: { before: 400, after: 200 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.accent, space: 4 } }
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [new TextRun({ text, font: "Arial", size: 26, bold: true, color: C.heading })],
    spacing: { before: 320, after: 140 }
  });
}

function heading3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [new TextRun({ text, font: "Arial", size: 22, bold: true, color: C.muted })],
    spacing: { before: 240, after: 100 }
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, font: "Arial", size: 22, color: C.code, ...opts })],
    spacing: { after: 120 },
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.LEFT
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "bullets", level },
    children: [new TextRun({ text, font: "Arial", size: 22, color: C.code })],
    spacing: { after: 80 }
  });
}

function numbered(text, level = 0) {
  return new Paragraph({
    numbering: { reference: "numbers", level },
    children: [new TextRun({ text, font: "Arial", size: 22, color: C.code })],
    spacing: { after: 80 }
  });
}

function code(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: "Courier New", size: 18, color: C.dark })],
    shading: { fill: C.codeBg, type: ShadingType.CLEAR },
    spacing: { after: 40, before: 40 },
    indent: { left: 360 }
  });
}

function infoBox(label, text, bgColor = C.bg1, borderColor = C.accent) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: borders(borderColor),
            width: { size: 9360, type: WidthType.DXA },
            shading: { fill: bgColor, type: ShadingType.CLEAR },
            margins: { top: 100, bottom: 100, left: 180, right: 180 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: label + " ", font: "Arial", size: 20, bold: true, color: borderColor }),
                           new TextRun({ text, font: "Arial", size: 20, color: C.code })],
                spacing: { after: 0 }
              })
            ]
          })
        ]
      })
    ]
  });
}

function twoCol(left, right, leftWidth = 4680) {
  const rightWidth = 9360 - leftWidth;
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [leftWidth, rightWidth],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: noBorders,
            width: { size: leftWidth, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 0, right: 120 },
            children: [new Paragraph({ children: [new TextRun({ text: left, font: "Arial", size: 22, bold: true, color: C.accent })], spacing: { after: 0 } })]
          }),
          new TableCell({
            borders: noBorders,
            width: { size: rightWidth, type: WidthType.DXA },
            margins: { top: 60, bottom: 60, left: 120, right: 0 },
            children: [new Paragraph({ children: [new TextRun({ text: right, font: "Arial", size: 22, color: C.code })], spacing: { after: 0 } })]
          })
        ]
      })
    ]
  });
}

function headerRow(cells, widths) {
  return new TableRow({
    children: cells.map((text, i) => new TableCell({
      borders: borders(C.accent),
      width: { size: widths[i], type: WidthType.DXA },
      shading: { fill: C.accent, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20, bold: true, color: C.white })], spacing: { after: 0 } })]
    }))
  });
}

function dataRow(cells, widths, shade = false) {
  return new TableRow({
    children: cells.map((text, i) => new TableCell({
      borders: borders(C.border),
      width: { size: widths[i], type: WidthType.DXA },
      shading: { fill: shade ? C.bgGray : C.white, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 20, color: C.code })], spacing: { after: 0 } })]
    }))
  });
}

// ── Document ──────────────────────────────────────────────────────────────────
const doc = new Document({
  numbering: {
    config: [
      { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
                                        { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }] },
      { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    ]
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial", color: C.heading },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial", color: C.heading },
        paragraph: { spacing: { before: 320, after: 140 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: C.muted },
        paragraph: { spacing: { before: 240, after: 100 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 }
      }
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: "PAVI — PHASE D IMPLEMENTATION SPEC", font: "Arial", size: 18, bold: true, color: C.muted }),
              new TextRun({ text: "\t", font: "Arial", size: 18 }),
              new TextRun({ text: "AUTONOMOUS CI/CD AGENT", font: "Arial", size: 18, color: C.accent }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.accent, space: 4 } },
            spacing: { after: 0 }
          })
        ]
      })
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: "Pavi v2.0 — Phase D — Confidential Implementation Guide", font: "Arial", size: 16, color: C.muted }),
              new TextRun({ text: "\t", font: "Arial", size: 16 }),
              new TextRun({ text: "Page ", font: "Arial", size: 16, color: C.muted }),
              new PageNumber({ font: "Arial", size: 16, color: C.muted }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.border, space: 4 } },
            spacing: { before: 0 }
          })
        ]
      })
    },
    children: [

      // ── COVER ──────────────────────────────────────────────────────────────
      new Paragraph({
        children: [new TextRun({ text: "PAVI", font: "Arial", size: 80, bold: true, color: C.accent })],
        alignment: AlignmentType.CENTER, spacing: { before: 800, after: 60 }
      }),
      new Paragraph({
        children: [new TextRun({ text: "PHASE D — AUTONOMOUS CI/CD AGENT", font: "Arial", size: 36, bold: true, color: C.heading })],
        alignment: AlignmentType.CENTER, spacing: { after: 60 }
      }),
      new Paragraph({
        children: [new TextRun({ text: "Exclusive Implementation Specification", font: "Arial", size: 24, color: C.muted, italics: true })],
        alignment: AlignmentType.CENTER, spacing: { after: 80 }
      }),
      gap(10),
      infoBox("PURPOSE:", "This document provides every file path, code pattern, connection wire, and integration detail required for an AI to implement Phase D end-to-end without gaps or guesswork. All connections to existing Pavi architecture (Phase 1-4) are explicitly mapped.", C.bg1, C.accent),
      gap(8),

      // Quick stats table
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2340, 2340, 2340, 2340],
        rows: [
          new TableRow({
            children: [
              ["EFFORT", "2–3 weeks"],
              ["RISK LEVEL", "Medium"],
              ["ARCH IMPACT", "+8 pts (82→90)"],
              ["PHASE DEPS", "P1, P2, P3, P4"],
            ].map(([label, val], i) => new TableCell({
              borders: borders(C.accent),
              width: { size: 2340, type: WidthType.DXA },
              shading: { fill: i % 2 === 0 ? C.bg1 : C.white, type: ShadingType.CLEAR },
              margins: { top: 100, bottom: 100, left: 120, right: 120 },
              children: [
                new Paragraph({ children: [new TextRun({ text: label, font: "Arial", size: 18, bold: true, color: C.accent })], spacing: { after: 30 } }),
                new Paragraph({ children: [new TextRun({ text: val, font: "Arial", size: 22, bold: true, color: C.heading })], spacing: { after: 0 } })
              ]
            }))
          })
        ]
      }),
      gap(8),

      new Paragraph({ children: [new TextRun({ text: "May 2026 — Pavi Development Sessions", font: "Arial", size: 18, color: C.muted, italics: true })], alignment: AlignmentType.CENTER }),
      new Paragraph({ children: [new PageBreak()] }),

      // ── SECTION 1 — OVERVIEW ───────────────────────────────────────────────
      heading1("1. Phase D Overview"),
      body("Phase D transforms Pavi from a manually-triggered assistant into a fully autonomous development agent. It monitors a connected GitHub repository for issues tagged pavi:auto, then plans, codes, tests, and opens a Pull Request — all without human intervention."),
      gap(4),

      heading2("1.1 What Phase D Does"),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3120, 6240],
        rows: [
          headerRow(["Step", "What Pavi Does"], [3120, 6240]),
          ...([
            ["1. Detect Issue", "GitHub webhook fires on new Issue with label pavi:auto → Pavi's webhook receiver validates signature and queues the job"],
            ["2. Plan", "Ollama reads the issue body + ingested repo context → generates a structured execution plan (JSON) stored in swarmRunsDB"],
            ["3. Execute Swarm", "swarm-orchestrator.js spawns claude-flow inside Docker sandbox with the generated plan as --objective"],
            ["4. Test", "After code generation, Pavi runs jest (or the repo's own test command) inside the same sandbox and reads exit code"],
            ["5. Open PR", "If tests pass, GitHub API creates a branch, commits all changed files, and opens a Pull Request with a diff summary"],
            ["6. Monaco Review", "Monaco diff viewer in Pavi dashboard shows every changed file — Approve writes changes, Reject discards PR"],
          ]).map(([a, b], i) => dataRow([a, b], [3120, 6240], i % 2 !== 0))
        ]
      }),
      gap(8),

      heading2("1.2 Connection Map to Existing Architecture"),
      body("Phase D wires into these already-built Phase 1–4 components. Every connection is detailed in Section 4."),
      gap(4),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2800, 2800, 3760],
        rows: [
          headerRow(["Existing Component", "Phase Built In", "Phase D Usage"], [2800, 2800, 3760]),
          ...([
            ["swarm-orchestrator.js", "Phase 1–4", "Called to spawn claude-flow with Ollama-generated plan"],
            ["pattern-memory.js", "Phase 4", "Repo context retrieved via vectorStore for planning prompt"],
            ["swarmRunsDB (SQLite)", "Phase 4", "Execution plan and PR result stored per run"],
            ["local-bot.js", "Phase 4", "generatePlan() uses Ollama /api/chat directly"],
            ["session.js (Socket.io)", "Phase 2", "Progress events streamed to dashboard in real-time"],
            ["shield.js (WAF)", "Phase 1", "Webhook payload sanitized before processing"],
            ["JWT auth", "Phase 1", "Dashboard PR review route protected"],
            ["Jest test suite", "Phase 2", "37 existing tests still green; 12 new Phase D tests added"],
            ["Monaco editor", "Phase 5 (unlocked)", "Diff viewer becomes PR review interface"],
            ["GitHub ingestion queue", "Phase 2", "p-limit queue reused for file commit batching"],
          ]).map(([a, b, c], i) => dataRow([a, b, c], [2800, 2800, 3760], i % 2 !== 0))
        ]
      }),
      gap(8),

      // ── SECTION 2 — NEW FILES ──────────────────────────────────────────────
      heading1("2. New Files to Create"),
      body("These files do not exist yet. Create them exactly as specified."),
      gap(4),

      heading2("2.1  services/github-watcher.js"),
      body("The entry point for Phase D. Listens for GitHub webhook events, validates the HMAC-SHA256 signature, filters for issues with the pavi:auto label, and enqueues jobs."),
      gap(4),
      infoBox("PATH:", "services/github-watcher.js", C.bg1, C.accent),
      gap(4),
      code("const crypto = require('crypto');"),
      code("const { enqueueJob } = require('./job-queue');"),
      code(""),
      code("// Called from routes/github.js (new route, see Section 3.2)"),
      code("function validateSignature(secret, payload, sig) {"),
      code("  const hmac = crypto.createHmac('sha256', secret);"),
      code("  const digest = 'sha256=' + hmac.update(payload).digest('hex');"),
      code("  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));"),
      code("}"),
      code(""),
      code("async function handleWebhook(rawBody, signature) {"),
      code("  if (!validateSignature(process.env.GITHUB_WEBHOOK_SECRET, rawBody, signature))"),
      code("    throw new Error('Invalid webhook signature');"),
      code(""),
      code("  const event = JSON.parse(rawBody);"),
      code("  if (event.action !== 'labeled') return { skipped: true };"),
      code("  if (!event.label || event.label.name !== 'pavi:auto') return { skipped: true };"),
      code(""),
      code("  const job = {"),
      code("    issueNumber: event.issue.number,"),
      code("    issueTitle:  event.issue.title,"),
      code("    issueBody:   event.issue.body,"),
      code("    repo:        event.repository.full_name,"),
      code("    repoUrl:     event.repository.clone_url,"),
      code("  };"),
      code("  return enqueueJob(job);"),
      code("}"),
      code(""),
      code("module.exports = { handleWebhook };"),
      gap(6),

      heading2("2.2  services/job-queue.js"),
      body("A simple persistent job queue (SQLite-backed) that prevents duplicate processing if the webhook fires more than once for the same issue."),
      gap(4),
      infoBox("PATH:", "services/job-queue.js", C.bg1, C.accent),
      gap(4),
      code("const Database = require('better-sqlite3');"),
      code("const db = new Database('data/pavi.db'); // same DB used elsewhere"),
      code(""),
      code("db.exec(`CREATE TABLE IF NOT EXISTS phase_d_jobs ("),
      code("  id INTEGER PRIMARY KEY AUTOINCREMENT,"),
      code("  issue_number INTEGER UNIQUE,"),
      code("  repo TEXT,"),
      code("  payload TEXT,"),
      code("  status TEXT DEFAULT 'queued',"),
      code("  created_at DATETIME DEFAULT CURRENT_TIMESTAMP"),
      code(");`);"),
      code(""),
      code("function enqueueJob(job) {"),
      code("  const stmt = db.prepare(`INSERT OR IGNORE INTO phase_d_jobs"),
      code("    (issue_number, repo, payload) VALUES (?, ?, ?)`);"),
      code("  const result = stmt.run(job.issueNumber, job.repo, JSON.stringify(job));"),
      code("  if (result.changes === 0) return { duplicate: true };"),
      code("  setImmediate(() => processJob(job)); // non-blocking"),
      code("  return { queued: true, issueNumber: job.issueNumber };"),
      code("}"),
      code(""),
      code("function updateStatus(issueNumber, status) {"),
      code("  db.prepare('UPDATE phase_d_jobs SET status=? WHERE issue_number=?')"),
      code("    .run(status, issueNumber);"),
      code("}"),
      code(""),
      code("module.exports = { enqueueJob, updateStatus };"),
      gap(6),

      heading2("2.3  services/planner.js"),
      body("Calls Ollama to generate a structured execution plan from the issue + repo context. Returns a JSON plan that swarm-orchestrator.js consumes."),
      gap(4),
      infoBox("PATH:", "services/planner.js", C.bg1, C.accent),
      gap(4),
      infoBox("CONNECTS TO:", "local-bot.js (Ollama /api/chat), pattern-memory.js (vectorStore recall)", C.bg2, C.warn),
      gap(4),
      code("const { recall } = require('./pattern-memory');   // Phase 4"),
      code(""),
      code("async function generatePlan(issue) {"),
      code("  // 1. Retrieve relevant repo patterns from vectorStore"),
      code("  const context = await recall(issue.issueTitle + ' ' + issue.issueBody, 8);"),
      code(""),
      code("  const systemPrompt = `You are a senior software architect."),
      code("You will receive a GitHub issue and relevant code context."),
      code("Return ONLY a JSON object (no markdown) with this shape:"),
      code("{"),
      code("  \"objective\": \"<one-sentence goal>\","),
      code("  \"files_to_modify\": [\"path/to/file.js\"],"),
      code("  \"files_to_create\": [\"path/to/new.js\"],"),
      code("  \"agent_roles\": [\"worker\", \"reviewer\"],"),
      code("  \"test_command\": \"npm test\","),
      code("  \"pr_title\": \"<PR title>\","),
      code("  \"pr_body\": \"<markdown PR description>\""),
      code("}`),"),
      code(""),
      code("  const userPrompt = `ISSUE TITLE: ${issue.issueTitle}"),
      code("ISSUE BODY: ${issue.issueBody}"),
      code(""),
      code("RELEVANT CODE CONTEXT:"),
      code("${context.map(c => c.text).join('\\n\\n')}`;"),
      code(""),
      code("  const res = await fetch(`${process.env.OLLAMA_URL}/api/chat`, {"),
      code("    method: 'POST',"),
      code("    headers: { 'Content-Type': 'application/json' },"),
      code("    body: JSON.stringify({"),
      code("      model: process.env.OLLAMA_MODEL || 'phi3:mini',"),
      code("      messages: ["),
      code("        { role: 'system', content: systemPrompt },"),
      code("        { role: 'user',   content: userPrompt }"),
      code("      ],"),
      code("      stream: false"),
      code("    })"),
      code("  });"),
      code(""),
      code("  const data = await res.json();"),
      code("  const raw = data.message?.content || '{}';"),
      code("  try { return JSON.parse(raw); }"),
      code("  catch { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }"),
      code("}"),
      code(""),
      code("module.exports = { generatePlan };"),
      gap(6),

      heading2("2.4  services/pr-publisher.js"),
      body("After swarm execution, reads the modified files from the Docker sandbox output volume, commits them to a new branch, and opens a GitHub Pull Request using the Octokit REST SDK."),
      gap(4),
      infoBox("PATH:", "services/pr-publisher.js", C.bg1, C.accent),
      gap(4),
      infoBox("DEPENDENCY:", "npm install @octokit/rest   (add to package.json)", C.bg2, C.warn),
      gap(4),
      code("const { Octokit } = require('@octokit/rest');"),
      code("const fs = require('fs');"),
      code("const path = require('path');"),
      code(""),
      code("async function publishPR(plan, swarmOutputDir, issueNumber) {"),
      code("  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });"),
      code("  const [owner, repo] = plan.repo.split('/');"),
      code(""),
      code("  // 1. Get default branch SHA"),
      code("  const { data: ref } = await octokit.git.getRef({"),
      code("    owner, repo, ref: 'heads/main'"),
      code("  });"),
      code("  const baseSha = ref.object.sha;"),
      code(""),
      code("  // 2. Create feature branch"),
      code("  const branchName = `pavi/issue-${issueNumber}`;"),
      code("  await octokit.git.createRef({"),
      code("    owner, repo,"),
      code("    ref: `refs/heads/${branchName}`,"),
      code("    sha: baseSha"),
      code("  });"),
      code(""),
      code("  // 3. Commit all modified files"),
      code("  const allFiles = [...plan.files_to_modify, ...plan.files_to_create];"),
      code("  for (const filePath of allFiles) {"),
      code("    const fullPath = path.join(swarmOutputDir, filePath);"),
      code("    if (!fs.existsSync(fullPath)) continue;"),
      code("    const content = fs.readFileSync(fullPath, 'base64');"),
      code(""),
      code("    // Get existing SHA if file exists (update) or skip (create)"),
      code("    let fileSha;"),
      code("    try {"),
      code("      const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branchName });"),
      code("      fileSha = data.sha;"),
      code("    } catch (_) { /* new file */ }"),
      code(""),
      code("    await octokit.repos.createOrUpdateFileContents({"),
      code("      owner, repo, path: filePath,"),
      code("      message: `pavi: ${plan.objective} (#${issueNumber})`,"),
      code("      content, branch: branchName,"),
      code("      ...(fileSha ? { sha: fileSha } : {})"),
      code("    });"),
      code("  }"),
      code(""),
      code("  // 4. Open PR"),
      code("  const { data: pr } = await octokit.pulls.create({"),
      code("    owner, repo,"),
      code("    title: plan.pr_title,"),
      code("    body: plan.pr_body + `\\n\\n---\\n_Opened autonomously by Pavi — Issue #${issueNumber}_`,"),
      code("    head: branchName,"),
      code("    base: 'main'"),
      code("  });"),
      code(""),
      code("  return { prUrl: pr.html_url, prNumber: pr.number, branch: branchName };"),
      code("}"),
      code(""),
      code("module.exports = { publishPR };"),
      gap(6),

      heading2("2.5  services/pipeline.js"),
      body("The main Phase D orchestrator. Wires together planner → swarm → test → PR → Socket.io events. This is the function that job-queue.js calls."),
      gap(4),
      infoBox("PATH:", "services/pipeline.js", C.bg1, C.accent),
      gap(4),
      code("const { generatePlan }  = require('./planner');"),
      code("const { runSwarm }      = require('./swarm-orchestrator');  // existing"),
      code("const { publishPR }     = require('./pr-publisher');"),
      code("const { updateStatus }  = require('./job-queue');"),
      code("const { getIO }         = require('./socket-singleton');    // see Section 3.4"),
      code("const db                = require('./db');                  // existing SQLite helper"),
      code(""),
      code("async function processJob(job) {"),
      code("  const io = getIO();"),
      code("  const emit = (event, data) => io.emit(`phase_d:${event}`, { issueNumber: job.issueNumber, ...data });"),
      code(""),
      code("  try {"),
      code("    updateStatus(job.issueNumber, 'planning');"),
      code("    emit('planning', { message: 'Ollama is generating execution plan...' });"),
      code(""),
      code("    const plan = await generatePlan(job);"),
      code("    plan.repo = job.repo;"),
      code(""),
      code("    // Persist plan to swarmRunsDB (Phase 4 pattern)"),
      code("    const runId = db.prepare(`INSERT INTO swarm_runs (prompt, pre_plan, status, created_at)"),
      code("      VALUES (?, ?, 'running', datetime('now'))`).run(job.issueBody, JSON.stringify(plan)).lastInsertRowid;"),
      code(""),
      code("    updateStatus(job.issueNumber, 'executing');"),
      code("    emit('executing', { plan, runId });"),
      code(""),
      code("    const swarmResult = await runSwarm(plan.objective, {"),
      code("      filesContext: [...plan.files_to_modify, ...plan.files_to_create],"),
      code("      agentRoles: plan.agent_roles,"),
      code("      sandbox: true           // Docker sandbox flag (Phase D P0 dep)"),
      code("    });"),
      code(""),
      code("    updateStatus(job.issueNumber, 'testing');"),
      code("    emit('testing', { message: `Running: ${plan.test_command}` });"),
      code(""),
      code("    if (!swarmResult.testsPassed) {"),
      code("      updateStatus(job.issueNumber, 'test_failed');"),
      code("      emit('failed', { reason: 'Tests failed', log: swarmResult.testLog });"),
      code("      db.prepare('UPDATE swarm_runs SET status=? WHERE id=?').run('test_failed', runId);"),
      code("      return;"),
      code("    }"),
      code(""),
      code("    updateStatus(job.issueNumber, 'publishing');"),
      code("    emit('publishing', { message: 'Tests passed — opening Pull Request...' });"),
      code(""),
      code("    const pr = await publishPR(plan, swarmResult.outputDir, job.issueNumber);"),
      code(""),
      code("    db.prepare('UPDATE swarm_runs SET status=?, pr_url=? WHERE id=?')"),
      code("      .run('completed', pr.prUrl, runId);"),
      code("    updateStatus(job.issueNumber, 'completed');"),
      code("    emit('completed', { pr, runId });"),
      code(""),
      code("  } catch (err) {"),
      code("    updateStatus(job.issueNumber, 'error');"),
      code("    emit('error', { message: err.message });"),
      code("  }"),
      code("}"),
      code(""),
      code("module.exports = { processJob };"),
      gap(6),

      heading2("2.6  Dockerfile.phase-d  (Sandbox Extension)"),
      body("Extends the existing Dockerfile.sandbox (Phase D P0 dependency) with the additional tooling Phase D needs inside the agent container."),
      gap(4),
      infoBox("PATH:", "Dockerfile.phase-d", C.bg1, C.accent),
      gap(4),
      code("FROM node:20-alpine"),
      code(""),
      code("# Install git so swarm agents can read the repo structure"),
      code("RUN apk add --no-cache git"),
      code(""),
      code("WORKDIR /workspace"),
      code(""),
      code("# The host mounts the target repo here at runtime:"),
      code("#   -v /tmp/pavi-sandbox/issue-<N>:/workspace"),
      code(""),
      code("# Default: run whatever test command the plan specifies"),
      code("ENTRYPOINT [\"sh\", \"-c\"]"),
      gap(8),

      // ── SECTION 3 — MODIFY EXISTING ────────────────────────────────────────
      heading1("3. Existing Files to Modify"),
      body("These files already exist. The changes are additive — nothing is removed. Each change is described at the line level."),
      gap(4),

      heading2("3.1  server.js — Mount the Webhook Route"),
      body("Add the new GitHub webhook route after existing route mounts."),
      gap(4),
      infoBox("FILE:", "server.js  (existing)", C.bgGray, C.muted),
      gap(4),
      body("Find the block where existing routes are mounted (around the JWT-protected /api routes). Add immediately after:"),
      gap(4),
      code("// --- ADD THIS BLOCK (Phase D) ---"),
      code("const githubRoutes = require('./routes/github');          // new file"),
      code("app.use('/webhooks', githubRoutes);                       // public — validated by HMAC"),
      code("// ---------------------------------"),
      gap(6),

      heading2("3.2  routes/github.js — New Route File"),
      body("This is a new file in the existing routes/ directory. It receives GitHub webhook POST requests, passes raw body to github-watcher.js."),
      gap(4),
      infoBox("PATH:", "routes/github.js  (NEW file in existing routes/ dir)", C.bg1, C.accent),
      gap(4),
      code("const express = require('express');"),
      code("const router = express.Router();"),
      code("const { handleWebhook } = require('../services/github-watcher');"),
      code(""),
      code("// CRITICAL: raw body needed for HMAC validation"),
      code("// Add this BEFORE express.json() in server.js:"),
      code("// app.use('/webhooks', express.raw({ type: 'application/json' }));"),
      code(""),
      code("router.post('/github', async (req, res) => {"),
      code("  try {"),
      code("    const sig = req.headers['x-hub-signature-256'];"),
      code("    if (!sig) return res.status(401).json({ error: 'Missing signature' });"),
      code("    const result = await handleWebhook(req.body, sig);"),
      code("    res.json(result);"),
      code("  } catch (err) {"),
      code("    res.status(403).json({ error: err.message });"),
      code("  }"),
      code("});"),
      code(""),
      code("module.exports = router;"),
      gap(6),

      heading2("3.3  swarm-orchestrator.js — Accept plan Object"),
      body("The existing runSwarm() likely accepts a plain string prompt. Phase D passes a structured plan. Add an overload that accepts a plan object."),
      gap(4),
      infoBox("FILE:", "swarm-orchestrator.js  (existing)", C.bgGray, C.muted),
      gap(4),
      body("Find the existing runSwarm function signature. Wrap it to accept either a string or plan object:"),
      gap(4),
      code("// ORIGINAL signature (do not remove):"),
      code("// async function runSwarm(prompt, options = {}) { ... }"),
      code(""),
      code("// ADD this wrapper above module.exports:"),
      code("const _runSwarm = runSwarm;"),
      code("async function runSwarm(promptOrPlan, options = {}) {"),
      code("  if (typeof promptOrPlan === 'object' && promptOrPlan.objective) {"),
      code("    // Phase D path: use structured plan"),
      code("    const objective = promptOrPlan.objective;"),
      code("    const filesFlag = (promptOrPlan.files_to_modify || [])"),
      code("      .concat(promptOrPlan.files_to_create || [])"),
      code("      .join(',');"),
      code("    return _runSwarm(objective, { ...options, filesContext: filesFlag });"),
      code("  }"),
      code("  return _runSwarm(promptOrPlan, options);  // original path unchanged"),
      code("}"),
      gap(6),

      heading2("3.4  services/session.js → socket-singleton.js"),
      body("Phase D's pipeline.js needs access to the Socket.io instance from anywhere in the codebase. Create a small singleton wrapper."),
      gap(4),
      infoBox("PATH:", "services/socket-singleton.js  (NEW)", C.bg1, C.accent),
      gap(4),
      code("let _io = null;"),
      code(""),
      code("function setIO(io) { _io = io; }"),
      code("function getIO() {"),
      code("  if (!_io) throw new Error('Socket.io not initialised — call setIO(io) in server.js first');"),
      code("  return _io;"),
      code("}"),
      code(""),
      code("module.exports = { setIO, getIO };"),
      gap(4),
      body("Then in server.js, after Socket.io is created, add:"),
      gap(4),
      code("const { setIO } = require('./services/socket-singleton');"),
      code("const io = require('socket.io')(server);"),
      code("setIO(io);   // ADD THIS LINE"),
      gap(6),

      heading2("3.5  .env  — New Required Variables"),
      body("Add these to .env and .env.example:"),
      gap(4),
      code("# Phase D — Autonomous CI/CD Agent"),
      code("GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx          # PAT with repo scope"),
      code("GITHUB_WEBHOOK_SECRET=your_random_secret_here  # Set same value in GitHub repo settings"),
      code("GITHUB_DEFAULT_BRANCH=main                     # or master"),
      gap(6),

      heading2("3.6  SQLite Migration — New Columns"),
      body("Add these columns to the existing swarm_runs table. Safe to run even if table already exists (uses IF NOT EXISTS / ALTER OR IGNORE patterns):"),
      gap(4),
      code("-- Run this migration once on startup (add to db initialisation block)"),
      code("ALTER TABLE swarm_runs ADD COLUMN pr_url TEXT;"),
      code("ALTER TABLE swarm_runs ADD COLUMN pr_number INTEGER;"),
      code("ALTER TABLE swarm_runs ADD COLUMN issue_number INTEGER;"),
      code(""),
      code("-- New table for job queue (created automatically by job-queue.js,"),
      code("-- listed here for reference)"),
      code("CREATE TABLE IF NOT EXISTS phase_d_jobs ("),
      code("  id INTEGER PRIMARY KEY AUTOINCREMENT,"),
      code("  issue_number INTEGER UNIQUE,"),
      code("  repo TEXT,"),
      code("  payload TEXT,"),
      code("  status TEXT DEFAULT 'queued',"),
      code("  created_at DATETIME DEFAULT CURRENT_TIMESTAMP"),
      code(");"),
      gap(8),

      // ── SECTION 4 — FRONTEND ───────────────────────────────────────────────
      heading1("4. Frontend Changes (Dashboard)"),
      gap(4),

      heading2("4.1  Socket.io Events to Receive"),
      body("The dashboard must listen for these events emitted by pipeline.js. Wire them up in the existing Socket.io client initialisation block in app.js or renderer.js:"),
      gap(4),
      code("socket.on('phase_d:planning',   (d) => showStatus(d.issueNumber, 'Planning...', 'info'));"),
      code("socket.on('phase_d:executing',  (d) => showStatus(d.issueNumber, 'Swarm running...', 'active'));"),
      code("socket.on('phase_d:testing',    (d) => showStatus(d.issueNumber, d.message, 'testing'));"),
      code("socket.on('phase_d:publishing', (d) => showStatus(d.issueNumber, d.message, 'publishing'));"),
      code("socket.on('phase_d:completed',  (d) => showPRCard(d.issueNumber, d.pr));"),
      code("socket.on('phase_d:failed',     (d) => showError(d.issueNumber, d.reason, d.log));"),
      code("socket.on('phase_d:error',      (d) => showError(d.issueNumber, d.message));"),
      gap(6),

      heading2("4.2  PR Review Card Component"),
      body("When phase_d:completed fires, render a card in the dashboard. This card is the entry point for the Monaco diff viewer (Phase 5 / Item 5 in backlog):"),
      gap(4),
      code("function showPRCard(issueNumber, pr) {"),
      code("  const card = document.createElement('div');"),
      code("  card.className = 'pr-card';"),
      code("  card.innerHTML = `"),
      code("    <div class='pr-header'>"),
      code("      <span class='pr-label'>PR OPENED — Issue #${issueNumber}</span>"),
      code("      <a href='${pr.prUrl}' target='_blank' class='pr-link'>View on GitHub</a>"),
      code("    </div>"),
      code("    <div class='pr-actions'>"),
      code("      <button onclick='openMonacoDiff(${pr.prNumber})'>Review Changes</button>"),
      code("      <button onclick='mergePR(${pr.prNumber})' class='btn-merge'>Merge</button>"),
      code("      <button onclick='closePR(${pr.prNumber})' class='btn-close'>Close</button>"),
      code("    </div>"),
      code("  `;"),
      code("  document.getElementById('phase-d-feed').prepend(card);"),
      code("}"),
      gap(6),

      heading2("4.3  Swarm History Tab — Phase D Rows"),
      body("The existing Swarm History UI tab (Item 3 in backlog) should show Phase D runs differently. Add a filter toggle and a pr_url column:"),
      gap(4),
      code("// In the history tab query:"),
      code("SELECT id, prompt, status, pr_url, issue_number, created_at"),
      code("FROM swarm_runs ORDER BY created_at DESC LIMIT 50;"),
      code(""),
      code("// Render pr_url as a clickable link if present:"),
      code("// <a href='${row.pr_url}'>View PR</a>"),
      gap(8),

      // ── SECTION 5 — GITHUB SETUP ───────────────────────────────────────────
      heading1("5. GitHub Repository Configuration"),
      body("These steps must be completed in the target GitHub repository settings before Phase D can function."),
      gap(4),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [4320, 5040],
        rows: [
          headerRow(["Setting", "Value / Instructions"], [4320, 5040]),
          ...([
            ["Webhook URL", "https://your-pavi-host/webhooks/github\n(use ngrok for local dev: ngrok http 3000)"],
            ["Content-type", "application/json"],
            ["Secret", "Same value as GITHUB_WEBHOOK_SECRET in .env"],
            ["Events to trigger", "Issues (check only 'Issues')"],
            ["Issue label to create", "pavi:auto (create this label in the repo)"],
            ["PAT scopes needed", "repo (full control) — set as GITHUB_TOKEN in .env"],
            ["Branch protection", "Ensure 'pavi/*' branches are allowed to be created by the PAT"],
          ]).map(([a, b], i) => dataRow([a, b], [4320, 5040], i % 2 !== 0))
        ]
      }),
      gap(8),

      // ── SECTION 6 — TEST PLAN ─────────────────────────────────────────────
      heading1("6. Test Plan — 12 New Tests"),
      body("Add these to the existing Jest suite. The 37 existing tests must remain green. Create tests/phase-d.test.js:"),
      gap(4),

      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [400, 4960, 4000],
        rows: [
          headerRow(["#", "Test Name", "Asserts"], [400, 4960, 4000]),
          ...([
            ["1",  "webhook: rejects invalid HMAC",                "Returns 403 for wrong signature"],
            ["2",  "webhook: skips non-pavi:auto labels",          "Returns { skipped: true }"],
            ["3",  "webhook: enqueues valid pavi:auto issue",       "Returns { queued: true }"],
            ["4",  "job-queue: deduplicates same issue_number",     "Second call returns { duplicate: true }"],
            ["5",  "planner: returns valid JSON plan",             "All required keys present"],
            ["6",  "planner: handles malformed Ollama response",   "Strips ```json fences, parses cleanly"],
            ["7",  "pipeline: emits planning event on start",      "Socket event received"],
            ["8",  "pipeline: emits failed on test failure",       "status = test_failed in DB"],
            ["9",  "pipeline: emits completed with pr data",       "prUrl present in event"],
            ["10", "pr-publisher: creates branch correctly",       "octokit.git.createRef called with right name"],
            ["11", "pr-publisher: commits all plan files",         "createOrUpdateFileContents called per file"],
            ["12", "pr-publisher: PR body includes issue ref",     "Body contains Issue # string"],
          ]).map(([a, b, c], i) => dataRow([a, b, c], [400, 4960, 4000], i % 2 !== 0))
        ]
      }),
      gap(8),

      // ── SECTION 7 — IMPLEMENTATION ORDER ──────────────────────────────────
      heading1("7. Recommended Implementation Order"),
      body("Follow this sequence exactly. Each step can be tested independently."),
      gap(4),
      numbered("Add .env variables and SQLite migration — verify with GET /api/health"),
      numbered("Create socket-singleton.js and wire setIO() in server.js — verify getIO() returns the instance"),
      numbered("Create job-queue.js — run unit test #4 (deduplication)"),
      numbered("Create github-watcher.js and routes/github.js — run tests #1, #2, #3"),
      numbered("Mount /webhooks in server.js — manual test with curl and wrong secret (expect 403)"),
      numbered("Create planner.js — run tests #5 and #6 with mocked fetch"),
      numbered("Modify swarm-orchestrator.js — run existing swarm tests to confirm no regression"),
      numbered("Create pipeline.js — run tests #7, #8, #9 with mocked planner + swarm + pr-publisher"),
      numbered("Create pr-publisher.js — run tests #10, #11, #12 with mocked Octokit"),
      numbered("Create Dockerfile.phase-d — build and verify sandbox runs test command correctly"),
      numbered("Wire frontend Socket.io events — verify cards appear on manual emit"),
      numbered("End-to-end test: create a real pavi:auto issue on a test repo, watch the pipeline run"),
      gap(8),

      // ── SECTION 8 — DEPENDENCY CHART ──────────────────────────────────────
      heading1("8. Full Dependency & Connection Chart"),
      gap(4),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [2600, 2600, 2000, 2160],
        rows: [
          headerRow(["File", "Imports From", "Emits To", "Writes To"], [2600, 2600, 2000, 2160]),
          ...([
            ["routes/github.js",      "github-watcher.js",                   "—",                         "—"],
            ["github-watcher.js",     "job-queue.js, shield.js",             "—",                         "phase_d_jobs (SQLite)"],
            ["job-queue.js",          "better-sqlite3 (existing db)",        "pipeline.js (processJob)",  "phase_d_jobs"],
            ["planner.js",            "pattern-memory.js, Ollama /api/chat", "—",                         "—"],
            ["pipeline.js",           "planner, swarm-orchestrator,\npr-publisher, socket-singleton, db", "Socket.io events", "swarm_runs"],
            ["pr-publisher.js",       "@octokit/rest",                       "—",                         "GitHub API (remote)"],
            ["socket-singleton.js",   "—",                                   "—",                         "—"],
            ["Dockerfile.phase-d",    "node:20-alpine",                      "—",                         "—"],
          ]).map(([a, b, c, d], i) => dataRow([a, b, c, d], [2600, 2600, 2000, 2160], i % 2 !== 0))
        ]
      }),
      gap(8),

      infoBox("FINAL NOTE:", "When all 12 new tests pass and the existing 37 tests remain green, Phase D is complete. Architecture rating moves from ~82 to ~90 / 100.", C.bg1, C.accent),
      gap(6),
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('/mnt/user-data/outputs/Pavi_PhaseD_Implementation_Spec.docx', buf);
  console.log('DONE');
});
