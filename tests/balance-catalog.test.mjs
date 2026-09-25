import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateCatalog } from '../scripts/validate-balance-catalog.mjs';

const source = JSON.parse(readFileSync(new URL('../content/balance.v2.json', import.meta.url), 'utf8'));
const copy = () => structuredClone(source);
test('replacement catalog satisfies the authoring contract', () => assert.deepEqual(validateCatalog(source), []));
test('rejects legacy version rather than silently reinterpreting it', () => {
  const data = copy(); data.version = 'balance-v1';
  assert.ok(validateCatalog(data).some((error) => error.includes('version')));
});
test('rejects duplicate IDs and IDs assigned to another deck', () => {
  const data = copy(); data.questions[1].id = data.questions[0].id; data.questions[2].deck = 'together';
  const errors = validateCatalog(data);
  assert.ok(errors.some((error) => error.includes('duplicate ID')));
  assert.ok(errors.some((error) => error.includes('invalid stable ID')));
});
test('rejects incomplete records without throwing', () => {
  const data = copy(); data.questions[0] = null; data.questions[1].followUp = '   '; data.questions[2].optionA = 3;
  assert.ok(validateCatalog(data).length >= 3);
  assert.ok(validateCatalog(null).length);
});
test('detects equal choices despite whitespace differences', () => {
  const data = copy(); data.questions[0].optionB = `  ${data.questions[0].optionA.replaceAll(' ', '  ')} `;
  assert.ok(validateCatalog(data).some((error) => error.includes('identical A/B')));
});
test('detects copied prompts and reversed choice pairs', () => {
  const data = copy(); data.questions[1].prompt = data.questions[0].prompt;
  data.questions[1].optionA = data.questions[0].optionB; data.questions[1].optionB = data.questions[0].optionA;
  const errors = validateCatalog(data);
  assert.ok(errors.some((error) => error.includes('duplicate prompt')));
  assert.ok(errors.some((error) => error.includes('duplicate choice pair')));
});
test('rejects unknown deck, extra fields, and wrong intensity', () => {
  const data = copy(); Object.assign(data.questions[0], { deck: 'unknown', intensity: 'extreme', answer: 'A' });
  const errors = validateCatalog(data);
  assert.ok(errors.some((error) => error.includes('unknown deck')));
  assert.ok(errors.some((error) => error.includes('unknown field')));
  assert.ok(errors.some((error) => error.includes('intensity')));
});
test('rejects missing questions and duplicate deck metadata', () => {
  const data = copy(); data.questions.pop(); data.decks[3] = data.decks[0];
  const errors = validateCatalog(data);
  assert.ok(errors.some((error) => error.includes('Expected 60')));
  assert.ok(errors.some((error) => error.includes('Duplicate deck')));
});
