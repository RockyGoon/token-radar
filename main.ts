// fitted-1 — make.fun token-radar-01 entry (Node 22+, standard library only).
//
// Reads the sealed DeFiLlama snapshot, fits the launch-value curve and the token
// odds on the snapshot's own protocols (see lib/fit.ts), ranks every rankable
// pre-token protocol by fitted launch value times odds, and writes the ranked board,
// the dashboard data, the dashboard and screenshots, and the dossier the judge reads.
//
// Pipeline:
//   snapshot (/input/snapshot.json, or --input) -> board.json + data.js
//   dashboard/ + screenshots/ -> copied to the output
//   dossier.json -> built last from the finished output, via vendor/makefun-board.ts
//
// The dashboard is a static page with no framework and no network calls. It reads
// data.js, the same board this program writes, and refits the model in the browser
// from the same comparison sets, so the page's numbers and the board's numbers are
// visibly the same arithmetic.
//
// Local run (outside the grader, where /output is MAKEFUN_OUTPUT_DIR):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Two runs write the same bytes: the fit is deterministic (fixed orders, seeded
// bootstrap), and nothing here reads the clock or the network.

import { createHash } from 'node:crypto';
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
const MODEL_VERSION = 'fitted-1';

// Gate caps from the scorer. The text cap shapes the dossier bytes; the screenshot
// and dashboard caps refuse outright.
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
  process.stderr.write(`fitted-1: ${message}\n`);
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

/** The first eight hex digits of this file's sha256: the build checksum the page shows. */
function ownChecksum(): string {
  const bytes = readFileSync(join(ROOT, 'main.ts'));
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

function main(): void {
  const inputArg = flagValue('input', '/input');
  const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
  if (!existsSync(inputFile)) {
    fail(
      `no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`,
      2,
    );
  }
  const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
  const { board, radar, valueFit, oddsFit } = buildRadar(snapshot, ownChecksum(), MODEL_VERSION);
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
  const dossierPath = join(outDir, 'dossier.json');
  writeFileSync(
    dossierPath,
    buildDossier(outDir, {
      text_max_bytes: DOSSIER_TEXT_MAX_BYTES,
      screenshots: SCREENSHOT_LIMIT,
      dashboard: DASHBOARD_LIMIT,
    }),
  );
  const dashboardBytes = readdirSync(join(outDir, 'dashboard')).reduce(
    (sum, name) => sum + statSync(join(outDir, 'dashboard', name)).size,
    0,
  );
  const shotBytes = shots.map((name) => `${name} ${statSync(join(outDir, 'screenshots', name)).size}B`).join(', ');

  const books = radar.accounting;
  process.stdout.write(
    `fitted-1: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows ranked ` +
      `(${books.rankedWatchlist} watchlist, ${books.rankedOfflist} off-list; ledger ${books.total}/${snapshot.protocols.length})\n` +
      `fitted-1: value curve on ${valueFit.compCount} comps: terms [${valueFit.terms.join(', ')}], ` +
      `miss x${valueFit.looMiss.toFixed(2)} leave-one-out, x${valueFit.wfMiss.toFixed(2)} walk-forward (flat x${valueFit.flatLooMiss.toFixed(2)}/x${valueFit.flatWfMiss.toFixed(2)})\n` +
      `fitted-1: token odds on ${oddsFit.peerCount} peers: terms [${oddsFit.terms.join(', ')}], ` +
      `Brier ${oddsFit.brierCv.toFixed(3)} ten-fold, ${oddsFit.brierWf.toFixed(3)} walk-forward (base rate ${oddsFit.baseBrier.toFixed(3)})\n` +
      `fitted-1: range honesty ${Math.round(valueFit.cover2575 * 100)}% inside P25-P75 (stated 50%), ` +
      `${Math.round(valueFit.cover1090 * 100)}% inside P10-P90 (stated 80%); worth farming at defaults: ${radar.worthFarming} of ${board.length}\n` +
      `fitted-1: dashboard text ${dashboardBytes}B of ${DOSSIER_TEXT_MAX_BYTES}B; screenshots ${shotBytes}; dossier ${statSync(dossierPath).size}B\n` +
      `fitted-1: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')}, ` +
      `${join(outDir, 'screenshots')} (${shots.length} images) and ${dossierPath}\n`,
  );
}

main();
