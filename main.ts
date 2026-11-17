// Token Radar — make.fun token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed DeFiLlama snapshot, scores every pre-token protocol with the
// radar-2 model in lib/model.ts, and writes the ranked board, the dashboard data,
// the dashboard and screenshots, and the dossier the judge reads.
//
// Pipeline:
//   snapshot (/input/snapshot.json, or --input) -> board.json + data.js
//   dashboard/ + screenshots/ -> copied to the output
//   dossier.json -> built last from the finished output, via vendor/makefun-board.ts
//
// The dashboard is a static page with no framework and no network calls. It reads
// data.js, the same board this program writes.
//
// Local run (outside the grader, where /output is MAKEFUN_OUTPUT_DIR):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Gate caps from the scorer (reference/gate.json). The text cap shapes the dossier
// bytes; the screenshot and dashboard caps refuse outright.
const DOSSIER_TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASHBOARD_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flagValue(name: string, fallback: string): string {
  const args = process.argv;
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string, code: number): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

function copyDirFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const src = join(from, name);
    if (!statSync(src).isFile()) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = flagValue('input', '/input');
  const inputFile = inputArg.endsWith('.json')
    ? inputArg
    : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    fail(
      `no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`,
      2,
    );
  }
  const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    fail(`the model wrote a board the gate refuses: ${issue}`, 1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  writeFileSync(join(outDir, 'data.js'), dataScript(radar));

  copyDirFiles(join(ROOT, 'dashboard'), join(outDir, 'dashboard'));
  const shots = copyDirFiles(join(ROOT, 'screenshots'), join(outDir, 'screenshots'));
  if (shots.length < 3) {
    fail(
      `screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`,
      1,
    );
  }
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) {
      fail(
        `screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`,
        1,
      );
    }
  }

  // Dossier last: the scorer rebuilds it from this output and compares bytes.
  writeFileSync(
    join(outDir, 'dossier.json'),
    buildDossier(outDir, {
      text_max_bytes: DOSSIER_TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_LIMIT,
      dashboard: DASHBOARD_LIMIT,
    }),
  );

  process.stdout.write(
    `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
      `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (3 files), ${join(outDir, 'screenshots')} (${shots.length} images) and ${join(outDir, 'dossier.json')}\n`,
  );
}

main();
