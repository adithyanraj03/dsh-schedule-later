import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ui-polish spec: button carries a text label and the open state shows the badge.
// FIX3: the model-switch strings/routes must be gone from the bundle.
test('alarm button text label + scheduling badge present in bundle; model switch absent', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(src.includes('"Schedule"') && src.includes('StopwatchIcon'), 'button label: stopwatch icon + Schedule');
  assert.ok(src.includes('Scheduling…'), 'scheduling-in-progress badge');
  assert.ok(src.includes('Schedule send'), 'popover card title');
  assert.ok(!src.includes('switch model at send time'), 'FIX3: model dropdown label removed');
  assert.ok(!src.includes('model-selected'), 'FIX3: model-selected route gone');
  assert.ok(!src.includes('modelDirectories'), 'FIX3: modelDirectories inject gone');
  assert.ok(src.includes('(max-width: 480px)'), 'FIX5: mobile media query present');
});
