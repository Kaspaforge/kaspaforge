import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
const js = readFileSync(new URL('./boards.js', import.meta.url), 'utf8');
test('thread view has a tail notice and offset-paged full load', () => {
  assert.match(js, /post_count/);
  assert.match(js, /Skipped .* posts|skipped-note/i);
  assert.match(js, /show full thread/i);
  assert.match(js, /offset=/);
  assert.doesNotThrow(() => new vm.Script(js.replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, '')));
});
