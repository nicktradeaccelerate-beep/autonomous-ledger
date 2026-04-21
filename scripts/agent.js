#!/usr/bin/env node
// agent.js <project-id>
// Autonomous Claude agent that works through a project's outstanding tasks.
// File edits are auto-approved. Bash commands pause for approval.
// Approval can come from: this terminal (type y/n) OR the dashboard.

const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const readline = require('readline');

const http = require('http');

const PROJECT_IDS = process.argv.slice(2);
const PROJECT_ID = PROJECT_IDS[0]; // current project being worked on
const HOME = process.env.HOME;
const LEDGER_DIR = path.join(HOME, 'autonomous-ledger');
const DATA_PATH = path.join(LEDGER_DIR, 'data.json');
const STATE_PATH = path.join(LEDGER_DIR, 'agent_state.json');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const LOCAL_PORT = 4242;

if (!PROJECT_IDS.length) { console.error('Usage: node agent.js <project-id> [project-id2] ...'); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error('Set ANTHROPIC_API_KEY env var'); process.exit(1); }

// ── Local approval server ──────────────────────────────────────────────────
// Dashboard connects to http://localhost:4242 — no GitHub token needed
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/state') {
    const state = fs.readFileSync(STATE_PATH, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(state);
    return;
  }

  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && req.url === '/instruct') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        // Write instruction to state so agent picks it up
        const s = readState();
        s.agent_state.instruction = message;
        fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log(`\n📨 Instruction from chat: ${message}`);
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/approve') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { decision } = JSON.parse(body);
        const s = readState();
        if (s.agent_state.pending) s.agent_state.pending.decision = decision;
        fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
}).listen(LOCAL_PORT, () => {
  console.log(`  Local server : http://localhost:${LOCAL_PORT}/state`);
});

// ── State ──────────────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { agent_state: { status: 'idle', project: null, current_task: null, log: [], pending: null } }; }
}

function writeState(patch) {
  const s = readState();
  Object.assign(s.agent_state, patch);
  s.agent_state.log = (s.agent_state.log || []).slice(-50); // keep last 50 entries
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  pushState();
}

function log(type, message) {
  const entry = { type, message, ts: new Date().toISOString() };
  const s = readState();
  s.agent_state.log = [...(s.agent_state.log || []).slice(-49), entry];
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  const icon = { info: '·', tool: '⚙', done: '✓', wait: '⏸', error: '✗', claude: '◆' }[type] || '·';
  console.log(`${icon} ${message}`);
}

function pushState() {
  try { execSync('git add agent_state.json && git commit -m "agent state update" --allow-empty -q && git push -q 2>/dev/null', { cwd: LEDGER_DIR, stdio: 'ignore' }); } catch {}
}

// ── Project ────────────────────────────────────────────────────────────────

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const project = data.projects.find(p => p.id === PROJECT_ID);
if (!project) { console.error(`Project "${PROJECT_ID}" not found in data.json`); process.exit(1); }
if (!project.local_path) { console.error(`No local_path set for "${PROJECT_ID}". Add it via the dashboard.`); process.exit(1); }

const PROJECT_DIR = project.local_path;

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the project directory',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to project root' } },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write or update a file in the project directory. Auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to project root' },
        content: { type: 'string', description: 'Full file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory of the project',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Directory relative to project root (default: .)' } },
      required: []
    }
  },
  {
    name: 'run_bash',
    description: 'Run a bash command in the project directory. REQUIRES APPROVAL before execution.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
        reason: { type: 'string', description: 'Why this command is needed' }
      },
      required: ['command', 'reason']
    }
  },
  {
    name: 'mark_task_done',
    description: 'Mark an outstanding task as completed in the project ledger',
    input_schema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Exact text of the task to mark done' } },
      required: ['task']
    }
  },
  {
    name: 'request_decision',
    description: 'Pause and ask Nick to make a decision before continuing',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The decision or question' },
        options: { type: 'array', items: { type: 'string' }, description: 'Options to choose from' }
      },
      required: ['question', 'options']
    }
  }
];

// ── Tool execution ─────────────────────────────────────────────────────────

const isTTY = process.stdin.isTTY;
let rl = null;
if (isTTY) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
}

function askTerminal(q) {
  if (!rl) return new Promise(() => {}); // never resolves — dashboard only
  return new Promise(resolve => rl.question(q, resolve));
}

