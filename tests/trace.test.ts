import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  applyAnnotations,
  identityProcessor,
  ingest,
  nodeKey,
  traceProcessors,
} from '../src/core/index.ts';

const fixture = readFileSync(new URL('../testdata/fixtures/minimal.json', import.meta.url), 'utf8');
const { profile } = ingest(fixture);

test('ProcessTrace 逐步快照：identity 无差异，Annotation 步骤产出结构化 diff', () => {
  const first = profile.nodes[0];
  assert.ok(first);
  const trace = traceProcessors(
    profile,
    { configVersion: 'trace-test' },
    [
      identityProcessor,
      applyAnnotations([
        { nodeKey: nodeKey(first), excluded: true },
        { nodeKey: nodeKey(profile.nodes[1]!), alias: 'Renamed', order: 0 },
      ]),
    ],
  );

  assert.equal(trace.steps.length, 2);
  assert.deepEqual(trace.steps[0]?.diff, []);
  const kinds = trace.steps[1]?.diff.map((change) => change.kind) ?? [];
  assert.ok(kinds.includes('node-removed'));
  assert.ok(kinds.includes('node-renamed'));
  assert.ok(kinds.includes('node-reordered'));
  assert.equal(trace.final.nodes.length, profile.nodes.length - 1);
  assert.ok(Object.isFrozen(trace.final));
});

test('diffProfiles 不改写任何快照，before 仍是原 Profile', () => {
  const beforeJson = JSON.stringify(profile);
  const trace = traceProcessors(profile, { configVersion: 'x' }, [identityProcessor]);
  assert.equal(trace.final, profile);
  assert.equal(JSON.stringify(profile), beforeJson);
  assert.equal(trace.steps[0]?.before, profile);
});
