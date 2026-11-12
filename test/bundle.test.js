import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ui-polish spec: button carries a text label and the open state shows the badge.
// Per-message model selection: the detail card renders a picker fed by dsh's own
// model catalog (modelDirectories + the modelCatalog RPC).
test('alarm button text label + scheduling badge present in bundle; model picker present', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('"Schedule"') && src.includes('StopwatchIcon'), 'button label: stopwatch icon + Schedule');
  assert.ok(src.includes('Scheduling…'), 'scheduling-in-progress badge');
  assert.ok(src.includes('Schedule send'), 'popover card title');
  assert.ok(!src.includes('switch model at send time'), 'old dropdown label never returns');
  assert.ok(src.includes('modelDirectories'), 'per-message model picker resolves dsh model directories');
  assert.ok(src.includes('modelCatalog'), 'per-message model picker loads dsh model catalog');
  assert.ok(src.includes('data-model-choice'), 'picker rows are addressable');
  assert.ok(src.includes('(max-width: 480px)'), 'FIX5: mobile media query present');
});
