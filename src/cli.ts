import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ingest, runProcessors, identityProcessor } from './core/index.ts';
import type { SourceFormat } from './core/index.ts';
import { buildAll, outputFilename } from './pipeline.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const fixturePath = join(projectRoot, 'testdata', 'fixtures', 'minimal.json');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    input: { type: 'string' },
    format: { type: 'string' },
    'out-dir': { type: 'string' },
    write: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const command = positionals[0] ?? 'smoke';

if (values.help === true || command === 'help') {
  console.log(`Startrails CLI
  node src/cli.ts smoke  [--input <file>] [--format <fmt>]
  node src/cli.ts build  --input <file> [--out-dir <dir>]
  node src/cli.ts golden [--write]
  node src/cli.ts report [--input <file>] [--format <fmt>]

formats: startrails-json | sing-box-json | subscription-uri | clash-yaml | surge-ini`);
  process.exit(0);
}

const inputPath = values.input ?? fixturePath;
const raw = readFileSync(inputPath, 'utf8');
const ingested = ingest(raw, values.format as SourceFormat | undefined);
const processed = runProcessors(ingested.profile, { configVersion: 'M1' }, [identityProcessor]);
const outputs = buildAll(processed.profile);

if (command === 'smoke' || command === 'report') {
  console.log(`startrails | format=${ingested.format} nodes=${processed.profile.nodes.length} skipped=${ingested.skipped}`);
  for (const diagnostic of ingested.diagnostics) {
    console.log(`  ingest: ${diagnostic.subject} — ${diagnostic.reason}`);
  }
  for (const output of outputs) {
    console.log(
      `  ${output.target.padEnd(9)} passed=${output.report.passed} skipped=${output.report.skipped} ` +
        `diagnostics=${output.report.diagnostics.length} bytes=${output.content.length}`,
    );
  }
  if (command === 'report') {
    for (const output of outputs) {
      console.log(`\n--- ${output.target} diagnostics ---`);
      for (const diagnostic of output.report.diagnostics) {
        console.log(`  [${diagnostic.stage}] ${diagnostic.subject} — ${diagnostic.reason}`);
      }
    }
  }
} else if (command === 'build' || command === 'golden') {
  const outDir =
    command === 'golden'
      ? join(projectRoot, 'testdata', 'golden')
      : (values['out-dir'] ?? join(projectRoot, 'out'));
  if (values.write === true || command === 'build') {
    mkdirSync(outDir, { recursive: true });
  }
  for (const output of outputs) {
    const file = join(outDir, outputFilename(output.target));
    if (values.write === true || command === 'build') {
      writeFileSync(file, output.content, 'utf8');
    }
    console.log(`${command === 'golden' ? (values.write === true ? 'wrote  ' : 'checked') : 'wrote  '} ${file}`);
  }
} else {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}
