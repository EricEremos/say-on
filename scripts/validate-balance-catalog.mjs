import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const deckCodes = { everyday: 'e', together: 't', imagination: 'i', priorities: 'p' };
const fields = ['id', 'deck', 'intensity', 'prompt', 'optionA', 'optionB', 'followUp', 'tradeoff'];
const normalize = (value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

// Checks the authoring contract only. Editorial quality requires a separate review.
export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['Catalog must be an object'];
  if (catalog.version !== 'balance-v2') errors.push('Expected version balance-v2');
  if (catalog.language !== 'ko') errors.push('Expected language ko');
  if (catalog.status !== 'editorial-candidate') errors.push('Expected editorial-candidate status until release review');
  if (!Array.isArray(catalog.decks) || !Array.isArray(catalog.questions)) return [...errors, 'decks and questions must be arrays'];
  const deckIds = new Set();
  for (const deck of catalog.decks) {
    if (!deck || !Object.hasOwn(deckCodes, deck.id)) { errors.push('Unknown deck'); continue; }
    if (deckIds.has(deck.id)) errors.push(`Duplicate deck: ${deck.id}`);
    deckIds.add(deck.id);
    for (const field of ['title', 'description']) {
      if (typeof deck[field] !== 'string' || !deck[field].trim()) errors.push(`${deck.id}: missing ${field}`);
    }
  }
  if (catalog.decks.length !== 4 || deckIds.size !== 4) errors.push('Expected four distinct decks');
  if (catalog.questions.length !== 60) errors.push('Expected 60 questions');
  const ids = new Set();
  const prompts = new Set();
  const pairs = new Set();
  const counts = Object.fromEntries(Object.keys(deckCodes).map((deck) => [deck, 0]));
  for (const [index, question] of catalog.questions.entries()) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) { errors.push(`Question ${index}: expected object`); continue; }
    const label = typeof question.id === 'string' ? question.id : `Question ${index}`;
    const invalid = fields.filter((field) => typeof question[field] !== 'string' || !question[field].trim());
    if (invalid.length) { errors.push(`${label}: missing/non-text ${invalid.join(', ')}`); continue; }
    for (const field of Object.keys(question)) if (!fields.includes(field)) errors.push(`${label}: unknown field ${field}`);
    if (ids.has(question.id)) errors.push(`${label}: duplicate ID`);
    ids.add(question.id);
    const code = Object.hasOwn(deckCodes, question.deck) ? deckCodes[question.deck] : null;
    if (!code || !deckIds.has(question.deck)) errors.push(`${label}: unknown deck`);
    else {
      counts[question.deck]++;
      if (!new RegExp(`^bal-v2-${code}(0[1-9]|1[0-5])$`).test(question.id)) errors.push(`${label}: invalid stable ID for deck`);
    }
    const expectedIntensity = question.deck === 'priorities' ? 'reflective' : 'light';
    if (question.intensity !== expectedIntensity) errors.push(`${label}: expected ${expectedIntensity} intensity`);
    const prompt = normalize(question.prompt);
    if (prompts.has(prompt)) errors.push(`${label}: duplicate prompt`);
    prompts.add(prompt);
    const options = [normalize(question.optionA), normalize(question.optionB)];
    if (options[0] === options[1]) errors.push(`${label}: identical A/B choices`);
    const pair = JSON.stringify(options.sort());
    if (pairs.has(pair)) errors.push(`${label}: duplicate choice pair (including reversed A/B)`);
    pairs.add(pair);
  }
  for (const [deck, count] of Object.entries(counts)) if (count !== 15) errors.push(`${deck}: expected 15 questions, got ${count}`);
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = resolve(process.argv[2] ?? 'content/balance.v2.json');
    const source = readFileSync(path, 'utf8');
    const catalog = JSON.parse(source);
    const errors = validateCatalog(catalog);
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ status: 'pass', path, version: catalog.version, questions: catalog.questions.length,
        decks: Object.fromEntries(catalog.decks.map(({ id }) => [id, catalog.questions.filter((q) => q.deck === id).length])),
        sha256: createHash('sha256').update(source).digest('hex'), editorialQuality: 'not measured by this validator' }, null, 2));
    }
  } catch (error) {
    console.error(`Catalog validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
