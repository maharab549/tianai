import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { StoreState } from './types';

const emptyState = (): StoreState => ({ families: [], users: [], familyMembers: [], memories: [], memoryEmbeddings: [], consentRecords: [], voiceModels: [], conversations: [], messages: [], learningItems: [], trainingJobs: [], auditLog: [], metricEvents: [] });

export class DataStore {
  readonly state: StoreState;
  private readonly filePath: string;

  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'store.json');
    if (fs.existsSync(this.filePath)) {
      try { this.state = { ...emptyState(), ...JSON.parse(fs.readFileSync(this.filePath, 'utf8')) }; }
      catch { this.state = emptyState(); }
    } else {
      this.state = emptyState();
      this.seed();
    }
  }

  save() { fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2)); }

  private seed() {
    const now = new Date().toISOString();
    const familyId = randomUUID();
    const userId = randomUUID();
    const memberId = randomUUID();
    const memoryId = randomUUID();
    this.state.families.push({ id: familyId, name: 'The Chen Family', createdAt: now });
    this.state.users.push({ id: userId, familyId, name: 'Lin Chen', role: 'admin', email: 'demo@tianai.local', passwordHash: bcrypt.hashSync('demo1234', 10), isChildAccount: false, createdAt: now });
    this.state.familyMembers.push({ id: memberId, familyId, name: 'Mei Chen', relationship: 'Grandmother', isDeceased: false, posthumousStatus: 'active', createdAt: now });
    this.state.memories.push({ id: memoryId, familyMemberId: memberId, uploaderId: userId, type: 'text', title: 'The jasmine tea ritual', transcript: 'Every Sunday morning, Mei brewed jasmine tea in the blue ceramic pot. She said the first cup was for remembering and the second cup was for sharing.', tags: ['tradition', 'tea', 'sunday'], consentStatus: 'approved', createdAt: now, processedAt: now });
    this.state.memoryEmbeddings.push({ id: randomUUID(), memoryId, chunkText: this.state.memories[0].transcript!, embedding: embed(this.state.memories[0].transcript!), metadata: { familyMemberId: memberId, consentStatus: 'approved' } });
    this.state.auditLog.push({ id: randomUUID(), familyId, actorId: userId, action: 'seed.created', targetType: 'family', targetId: familyId, metadata: {}, createdAt: now });
    this.save();
  }
}

export function embed(text: string): number[] {
  const vector = Array.from({ length: 8 }, () => 0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    vector[Math.abs(hash) % vector.length] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, n) => sum + n * n, 0)) || 1;
  return vector.map(n => n / norm);
}

export function similarity(a: number[], b: number[]): number {
  return a.reduce((sum, n, i) => sum + n * (b[i] || 0), 0);
}

export function audit(store: DataStore, familyId: string, actorId: string | undefined, action: string, targetType: string, targetId?: string, metadata: Record<string, unknown> = {}) {
  store.state.auditLog.unshift({ id: randomUUID(), familyId, actorId, action, targetType, targetId, metadata, createdAt: new Date().toISOString() });
  store.save();
}

export function metric(store: DataStore, familyId: string | undefined, kind: string, value: number, metadata?: Record<string, unknown>) {
  store.state.metricEvents.push({ id: randomUUID(), familyId, kind, value, metadata, createdAt: new Date().toISOString() });
  if (store.state.metricEvents.length > 10000) store.state.metricEvents.splice(0, store.state.metricEvents.length - 10000);
  store.save();
}