async function waitForApproval(id, description) {
  console.log('\n⏸  APPROVAL NEEDED:');
  console.log(`   ${description}`);
  if (isTTY) {
    console.log('   Type y/n here, or approve/reject in the dashboard.\n');
  } else {
    console.log('   Approve or reject in the dashboard at autonomous-ledger.vercel.app\n');
  }

  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (resolved) return;
      resolved = true;
      clearInterval(pollInterval);
      writeState({ pending: null });
      resolve(val);
    };

    // Terminal input (only if TTY)
    if (isTTY) {
      askTerminal('   → y/n: ').then(ans => done(ans.trim().toLowerCase() === 'y'));
    }

    // Dashboard poll (always)
    const pollInterval = setInterval(() => {
      try {
        const s = readState();
        const p = s.agent_state.pending;
        if (p && p.id === id && p.decision !== null && p.decision !== undefined) {
          console.log(`   Dashboard: ${p.decision ? 'approved' : 'rejected'}`);
          if (rl) rl.close();
          done(p.decision);
        }
      } catch {}
    }, 3000);
  });
}

async function executeTool(name, input) {
  if (name === 'read_file') {
    const full = path.join(PROJECT_DIR, input.path);
    try {
      const content = fs.readFileSync(full, 'utf8');
      log('tool', `read_file: ${input.path} (${content.length} chars)`);
      return content.slice(0, 8000); // cap to avoid huge files
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  if (name === 'write_file') {
    const full = path.join(PROJECT_DIR, input.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, input.content);
    log('tool', `write_file: ${input.path}`);
    return `Written: ${input.path}`;
  }

  if (name === 'list_files') {
    const dir = path.join(PROJECT_DIR, input.dir || '.');
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const result = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      log('tool', `list_files: ${input.dir || '.'}`);
      return result;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  }

  if (name === 'run_bash') {
    // Auto-approve read-only commands — only gate destructive/network ones
    const readOnly = /^(cat|ls|head|tail|grep|find|echo|pwd|wc|file|stat|diff|which|type)\s/.test(input.command.trim());
    if (readOnly) {
      log('tool', `run_bash (auto): ${input.command.slice(0,80)}`);
      try {
        const out = execSync(input.command, { cwd: PROJECT_DIR, timeout: 30000 }).toString();
        return out.slice(0, 4000) || '(no output)';
      } catch(e) { return `Error: ${e.message.slice(0,500)}`; }
    }
    const id = Date.now().toString();
    writeState({
      status: 'waiting',
      pending: { id, type: 'bash', description: `Run: ${input.command}\nReason: ${input.reason}`, decision: null }
    });
    log('wait', `run_bash needs approval: ${input.command}`);
    const approved = await waitForApproval(id, `Run: ${input.command}\nReason: ${input.reason}`);
    writeState({ status: 'running', pending: null });
    if (!approved) {
      log('info', `Skipped: ${input.command}`);
      return 'Command rejected by user — skip this and continue.';
    }
    try {
      const out = execSync(input.command, { cwd: PROJECT_DIR, timeout: 60000 }).toString();
      log('tool', `run_bash done: ${input.command}`);
      return out.slice(0, 4000) || '(no output)';
    } catch (e) {
      return `Error: ${e.message.slice(0, 1000)}`;
    }
  }

  if (name === 'mark_task_done') {
    const d = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    const p = d.projects.find(x => x.id === (global._currentProjectId || PROJECT_ID));
    if (p) {
      p.outstanding = p.outstanding.filter(t => t !== input.task);
      fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
      log('done', `Task done: ${input.task}`);
    }
    return `Marked done: ${input.task}`;
  }

  if (name === 'request_decision') {
    const id = Date.now().toString();
    const desc = `${input.question}\nOptions: ${input.options.join(' / ')}`;
    writeState({
      status: 'waiting',
      pending: { id, type: 'decision', description: desc, options: input.options, decision: null }
    });
    log('wait', `Decision needed: ${input.question}`);
    console.log('\n⏸  DECISION NEEDED:');
    console.log(`   ${input.question}`);
    input.options.forEach((o, i) => console.log(`   ${i + 1}. ${o}`));
    let choice = input.options[0]; // default to first option
    if (isTTY) {
      const ans = await askTerminal('   → Enter number or type answer: ');
      choice = parseInt(ans) ? input.options[parseInt(ans) - 1] || ans : ans;
    } else {
      // Wait for dashboard decision same as bash approval
      const decided = await waitForApproval(id, desc);
      choice = decided ? input.options[0] : input.options[1] || input.options[0];
    }
    writeState({ status: 'running', pending: null });
    return `User chose: ${choice}`;
  }

  return `Unknown tool: ${name}`;
}

// ── Claude API ─────────────────────────────────────────────────────────────

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      tools: TOOLS,
      system: `You are an autonomous software agent working on behalf of Nick Sinclair.
You have been given a project to work through. Use the available tools to read code, write files, and run commands.
Rules:
- Work through outstanding tasks in order
- File writes are auto-approved — do them directly
- Bash commands need approval — always provide a clear reason
- Mark tasks done as you complete them using mark_task_done
- If you hit a genuine decision point, use request_decision
- Be concise in your thinking. No long explanations unless asked.
- If you finish all tasks, say so clearly.`,
      messages
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API ${res.status}`);
  }
  return res.json();
}

// ── Main loop ──────────────────────────────────────────────────────────────

async function run(pid) {
  const p = pid ? data.projects.find(x => x.id === pid) : project;
  const dir = p.local_path;
  console.log(`\n◆ Autonomous agent starting: ${p.name}`);
  console.log(`  Directory : ${dir}`);
  console.log(`  Progress  : ${p.progress}%`);
  console.log(`  Tasks     : ${p.outstanding.length} outstanding\n`);

  writeState({ status: 'running', project: pid || PROJECT_ID, current_task: null, log: [], pending: null });

  const outstanding = p.outstanding.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const messages = [
    {
      role: 'user',
      content: `Project: ${p.name}
Status: ${p.status} | Progress: ${p.progress}%
Stack: ${p.tech_stack.join(', ')}
${p.one_liner}
${p.notes ? 'Notes: ' + p.notes : ''}

Outstanding tasks:
${outstanding || '(none — check if there is other work to do)'}

Start working through the outstanding tasks from the top. Use the tools available. Begin now.`
    }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 40;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    log('info', `Calling Claude (turn ${iterations})…`);

    let response;
    try {
      response = await callClaude(messages);
    } catch (e) {
      log('error', `Claude API error: ${e.message}`);
      writeState({ status: 'error' });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    // Print any text from Claude
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        log('claude', block.text.trim().slice(0, 200));
      }
    }

    // No tool calls → Claude is done or thinking
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (response.stop_reason === 'end_turn') {
        log('done', 'Agent completed all tasks.');
        writeState({ status: 'idle', current_task: null });
        break;
      }
      continue;
    }

    // Execute tools
    const toolResults = [];
    for (const tool of toolUses) {
      writeState({ current_task: tool.input.path || tool.input.command || tool.input.task || tool.name });
      const result = await executeTool(tool.name, tool.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (iterations >= MAX_ITERATIONS) {
    log('info', 'Reached iteration limit — stopping safely.');
    writeState({ status: 'idle' });
  }

  // Push final data.json state
  try {
    execSync('git add data.json agent_state.json && git commit -m "agent session complete" -q && git push -q', { cwd: LEDGER_DIR, stdio: 'ignore' });
  } catch {}

  rl.close();
  process.exit(0);
}

async function runAll() {
  for (let i = 0; i < PROJECT_IDS.length; i++) {
    const pid = PROJECT_IDS[i];
    const p = data.projects.find(x => x.id === pid);
    if (!p) { console.log(`⚠ Project "${pid}" not found — skipping`); continue; }
    if (!p.local_path) { console.log(`⚠ No local path for "${pid}" — skipping`); continue; }
    if (PROJECT_IDS.length > 1) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`▶ Project ${i + 1} of ${PROJECT_IDS.length}: ${p.name}`);
      console.log('─'.repeat(50));
    }
    // Reassign globals for current project
    global._currentProjectId = pid;
    await run(pid);
  }
  writeState({ status: 'idle', project: null, current_task: null });
  console.log('\n✓ All projects complete.');
  process.exit(0);
}

runAll().catch(e => {
  console.error('Fatal:', e.message);
  writeState({ status: 'error' });
  process.exit(1);
});
