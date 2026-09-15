import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DataStore, embed, similarity } from '../src/store';
import { processMemory } from '../src/services';
import { extractExplicitLearning, generateGroundedAnswer } from '../src/llm';

test('embeddings are deterministic and comparable', () => {
  const tea = embed('blue ceramic jasmine tea');
  assert.equal(tea.length, 8);
  assert.ok(similarity(tea, tea) > 0.99);
  assert.ok(similarity(tea, embed('mountain bicycle')) < 0.8);
});

test('memory processing creates chunks before approval but retrieval metadata stays pending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianai-test-'));
  const store = new DataStore(dir);
  const family = store.state.families[0]; const member = store.state.familyMembers[0]; const user = store.state.users[0];
  const memory = { id: 'pending-memory', familyMemberId: member.id, uploaderId: user.id, type: 'audio' as const, title: 'A recording', transcript: 'A story about a summer garden', tags: [], consentStatus: 'pending' as const, createdAt: new Date().toISOString() };
  store.state.memories.push(memory); await processMemory(store, memory.id, family.id);
  assert.equal(store.state.memoryEmbeddings.filter(e => e.memoryId === memory.id).length, 1);
  assert.equal(store.state.memoryEmbeddings.find(e => e.memoryId === memory.id)?.metadata.consentStatus, 'pending');
  memory.consentStatus = 'approved'; store.state.memoryEmbeddings.filter(e => e.memoryId === memory.id).forEach(e => { e.metadata.consentStatus = 'approved'; }); store.save();
  assert.equal(store.state.memoryEmbeddings.find(e => e.memoryId === memory.id)?.metadata.consentStatus, 'approved');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('learning extractor keeps questions out of the durable profile', () => {
  assert.equal(extractExplicitLearning('What do you remember about the Sunday tea ritual?').length, 0);
  assert.equal(extractExplicitLearning('Please remember that Mei always greets visitors warmly.')[0]?.kind, 'style');
});

test('social greetings stay conversational without inventing a memory', async () => {
  const result = await generateGroundedAnswer('Mei Chen', 'hi', []);
  assert.equal(result.mode, 'conversation');
  assert.match(result.answer, /Hello/);
});

test('emotional messages receive a warm acknowledgement without inventing a memory', async () => {
  const result = await generateGroundedAnswer('Mei Chen', 'i miss you so much', []);
  assert.equal(result.mode, 'conversation');
  assert.doesNotMatch(result.answer, /approved memory|no approved/i);
  assert.match(result.answer, /hear|together/i);
});

test('plural missing-you messages stay spoken and free of roleplay directions', async () => {
  const result = await generateGroundedAnswer('Mei Chen', 'we are missing you', []);
  assert.equal(result.mode, 'conversation');
  assert.match(result.answer, /hear|together/i);
  assert.doesNotMatch(result.answer, /\*|pause|smiles|eyes glistening|voice soft/i);
});
