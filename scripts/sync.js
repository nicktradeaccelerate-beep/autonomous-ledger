#!/usr/bin/env node
/**
 * Operating Ledger sync script.
 * Reads the CLAUDE.md from the current working directory (passed as CWD or argv[2]),
 * calls Claude API to extract/update project metadata, merges into data.json,
 * commits and pushes to GitHub so Vercel auto-deploys.
 *
 * Called automatically by the Claude Code Stop hook after every session.
 * Can also be run manually: node sync.js [path/to/project]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const LEDGER_DIR = path.resolve(__dirname, '..');
const DATA_PATH = path.join(LEDGER_DIR, 'data.json');
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Project dir: argv[2] or stdin JSON cwd (Stop hook passes JSON on stdin)
async function getProjectDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);

  // Stop hook passes JSON on stdin
  return new Promise(resolve => {
    let raw = '';
    if (process.stdin.isTTY) return resolve(process.cwd());
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => raw += d);
    process.stdin.on('end', () => {
      try {
        const obj = JSON.parse(raw);
        resolve(obj.cwd || process.cwd());
      } catch {
        resolve(process.cwd());
      }
    });
    setTimeout(() => resolve(process.cwd()), 2000);
  });
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch { reject(new Error('Bad API response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!API_KEY) {
    console.log('[sync] ANTHROPIC_API_KEY not set — skipping.');
    process.exit(0);
  }

  const projectDir = await getProjectDir();
  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');

  if (!fs.existsSync(claudeMdPath)) {
    console.log('[sync] No CLAUDE.md found at', projectDir, '— skipping.');
    process.exit(0);
  }

  // Don't sync the ledger repo itself
  if (path.resolve(projectDir) === path.resolve(LEDGER_DIR)) {
    process.exit(0);
  }

  const claudeMd = fs.readFileSync(claudeMdPath, 'utf8').slice(0, 6000);
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  const existingIds = data.projects.map(p => p.id).join(', ');
  const dirName = path.basename(projectDir);

  const prompt = `You are updating an operating ledger JSON database.

Read this CLAUDE.md and extract a project entry. Return ONLY valid JSON — no markdown, no explanation.

CLAUDE.md content:
---
${claudeMd}
---

Directory name: ${dirName}
Existing project IDs in ledger: ${existingIds}

Return a single JSON object matching this schema exactly:
{
  "id": "kebab-case-id (use existing ID if this project is already listed, or derive from directory name)",
  "name": "Full project name",
  "ecosystem": "Which ecosystem (PTO / Caldr / BFB / Comet / Thor / Procurai / Internal / Standalone / Partnerships / Property / Trade Accelerate)",
  "status": "One of: Live | Build sprint | Designed | Pending",
  "progress": 0-100,
  "one_liner": "One sentence describing what this is",
  "tech_stack": ["array", "of", "tech"],
  "connections": ["related projects or people"],
  "revenue_model": "How this makes money",
  "outstanding": ["list", "of", "open", "tasks"],
  "key_docs": ["list of key documents or files"]
}`;

  let result;
  try {
    const raw = await callClaude(prompt);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    result = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.log('[sync] Claude extraction failed:', e.message);
    process.exit(0);
  }

  // Merge: update existing or append new
  const idx = data.projects.findIndex(p => p.id === result.id);
  if (idx >= 0) {
    data.projects[idx] = { ...data.projects[idx], ...result };
    console.log('[sync] Updated project:', result.id);
  } else {
    data.projects.push(result);
    console.log('[sync] Added new project:', result.id);
  }

  data.team_data.last_updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  // Commit and push
  try {
    execSync(`git -C "${LEDGER_DIR}" add data.json`);
    execSync(`git -C "${LEDGER_DIR}" diff --cached --quiet || git -C "${LEDGER_DIR}" commit -m "sync: update ${result.id} [auto]"`);
    execSync(`git -C "${LEDGER_DIR}" push origin main`, { stdio: 'pipe' });
    console.log('[sync] Pushed to GitHub — Vercel deploying.');
  } catch (e) {
    console.log('[sync] Git push failed:', e.message);
  }
}

main().catch(e => { console.log('[sync] Error:', e.message); process.exit(0); });
