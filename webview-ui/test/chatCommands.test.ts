import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  parseLocalCommand,
  resolveMode,
  resolveModel,
  suggestCommands,
} from '../src/chat/commands.ts';

test('the window runs /model, /mode and /help itself and passes other commands to Claude', () => {
  assert.deepEqual(parseLocalCommand('/model'), { kind: 'model', arg: '' });
  assert.deepEqual(parseLocalCommand('  /MODEL  opus '), { kind: 'model', arg: 'opus' });
  assert.deepEqual(parseLocalCommand('/mode 자동'), { kind: 'mode', arg: '자동' });
  assert.deepEqual(parseLocalCommand('/help'), { kind: 'help' });
  assert.equal(parseLocalCommand('/compact'), null);
  assert.equal(parseLocalCommand('/review 이 파일'), null);
  assert.equal(parseLocalCommand('모델 바꿔줘'), null);
});

test('modes accept Korean and English names', () => {
  assert.equal(resolveMode('자동'), 'auto');
  assert.equal(resolveMode('AUTO'), 'auto');
  assert.equal(resolveMode('편집'), 'acceptEdits');
  assert.equal(resolveMode('acceptEdits'), 'acceptEdits');
  assert.equal(resolveMode('무엇'), null);
});

test('model names match the catalog loosely and pass through when unknown', () => {
  const models = [
    { value: 'opus', displayName: 'Opus 5.5', description: '' },
    { value: 'sonnet', displayName: 'Sonnet 5', description: '' },
  ];
  assert.equal(resolveModel('Opus', models), 'opus');
  assert.equal(resolveModel('sonnet 5', models), 'sonnet');
  assert.equal(resolveModel('5.5', models), 'opus');
  assert.equal(resolveModel('claude-haiku-4-5', models), 'claude-haiku-4-5');
});

test('suggestions follow the typed prefix, own commands first, no duplicates', () => {
  const cli = [
    { name: 'compact', description: 'c', argumentHint: '' },
    { name: 'model', description: 'dup', argumentHint: '' },
    { name: 'mcp', description: 'm', argumentHint: '' },
  ];
  assert.deepEqual(
    suggestCommands('/m', cli).map((c) => c.name),
    ['model', 'mode', 'mcp'],
  );
  assert.deepEqual(suggestCommands('/model opus', cli), []);
  assert.deepEqual(suggestCommands('hello', cli), []);
});
