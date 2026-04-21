#!/usr/bin/env node
// scheduler.js
// Runs automatically via LaunchAgent on login and at 8:30am daily.
// Picks projects with outstanding tasks + local paths, runs agent on them.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const HOME = process.env.HOME;
const LEDGER_DIR = path.join(HOME, 'autonomous-ledger');
const DATA_PATH = path.join(LEDGER_DIR, 'data.json');
const STATE_PATH = path.join(LEDGER_DIR, 'agent_state.json');
const LOG_PATH = path.join(LEDGER_DIR, 'scheduler.log');
const AGENT_PATH = path.join(LEDGER_DIR, 'scripts/agent.js');
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function log(msg) {
  const line = `${new Date().toISOString().slice(0,19).replace('T',' ')}  ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { agent_state: { status: 'idle' } }; }
}

// Don't run if agent already running
const state = readState();
if (state.agent_state.status === 'running' || state.agent_state.status === 'waiting') {
  log(`Scheduler: agent already ${state.agent_state.status} on ${state.agent_state.project} — skipping`);
  process.exit(0);
}

if (!ANTHROPIC_KEY) {
  log('Scheduler: ANTHROPIC_API_KEY not set — skipping');
  process.exit(0);
}

// Load projects
let data;
try { data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
catch(e) { log('Scheduler: could not read data.json — ' + e.message); process.exit(1); }

// Pick projects: has local_path + has outstanding tasks + not fully complete
const candidates = data.projects
  .filter(p => p.local_path && p.outstanding.length > 0 && p.progress < 100)
  .filter(p => {
    // Check directory exists
    try { fs.accessSync(p.local_path); return true; } catch { return false; }
  })
  .sort((a, b) => {
    // Priority: more outstanding tasks first, then lower progress first
    if (b.outstanding.length !== a.outstanding.length) return b.outstanding.length - a.outstanding.length;
    return a.progress - b.progress;
  });

if (!candidates.length) {
  log('Scheduler: no projects with outstanding tasks and local paths — nothing to do');
  process.exit(0);
}

// Work top 2 projects per session to avoid running all day
const toRun = candidates.slice(0, 2);
log(`Scheduler: starting session — ${toRun.map(p => p.name).join(', ')}`);

// Update state
const s = readState();
s.agent_state.scheduler_last_run = new Date().toISOString();
s.agent_state.scheduler_projects = toRun.map(p => p.id);
fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));

// Spawn agent detached so scheduler exits and agent runs independently
const ids = toRun.map(p => p.id);
const child = spawn(process.execPath, [AGENT_PATH, ...ids], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY }
});
child.unref();

log(`Scheduler: agent spawned (PID ${child.pid}) for: ${ids.join(', ')}`);
process.exit(0);
