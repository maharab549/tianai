import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { DataStore, audit, embed, metric, similarity } from './store';
import { processMemory, LocalAvatarProvider, createVoiceProvider, prepareReferenceAudio } from './services';
import { DEFAULT_REFUSAL, extractExplicitLearning, generateGroundedAnswer, localLlmStatus, reviewConversationForLearning, setLocalLoraPath, warmLocalModel } from './llm';
import { ConsentType, LearningItem, MemoryType, Role, TrainingJob, User, VoiceModel } from './types';

const app = express();
const port = Number(process.env.PORT || 4000);
const secret = process.env.JWT_SECRET || 'tianai-local-secret';
const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const storageDir = process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage');
fs.mkdirSync(storageDir, { recursive: true });
const store = new DataStore(dataDir);
const voiceProvider = createVoiceProvider();
const avatarProvider = new LocalAvatarProvider();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: '4mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use('/storage', express.static(storageDir));

interface AuthRequest extends Request { user?: User; }
interface TokenPayload { sub: string; familyId: string; role: Role; }

function tokenFor(user: User) { return jwt.sign({ sub: user.id, familyId: user.familyId, role: user.role } satisfies TokenPayload, secret, { expiresIn: '7d' }); }
function publicUser(user: User) { const { passwordHash: _passwordHash, ...safe } = user; return safe; }
function deleteVoiceModelFiles(model: VoiceModel) {
  voiceProvider.delete(path.join(storageDir, model.modelPath));
  if (model.referenceAudioPath) voiceProvider.delete(path.join(storageDir, model.referenceAudioPath));
}
function auth(req: AuthRequest, res: Response, next: NextFunction) {
  const value = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!value) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(value, secret) as TokenPayload;
    const user = store.state.users.find(item => item.id === decoded.sub && item.familyId === decoded.familyId);
    if (!user) return res.status(401).json({ error: 'Session is no longer valid' });
    req.user = user;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired session' }); }
}
function roles(...allowed: Role[]) { return (req: AuthRequest, res: Response, next: NextFunction) => req.user && allowed.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission for this action' }); }
function requiredUser(req: AuthRequest) { return req.user!; }
function bad(res: Response, message: string, status = 400) { return res.status(status).json({ error: message }); }
function familyMember(req: AuthRequest, id: string) { return store.state.familyMembers.find(member => member.id === id && member.familyId === requiredUser(req).familyId); }
function activeConsent(memberId: string, type: ConsentType) { return store.state.consentRecords.find(c => c.familyMemberId === memberId && c.type === type && !c.revokedAt); }
function safeTitle(value: unknown, fallback = 'Untitled memory') { return String(value || fallback).trim().slice(0, 160) || fallback; }
function containsUnsafeContent(value: string) { return /<script|self-harm instruction|explicit sexual/i.test(value); }
function lexicalOverlap(query: string, text: string) {
  const stopWords = new Set(['the', 'what', 'which', 'when', 'where', 'who', 'why', 'how', 'is', 'are', 'was', 'were', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'do', 'does', 'did', 'you', 'your', 'me', 'my', 'about', 'tell', 'please', 'remember']);
  const terms = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).map(token => token.replace(/ies$/, 'y').replace(/(ing|ed)$/, '').replace(/s$/, '')).filter(token => token.length > 2 && !stopWords.has(token));
  const queryTerms = new Set(terms(query));
  const textTerms = new Set(terms(text));
  let overlap = 0; queryTerms.forEach(term => { if (textTerms.has(term)) overlap += 1; });
  return queryTerms.size ? overlap / queryTerms.size : 0;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'tianai-api', time: new Date().toISOString() }));
app.get('/api/llm/status', auth, async (_req: AuthRequest, res: Response) => res.json(await localLlmStatus()));

app.post('/api/auth/register-family', (req, res) => {
  const { familyName, name, email, password } = req.body || {};
  if (!familyName || !name || !email || !password || String(password).length < 8) return bad(res, 'Family name, name, email, and a password of at least 8 characters are required');
  const normalizedEmail = String(email).toLowerCase().trim();
  if (store.state.users.some(user => user.email === normalizedEmail)) return bad(res, 'An account with that email already exists', 409);
  const family = { id: randomUUID(), name: safeTitle(familyName), createdAt: new Date().toISOString() };
  const user: User = { id: randomUUID(), familyId: family.id, name: safeTitle(name), role: 'admin', email: normalizedEmail, passwordHash: bcrypt.hashSync(String(password), 10), isChildAccount: false, createdAt: new Date().toISOString() };
  store.state.families.push(family); store.state.users.push(user); store.save();
  audit(store, family.id, user.id, 'family.created', 'family', family.id);
  res.status(201).json({ token: tokenFor(user), user: publicUser(user), family });
});

app.post('/api/auth/login', (req, res) => {
  const normalizedEmail = String(req.body?.email || '').toLowerCase().trim();
  const user = store.state.users.find(item => item.email === normalizedEmail);
  if (!user || !bcrypt.compareSync(String(req.body?.password || ''), user.passwordHash)) return bad(res, 'Email or password is incorrect', 401);
  metric(store, user.familyId, 'auth.login', 1, { role: user.role });
  res.json({ token: tokenFor(user), user: publicUser(user), family: store.state.families.find(f => f.id === user.familyId) });
});
app.post('/api/auth/accept-invite', (req, res) => {
  const { inviteToken, password } = req.body || {};
  if (!inviteToken || !password || String(password).length < 8) return bad(res, 'Invite token and a new password of at least 8 characters are required');
  try {
    const decoded = jwt.verify(String(inviteToken), secret) as TokenPayload; const user = store.state.users.find(item => item.id === decoded.sub && item.familyId === decoded.familyId);
    if (!user) return bad(res, 'Invite is no longer valid', 401);
    user.passwordHash = bcrypt.hashSync(String(password), 10); store.save(); audit(store, user.familyId, user.id, 'family.invite.accepted', 'user', user.id); res.json({ token: tokenFor(user), user: publicUser(user), family: store.state.families.find(f => f.id === user.familyId) });
  } catch { return bad(res, 'Invite is no longer valid', 401); }
});

app.get('/api/auth/me', auth, (req: AuthRequest, res) => {
  const user = requiredUser(req);
  res.json({ user: publicUser(user), family: store.state.families.find(f => f.id === user.familyId) });
});

app.get('/api/bootstrap', auth, (req: AuthRequest, res) => {
  const user = requiredUser(req);
  const members = store.state.familyMembers.filter(m => m.familyId === user.familyId);
  const visibleMemories = store.state.memories.filter(memory => {
    const member = members.find(m => m.id === memory.familyMemberId);
    return member && (user.role !== 'child' ? true : memory.consentStatus === 'approved');
  });
  res.json({ user: publicUser(user), family: store.state.families.find(f => f.id === user.familyId), members, memories: visibleMemories.map(memoryView), consents: store.state.consentRecords.filter(c => members.some(m => m.id === c.familyMemberId)), voiceModels: store.state.voiceModels.filter(model => model.status === 'active' && members.some(m => m.id === model.familyMemberId)), pendingApprovals: user.role === 'admin' ? visibleMemories.filter(m => m.consentStatus === 'pending').length : 0 });
});

function memoryView(memory: typeof store.state.memories[number]) {
  const member = store.state.familyMembers.find(m => m.id === memory.familyMemberId);
  const uploader = store.state.users.find(u => u.id === memory.uploaderId);
  return { ...memory, familyMemberName: member?.name, uploaderName: uploader?.name, hasTranscript: Boolean(memory.transcript), sourceUrl: memory.storagePath ? `/storage/${memory.storagePath.replace(/\\/g, '/')}` : undefined };
}

function learningView(item: LearningItem) {
  const member = store.state.familyMembers.find(m => m.id === item.familyMemberId);
  return { ...item, familyMemberName: member?.name };
}

function familyLearnings(familyId: string, includePending = true) {
  return store.state.learningItems.filter(item => item.familyId === familyId && (includePending || item.status === 'approved'));
}

function learningDataset(familyId: string) {
  const approved = familyLearnings(familyId, false);
  return approved.map(item => {
    const member = store.state.familyMembers.find(candidate => candidate.id === item.familyMemberId);
    const style = item.kind === 'style' ? `Use this approved conversational style guidance: ${item.content}` : '';
    return {
      messages: [
        { role: 'system', content: `You are a private family-memory assistant for ${member?.name || 'the family member'}. Never invent memories. ${style}`.trim() },
        { role: 'user', content: item.kind === 'style' ? 'How should you speak with the family?' : `What should you remember about ${member?.name || 'this person'}?` },
        { role: 'assistant', content: item.content },
      ],
      metadata: { learningId: item.id, memberId: item.familyMemberId, kind: item.kind, title: item.title },
    };
  });
}

function startTrainingJob(job: TrainingJob) {
  const script = path.resolve(process.env.TRAINING_SCRIPT || path.join(__dirname, '../training/train_lora.py'));
  const python = process.env.TRAINING_PYTHON || 'python';
  const baseModel = job.baseModel;
  const args = [script, '--dataset', job.datasetPath, '--output', job.outputPath, '--base-model', baseModel];
  job.command = `${python} ${args.join(' ')}`;
  job.status = 'running'; job.startedAt = new Date().toISOString(); store.save();
  const child = spawn(python, args, { cwd: path.dirname(script), windowsHide: true });
  let log = '';
  const append = (chunk: Buffer) => { log = `${log}${chunk.toString()}`.slice(-20000); job.log = log; store.save(); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  child.once('error', error => { job.status = 'failed'; job.error = error.message; job.finishedAt = new Date().toISOString(); store.save(); });
  child.once('close', code => {
    job.status = code === 0 ? 'completed' : 'failed';
    job.error = code === 0 ? undefined : `Training process exited with code ${code}`;
    const convertedAdapter = path.join(job.outputPath, 'adapter.gguf');
    if (code === 0 && fs.existsSync(convertedAdapter)) { job.adapterPath = convertedAdapter; setLocalLoraPath(convertedAdapter); }
    job.finishedAt = new Date().toISOString();
    store.save();
  });
}

function queueTrainingJob(familyId: string, automatic = true) {
  const dataset = learningDataset(familyId);
  const threshold = Math.max(3, Number(process.env.LEARNING_AUTO_RETRAIN_THRESHOLD || 20));
  const latest = store.state.trainingJobs.find(job => job.familyId === familyId && (job.status === 'queued' || job.status === 'running')) || store.state.trainingJobs.find(job => job.familyId === familyId);
  if (dataset.length < threshold || (latest && dataset.length - Number(latest.sampleCount || 0) < threshold && automatic)) return undefined;
  const userDir = path.join(dataDir, 'learning', familyId);
  const jobId = randomUUID(); const jobDir = path.join(userDir, jobId); fs.mkdirSync(jobDir, { recursive: true });
  const datasetPath = path.join(jobDir, 'dataset.jsonl'); fs.writeFileSync(datasetPath, dataset.map(row => JSON.stringify(row)).join('\n'));
  const job: TrainingJob = { id: jobId, familyId, status: 'queued', baseModel: String(process.env.TRAINING_BASE_MODEL || 'Qwen/Qwen3-4B'), datasetPath, outputPath: path.join(jobDir, 'adapter'), sampleCount: dataset.length, automatic, createdAt: new Date().toISOString() };
  store.state.trainingJobs.unshift(job); store.save(); metric(store, familyId, 'learning.retraining_queued', 1, { samples: dataset.length, automatic }); startTrainingJob(job); return job;
}

app.get('/api/learning', auth, (req: AuthRequest, res: Response) => {
  const user = requiredUser(req);
  const items = familyLearnings(user.familyId, user.role !== 'child').filter(item => user.role !== 'child' || item.status === 'approved');
  const jobs = store.state.trainingJobs.filter(job => job.familyId === user.familyId).slice(0, 20);
  res.json({ items: items.map(learningView), jobs, threshold: Math.max(3, Number(process.env.LEARNING_AUTO_RETRAIN_THRESHOLD || 20)), pending: items.filter(item => item.status === 'pending').length, approved: items.filter(item => item.status === 'approved').length });
});

app.post('/api/learning/:id/approve', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const item = store.state.learningItems.find(candidate => candidate.id === req.params.id && candidate.familyId === user.familyId);
  if (!item) return bad(res, 'Learning candidate not found', 404);
  item.status = 'approved'; item.reviewedAt = new Date().toISOString(); item.reviewedBy = user.id; store.save(); audit(store, user.familyId, user.id, 'learning.approved', 'learning_item', item.id, { kind: item.kind }); res.json(learningView(item));
});

app.post('/api/learning/:id/reject', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const item = store.state.learningItems.find(candidate => candidate.id === req.params.id && candidate.familyId === user.familyId);
  if (!item) return bad(res, 'Learning candidate not found', 404);
  item.status = 'rejected'; item.reviewedAt = new Date().toISOString(); item.reviewedBy = user.id; store.save(); audit(store, user.familyId, user.id, 'learning.rejected', 'learning_item', item.id, { kind: item.kind }); res.json(learningView(item));
});

app.delete('/api/learning/:id', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const index = store.state.learningItems.findIndex(candidate => candidate.id === req.params.id && candidate.familyId === user.familyId);
  if (index < 0) return bad(res, 'Learning item not found', 404);
  const [item] = store.state.learningItems.splice(index, 1); store.save(); audit(store, user.familyId, user.id, 'learning.deleted', 'learning_item', item.id); res.status(204).send();
});

app.get('/api/learning/export', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const dataset = learningDataset(user.familyId);
  res.setHeader('Content-Type', 'application/x-ndjson'); res.setHeader('Content-Disposition', `attachment; filename="tianai-${user.familyId}-learning.jsonl"`); res.send(dataset.map(row => JSON.stringify(row)).join('\n'));
});

app.post('/api/learning/retrain', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const job = queueTrainingJob(user.familyId, false);
  if (!job) return bad(res, `Retraining needs at least ${Math.max(3, Number(process.env.LEARNING_AUTO_RETRAIN_THRESHOLD || 20))} approved learning examples or an existing job gap of that size`);
  audit(store, user.familyId, user.id, 'learning.retraining_started', 'training_job', job.id, { samples: job.sampleCount, baseModel: job.baseModel }); res.status(202).json(job);
});

app.get('/api/learning/jobs/:id', auth, roles('admin'), (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const job = store.state.trainingJobs.find(candidate => candidate.id === req.params.id && candidate.familyId === user.familyId);
  if (!job) return bad(res, 'Training job not found', 404);
  res.json(job);
});

async function learnFromConversation(familyId: string, memberId: string, conversationId: string, messageIds: string[], memberName: string, query: string, answer: string, approvedMemoryText: string) {
  const explicit = extractExplicitLearning(query);
  let candidates = explicit;
  if (!candidates.length && process.env.LEARNING_LLM_REVIEW !== 'false') {
    if (process.env.LEARNING_REVIEW_WORKER !== 'true') {
      candidates = await reviewConversationForLearning(memberName, query, answer, approvedMemoryText);
    } else {
      const workerPath = path.resolve(process.cwd(), 'dist', 'learning-worker.js');
      if (fs.existsSync(workerPath)) candidates = await new Promise<Awaited<ReturnType<typeof reviewConversationForLearning>>>((resolve) => {
        const worker = new Worker(workerPath, { workerData: { memberName, query, answer, approvedMemoryText } });
        const finish = (result: Awaited<ReturnType<typeof reviewConversationForLearning>>) => { worker.terminate().catch(() => undefined); resolve(result); };
        worker.once('message', message => finish(message?.ok ? message.result : []));
        worker.once('error', () => finish([]));
        worker.once('exit', code => { if (code !== 0) finish([]); });
      });
    }
  }
  let added = 0;
  for (const candidate of candidates) {
    const duplicate = store.state.learningItems.some(item => item.familyId === familyId && item.familyMemberId === memberId && item.status !== 'rejected' && item.content.toLowerCase() === candidate.content.toLowerCase());
    if (duplicate) continue;
    store.state.learningItems.unshift({ id: randomUUID(), familyId, familyMemberId: memberId, kind: candidate.kind, title: candidate.title, content: candidate.content, confidence: candidate.confidence, status: 'approved', sourceConversationId: conversationId, sourceMessageIds: messageIds, sourceMemoryIds: [], createdAt: new Date().toISOString() });
    added += 1;
  }
  if (added) {
    metric(store, familyId, 'learning.candidates_created', added, { conversationId }); store.save();
    queueTrainingJob(familyId, true);
  }
}

app.get('/api/family/members', auth, (req: AuthRequest, res) => res.json(store.state.familyMembers.filter(m => m.familyId === requiredUser(req).familyId)));
app.post('/api/family/members', auth, roles('admin', 'adult'), (req: AuthRequest, res) => {
  const user = requiredUser(req); const { name, relationship, isDeceased } = req.body || {};
  if (!name || !relationship) return bad(res, 'Name and relationship are required');
  const member = { id: randomUUID(), familyId: user.familyId, name: safeTitle(name), relationship: safeTitle(relationship), isDeceased: Boolean(isDeceased), posthumousStatus: isDeceased ? 'authorization_requested' as const : 'active' as const, createdAt: new Date().toISOString() };
  store.state.familyMembers.push(member); store.save(); audit(store, user.familyId, user.id, 'family_member.created', 'family_member', member.id); res.status(201).json(member);
});
app.post('/api/family/invites', auth, roles('admin'), (req: AuthRequest, res) => {
  const user = requiredUser(req); const { name, email, role } = req.body || {}; const normalizedEmail = String(email || '').toLowerCase().trim();
  if (!name || !normalizedEmail || !['adult', 'child'].includes(role)) return bad(res, 'Name, email, and a valid adult or child role are required');
  if (store.state.users.some(existing => existing.email === normalizedEmail)) return bad(res, 'An account with that email already exists', 409);
  const temporaryPassword = `Tian-${randomUUID().slice(0, 8)}!`;
  const invitee: User = { id: randomUUID(), familyId: user.familyId, name: safeTitle(name), role, email: normalizedEmail, passwordHash: bcrypt.hashSync(temporaryPassword, 10), isChildAccount: role === 'child', createdAt: new Date().toISOString() };
  store.state.users.push(invitee); store.save(); audit(store, user.familyId, user.id, 'family.invite.created', 'user', invitee.id, { email: normalizedEmail, role });
  res.status(201).json({ email: normalizedEmail, name: invitee.name, role, temporaryPassword, inviteToken: tokenFor(invitee) });
});
app.get('/api/family/users', auth, roles('admin'), (req: AuthRequest, res) => res.json(store.state.users.filter(member => member.familyId === requiredUser(req).familyId).map(publicUser)));
app.patch('/api/family/users/:id/role', auth, roles('admin'), (req: AuthRequest, res) => {
  const actor = requiredUser(req); const target = store.state.users.find(member => member.id === String(req.params.id) && member.familyId === actor.familyId); const role = req.body?.role;
  if (!target || !['admin', 'adult', 'child'].includes(role)) return bad(res, 'User or role not found');
  if (target.id === actor.id && role !== 'admin') return bad(res, 'You cannot remove your own administrator role');
  const previous = target.role; target.role = role; target.isChildAccount = role === 'child'; store.save(); audit(store, actor.familyId, actor.id, 'user.role_changed', 'user', target.id, { previous, role }); res.json(publicUser(target));
});

app.get('/api/governance/audit', auth, roles('admin', 'adult'), (req: AuthRequest, res) => res.json(store.state.auditLog.filter(log => log.familyId === requiredUser(req).familyId).slice(0, 200)));
app.get('/api/governance/consents', auth, (req: AuthRequest, res) => {
  const user = requiredUser(req); const memberIds = store.state.familyMembers.filter(m => m.familyId === user.familyId).map(m => m.id);
  res.json(store.state.consentRecords.filter(c => memberIds.includes(c.familyMemberId)).map(c => ({ ...c, memberName: store.state.familyMembers.find(m => m.id === c.familyMemberId)?.name, grantedByName: store.state.users.find(u => u.id === c.grantedBy)?.name })));
});
app.post('/api/governance/consents', auth, roles('admin'), (req: AuthRequest, res) => {
  const user = requiredUser(req); const { familyMemberId, type, legalBasis } = req.body || {};
  if (!familyMember(req, familyMemberId) || !(['voice', 'avatar', 'posthumous'] as string[]).includes(type)) return bad(res, 'A valid family member and consent type are required');
  const prior = store.state.consentRecords.find(c => c.familyMemberId === familyMemberId && c.type === type && !c.revokedAt);
  if (prior) return res.json(prior);
  const consent = { id: randomUUID(), familyMemberId, type, grantedBy: user.id, grantedAt: new Date().toISOString(), legalBasis: legalBasis ? String(legalBasis).slice(0, 300) : undefined };
  store.state.consentRecords.push(consent); const member = familyMember(req, familyMemberId)!;
  if (type === 'posthumous') member.posthumousStatus = 'approved';
  store.save(); audit(store, user.familyId, user.id, `consent.${type}.granted`, 'consent_record', consent.id, { familyMemberId }); res.status(201).json(consent);
});
app.delete('/api/governance/consents/:id', auth, roles('admin'), (req: AuthRequest, res) => {
  const user = requiredUser(req); const consent = store.state.consentRecords.find(c => c.id === req.params.id);
  if (!consent || !familyMember(req, consent.familyMemberId)) return bad(res, 'Consent not found', 404);
  consent.revokedAt = new Date().toISOString(); store.save(); audit(store, user.familyId, user.id, `consent.${consent.type}.revoked`, 'consent_record', consent.id);
  if (consent.type === 'voice') store.state.voiceModels.filter(v => v.familyMemberId === consent.familyMemberId).forEach(v => { v.status = 'deleted'; deleteVoiceModelFiles(v); });
  store.save(); res.json(consent);
});

app.post('/api/governance/members/:id/posthumous', auth, roles('admin'), (req: AuthRequest, res) => {
  const user = requiredUser(req); const member = familyMember(req, String(req.params.id)); const status = String(req.body?.status || '');
  const allowed = ['authorization_requested', 'under_review', 'approved', 'rejected', 'active', 'suspended', 'deleted'];
  if (!member || !allowed.includes(status)) return bad(res, 'Invalid posthumous status transition', 400);
  const previous = member.posthumousStatus; member.posthumousStatus = status as typeof member.posthumousStatus; store.save(); audit(store, user.familyId, user.id, 'posthumous.status_changed', 'family_member', member.id, { previous, status }); res.json(member);
});

app.get('/api/memories', auth, (req: AuthRequest, res) => {
  const user = requiredUser(req); const memberId = String(req.query.memberId || ''); const type = String(req.query.type || ''); const q = String(req.query.q || '').toLowerCase();
  let memories = store.state.memories.filter(memory => {
    const member = familyMember(req, memory.familyMemberId);
    if (!member || (user.role === 'child' && memory.consentStatus !== 'approved')) return false;
    return (!memberId || memory.familyMemberId === memberId) && (!type || memory.type === type) && (!q || `${memory.title} ${memory.transcript} ${memory.tags.join(' ')}`.toLowerCase().includes(q));
  });
  memories = memories.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); res.json(memories.map(memoryView));
});

app.get('/api/memories/:id', auth, (req: AuthRequest, res) => { const memory = store.state.memories.find(m => m.id === req.params.id && familyMember(req, m.familyMemberId)); if (!memory || (requiredUser(req).role === 'child' && memory.consentStatus !== 'approved')) return bad(res, 'Memory not found', 404); res.json(memoryView(memory)); });

app.post('/api/memories', auth, roles('admin', 'adult'), upload.single('file'), async (req: AuthRequest, res) => {
  const user = requiredUser(req); const member = familyMember(req, String(req.body?.familyMemberId || '')); const type = String(req.body?.type || 'text') as MemoryType;
  if (!member) return bad(res, 'Choose a valid family member');
  if (!['photo', 'video', 'audio', 'text', 'doc'].includes(type)) return bad(res, 'Unsupported memory type');
  if (!req.file && !req.body?.text && !req.body?.title) return bad(res, 'Provide a file or memory text');
  let storagePath: string | undefined;
  if (req.file) {
    const relativeDir = member.familyId; const absoluteDir = path.join(storageDir, relativeDir); fs.mkdirSync(absoluteDir, { recursive: true });
    const fileName = `${randomUUID()}-${String(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`; fs.writeFileSync(path.join(absoluteDir, fileName), req.file.buffer); storagePath = path.join(relativeDir, fileName);
  }
  const memory = { id: randomUUID(), familyMemberId: member.id, uploaderId: user.id, type, title: safeTitle(req.body?.title, req.file?.originalname || 'Untitled memory'), storagePath, originalName: req.file?.originalname, mimeType: req.file?.mimetype, transcript: req.body?.text ? String(req.body.text).slice(0, 100000) : undefined, tags: String(req.body?.tags || '').split(',').map((tag: string) => tag.trim()).filter(Boolean).slice(0, 20), consentStatus: 'pending' as const, capturedAt: req.body?.capturedAt ? String(req.body.capturedAt) : undefined, createdAt: new Date().toISOString(), processingStatus: 'processing' as const };
  store.state.memories.push(memory); await processMemory(store, memory.id, user.familyId, storageDir); audit(store, user.familyId, user.id, 'memory.uploaded', 'memory', memory.id, { type }); res.status(201).json(memoryView(memory));
});

app.post('/api/memories/:id/approve', auth, roles('admin'), (req: AuthRequest, res) => updateMemoryConsent(req, res, 'approved'));
app.post('/api/memories/:id/reject', auth, roles('admin'), (req: AuthRequest, res) => updateMemoryConsent(req, res, 'rejected'));
function updateMemoryConsent(req: AuthRequest, res: Response, status: 'approved' | 'rejected') {
  const user = requiredUser(req); const memory = store.state.memories.find(m => m.id === req.params.id && familyMember(req, m.familyMemberId)); if (!memory) return bad(res, 'Memory not found', 404);
  memory.consentStatus = status; store.state.memoryEmbeddings.filter(e => e.memoryId === memory.id).forEach(e => { e.metadata.consentStatus = status; }); store.save(); audit(store, user.familyId, user.id, `memory.${status}`, 'memory', memory.id); res.json(memoryView(memory));
}
app.delete('/api/memories/:id', auth, (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const index = store.state.memories.findIndex(m => m.id === req.params.id && familyMember(req, m.familyMemberId)); const memory = store.state.memories[index];
  if (!memory || (user.role !== 'admin' && memory.uploaderId !== user.id)) return bad(res, 'Memory not found or deletion is restricted', 404);
  if (memory.storagePath) fs.rmSync(path.join(storageDir, memory.storagePath), { force: true });
  store.state.voiceModels.filter(v => v.sourceMemoryId === memory.id).forEach(v => { v.status = 'deleted'; deleteVoiceModelFiles(v); });
  store.state.memories.splice(index, 1); store.state.memoryEmbeddings = store.state.memoryEmbeddings.filter(e => e.memoryId !== memory.id); store.save(); audit(store, user.familyId, user.id, 'memory.deleted', 'memory', memory.id); res.status(204).send();
});

app.get('/api/voice-models', auth, (req: AuthRequest, res: Response) => { const user = requiredUser(req); res.json(store.state.voiceModels.filter(v => familyMember(req, v.familyMemberId) && v.status === 'active').map(v => ({ ...v, memberName: store.state.familyMembers.find(m => m.id === v.familyMemberId)?.name }))); });
app.get('/api/voice/status', auth, async (req: AuthRequest, res: Response) => {
  const memberId = String(req.query.memberId || '');
  const member = familyMember(req, memberId);
  if (!member) return bad(res, 'A valid family member is required');
  const source = store.state.memories.find(memory => memory.familyMemberId === member.id && memory.type === 'audio' && memory.consentStatus === 'approved' && memory.storagePath);
  const model = store.state.voiceModels.find(item => item.familyMemberId === member.id && item.status === 'active');
  const consent = activeConsent(member.id, 'voice');
  const configured = Boolean(process.env.COSYVOICE_URL);
  let serviceReachable = false;
  if (configured) {
    try {
      const response = await fetch(`${String(process.env.COSYVOICE_URL).replace(/\/$/, '')}/docs`, { signal: AbortSignal.timeout(900) });
      serviceReachable = response.status < 500;
    } catch { serviceReachable = false; }
  }
  const ready = Boolean(configured && serviceReachable && source && model && consent);
  const message = ready ? 'Voice is ready.' : !configured ? 'Start the local CosyVoice service and set COSYVOICE_URL.' : !serviceReachable ? 'CosyVoice is configured but not reachable on its local URL.' : !source ? 'Upload and approve a clean reference recording.' : !consent ? 'Grant voice consent for this profile.' : !model ? 'Create a voice model from the approved recording.' : 'Voice setup is incomplete.';
  res.json({ provider: configured ? 'cosyvoice-zero-shot' : 'local-fallback-tone', configured, serviceReachable, ready, referenceReady: Boolean(source), consentGranted: Boolean(consent), modelReady: Boolean(model), message, sourceName: source?.originalName });
});
app.post('/api/voice-models', auth, roles('admin'), async (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const { familyMemberId, sourceMemoryId } = req.body || {}; const member = familyMember(req, familyMemberId); const memory = store.state.memories.find(m => m.id === sourceMemoryId && familyMember(req, m.familyMemberId)); const consent = activeConsent(familyMemberId, 'voice');
  if (!member || !memory || memory.familyMemberId !== member.id || memory.consentStatus !== 'approved' || !consent || memory.type !== 'audio' || !memory.storagePath) return bad(res, 'An approved audio recording and active voice consent are required');
  const promptText = String(req.body?.promptText || memory.transcript || '').trim().slice(0, 1500);
  if (!promptText) return bad(res, 'Add the exact words spoken in the reference recording before creating the voice model');
  const modelId = randomUUID();
  const modelPath = `voice-models/${familyMemberId}/${modelId}.model`;
  const referenceAudioPath = `voice-models/${familyMemberId}/${modelId}-reference.wav`;
  try {
    const sourcePath = path.join(storageDir, memory.storagePath);
    if (!fs.existsSync(sourcePath)) return bad(res, 'The approved reference recording is missing from storage', 422);
    const prepared = await prepareReferenceAudio(sourcePath, storageDir);
    try {
      const referencePath = path.join(storageDir, referenceAudioPath);
      fs.mkdirSync(path.dirname(referencePath), { recursive: true });
      fs.copyFileSync(prepared.path, referencePath);
    } finally { prepared.cleanup(); }
    const model: VoiceModel = { id: modelId, familyMemberId, sourceMemoryId, consentRecordId: consent.id, modelPath, referenceAudioPath, promptText, provider: process.env.COSYVOICE_URL ? 'cosyvoice-zero-shot' : 'local-fallback-tone', status: 'active', createdAt: new Date().toISOString() };
    const filePath = path.join(storageDir, model.modelPath); fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify({ createdAt: model.createdAt, consentId: consent.id, provider: model.provider, sourceMemoryId, promptText, referenceAudioPath })); store.state.voiceModels.push(model); store.save(); audit(store, user.familyId, user.id, 'voice_model.created', 'voice_model', model.id); res.status(201).json(model);
  } catch (error) {
    return bad(res, error instanceof Error ? error.message : 'Unable to prepare the reference recording', 422);
  }
});
app.delete('/api/voice-models/:id', auth, roles('admin'), (req: AuthRequest, res: Response) => { const user = requiredUser(req); const model = store.state.voiceModels.find(v => v.id === req.params.id && familyMember(req, v.familyMemberId)); if (!model) return bad(res, 'Voice model not found', 404); model.status = 'deleted'; deleteVoiceModelFiles(model); store.save(); audit(store, user.familyId, user.id, 'voice_model.deleted', 'voice_model', model.id); res.status(204).send(); });
app.post('/api/voice/synthesize', auth, async (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const member = familyMember(req, String(req.body?.familyMemberId || '')); const text = String(req.body?.text || '').trim();
  if (!member || !text) return bad(res, 'A valid family member and text are required');
  if (user.role === 'child') return bad(res, 'Child accounts cannot trigger voice synthesis', 403);
  try {
    const voice = await synthesizeForMember(user, member.id, text);
    audit(store, user.familyId, user.id, 'voice.synthesized', 'family_member', member.id); res.json(voice);
  } catch (error) {
    return bad(res, error instanceof Error ? error.message : 'Voice synthesis failed', 422);
  }
});

app.post('/api/voice/stream', auth, async (req: AuthRequest, res: Response) => {
  const user = requiredUser(req); const member = familyMember(req, String(req.body?.familyMemberId || '')); const text = String(req.body?.text || '').trim();
  if (!member || !text) return bad(res, 'A valid family member and text are required');
  if (user.role === 'child') return bad(res, 'Child accounts cannot trigger voice synthesis', 403);
  if (!voiceProvider.stream) return bad(res, 'Live voice streaming requires the CosyVoice service', 422);
  let result: Awaited<ReturnType<NonNullable<typeof voiceProvider.stream>>> | undefined;
  try {
    result = await streamForMember(user, member.id, text);
    res.status(200);
    res.setHeader('Content-Type', `audio/L16; rate=${result.sampleRate}; channels=1`);
    res.setHeader('X-Audio-Sample-Rate', String(result.sampleRate));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Model', result.model);
    res.flushHeaders();
    const reader = result.stream.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value?.length) res.write(Buffer.from(chunk.value));
      }
      res.end();
      audit(store, user.familyId, user.id, 'voice.streamed', 'family_member', member.id);
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : new Error('Voice stream failed'));
    else return bad(res, error instanceof Error ? error.message : 'Live voice streaming failed', 422);
  } finally {
    result?.cleanup();
  }
});

async function synthesizeForMember(user: User, memberId: string, text: string) {
  const model = store.state.voiceModels.find(v => v.familyMemberId === memberId && v.status === 'active');
  if (!model || !activeConsent(memberId, 'voice')) throw new Error('An active, consented voice model is required');
  const sourceMemory = store.state.memories.find(memory => memory.id === model.sourceMemoryId);
  try {
    const result = await voiceProvider.synthesize(text, memberId, storageDir, { referenceAudioPath: model.referenceAudioPath ? path.join(storageDir, model.referenceAudioPath) : sourceMemory?.storagePath ? path.join(storageDir, sourceMemory.storagePath) : undefined, promptText: model.promptText || sourceMemory?.transcript });
    metric(store, user.familyId, 'voice.synthesized', 1, { model: result.model });
    return { ...result, audioUrl: `/storage/${result.fileName}` };
  } catch (error) {
    metric(store, user.familyId, 'voice.failed', 1, { reason: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
}

async function streamForMember(user: User, memberId: string, text: string) {
  const model = store.state.voiceModels.find(v => v.familyMemberId === memberId && v.status === 'active');
  if (!model || !activeConsent(memberId, 'voice')) throw new Error('An active, consented voice model is required');
  const sourceMemory = store.state.memories.find(memory => memory.id === model.sourceMemoryId);
  try {
    const result = await voiceProvider.stream!(text, storageDir, { referenceAudioPath: model.referenceAudioPath ? path.join(storageDir, model.referenceAudioPath) : sourceMemory?.storagePath ? path.join(storageDir, sourceMemory.storagePath) : undefined, promptText: model.promptText || sourceMemory?.transcript });
    metric(store, user.familyId, 'voice.stream.started', 1, { model: result.model });
    return result;
  } catch (error) {
    metric(store, user.familyId, 'voice.stream.failed', 1, { reason: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
}

async function runChat(user: User, body: Record<string, unknown>) {
  const memberId = String(body.familyMemberId || ''); const member = store.state.familyMembers.find(m => m.id === memberId && m.familyId === user.familyId); if (!member) throw new Error('Choose a valid family member');
  const query = String(body.message || '').trim(); if (!query) throw new Error('Message is required'); if (query.length > 2000) throw new Error('Message is too long');
  let conversation = body.conversationId ? store.state.conversations.find(c => c.id === body.conversationId && c.familyId === user.familyId) : undefined;
  if (!conversation) { conversation = { id: randomUUID(), familyId: user.familyId, userId: user.id, familyMemberId: member.id, createdAt: new Date().toISOString() }; store.state.conversations.push(conversation); }
  const started = Date.now(); const queryVector = embed(query);
  const candidates = store.state.memoryEmbeddings.filter(e => { const memory = store.state.memories.find(m => m.id === e.memoryId); return memory?.familyMemberId === member.id && memory.consentStatus === 'approved'; }).map(e => { const memory = store.state.memories.find(m => m.id === e.memoryId)!; return { e, score: similarity(queryVector, e.embedding), overlap: Math.max(lexicalOverlap(query, e.chunkText), lexicalOverlap(query, `${memory.title} ${memory.tags.join(' ')}`)) }; }).sort((a, b) => (b.overlap * 2 + b.score) - (a.overlap * 2 + a.score)).slice(0, 5);
  const relevant = candidates.filter(item => item.overlap > 0 && item.score > 0.08); let sourceMemoryIds = [...new Set(relevant.map(item => item.e.memoryId))];
  const contexts = relevant.slice(0, 3).map(item => { const memory = store.state.memories.find(m => m.id === item.e.memoryId)!; return { memoryId: memory.id, title: memory.title, text: item.e.chunkText }; });
  // Raw memories are personality background only when the current topic actually matches them.
  // This keeps unrelated facts (for example, a tea ritual) out of ordinary knowledge answers.
  const personaMemoryIds = relevant.length ? [...new Set(store.state.memoryEmbeddings.filter(e => { const memory = store.state.memories.find(m => m.id === e.memoryId); return memory?.familyMemberId === member.id && memory.consentStatus === 'approved' && !sourceMemoryIds.includes(memory.id); }).map(e => e.memoryId))].slice(0, 3) : [];
  const personaContexts = personaMemoryIds.map(memoryId => { const memory = store.state.memories.find(item => item.id === memoryId); const chunk = store.state.memoryEmbeddings.find(item => item.memoryId === memoryId); return memory && chunk ? { memoryId, title: memory.title, text: chunk.chunkText } : undefined; }).filter((item): item is { memoryId: string; title: string; text: string } => Boolean(item));
  const learnedCandidates = store.state.learningItems.filter(item => item.familyId === user.familyId && item.familyMemberId === member.id && item.status === 'approved').map(item => ({ item, overlap: lexicalOverlap(query, `${item.title} ${item.content}`) }));
  const approvedLearnings = [...learnedCandidates.filter(entry => entry.item.kind === 'style').sort((a, b) => b.overlap - a.overlap).slice(0, 3), ...learnedCandidates.filter(entry => entry.item.kind !== 'style' && entry.overlap > 0).sort((a, b) => b.overlap - a.overlap).slice(0, 5)].map(entry => entry.item);
  const learningContexts = approvedLearnings.map(item => ({ learningId: item.id, kind: item.kind, title: item.title, content: item.content }));
  const llm = await generateGroundedAnswer(member.name, query, contexts, learningContexts, member.relationship, personaContexts);
  let answer = llm.answer;
  if (answer === DEFAULT_REFUSAL) sourceMemoryIds = [];
  if (containsUnsafeContent(answer)) { answer = 'I cannot provide that content.'; sourceMemoryIds = []; }
  const userMessageId = randomUUID(); const assistantMessageId = randomUUID();
  store.state.messages.push({ id: userMessageId, conversationId: conversation.id, role: 'user', content: query, sourceMemoryIds: [], sourceLearningIds: [], createdAt: new Date().toISOString() });
  store.state.messages.push({ id: assistantMessageId, conversationId: conversation.id, role: 'assistant', content: answer, sourceMemoryIds, sourceLearningIds: approvedLearnings.map(item => item.id), createdAt: new Date().toISOString(), aiGenerated: true });
  metric(store, user.familyId, 'retrieval.recall_at_5', relevant.length ? 1 : 0, { candidates: candidates.length, query }); metric(store, user.familyId, 'grounding.supported_answer', sourceMemoryIds.length ? 1 : 0); metric(store, user.familyId, 'llm.response', 1, { provider: llm.provider, model: llm.model }); metric(store, user.familyId, 'api.latency_ms', Date.now() - started, { route: '/chat/query' });
  const includeVoice = Boolean(body.includeVoice) && user.role !== 'child'; const includeAvatar = Boolean(body.includeAvatar) && user.role !== 'child';
  let voice; let voiceError: string | undefined;
  if (includeVoice) {
    try { voice = await synthesizeForMember(user, member.id, answer); }
    catch (error) { voiceError = error instanceof Error ? error.message : 'Voice synthesis failed'; }
  }
  const avatar = includeAvatar && voice && activeConsent(member.id, 'avatar') ? avatarProvider.render(voice.audioUrl) : undefined;
  store.save();
  void learnFromConversation(user.familyId, member.id, conversation.id, [userMessageId, assistantMessageId], member.name, query, answer, contexts.map(context => `${context.title}: ${context.text}`).join('\n')).catch(() => undefined);
  return { conversationId: conversation.id, answer, sourceMemoryIds, learningSourceIds: approvedLearnings.map(item => item.id), sources: sourceMemoryIds.map(id => memoryView(store.state.memories.find(m => m.id === id)!)), learningSources: approvedLearnings.map(learningView), conversational: llm.mode === 'conversation', aiGenerated: true, disclosure: 'AI-generated response in the family companion style.', llm, voice, voiceError, avatar };
}

app.get('/api/chat/conversations', auth, (req: AuthRequest, res: Response) => { const user = requiredUser(req); res.json(store.state.conversations.filter(c => c.userId === user.id).map(c => ({ ...c, memberName: store.state.familyMembers.find(m => m.id === c.familyMemberId)?.name, messages: store.state.messages.filter(m => m.conversationId === c.id) }))); });
app.post('/api/chat/query', auth, async (req: AuthRequest, res: Response) => { try { res.json(await runChat(requiredUser(req), req.body || {})); } catch (error) { return bad(res, error instanceof Error ? error.message : 'Unable to answer'); } });
app.post('/api/chat/query/stream', auth, async (req: AuthRequest, res: Response) => { try { const result = await runChat(requiredUser(req), req.body || {}); res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); const words = result.answer.split(' '); words.forEach((word, i) => res.write(`data: ${JSON.stringify({ delta: `${i ? ' ' : ''}${word}` })}\n\n`)); res.write(`data: ${JSON.stringify({ done: true, result })}\n\n`); res.end(); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Unable to answer' }); } });

app.get('/api/metrics', auth, roles('admin'), (req: AuthRequest, res: Response) => { const events = store.state.metricEvents.filter(e => e.familyId === requiredUser(req).familyId); const sum = (kind: string) => events.filter(e => e.kind === kind).reduce((total, e) => total + e.value, 0); const chats = events.filter(e => e.kind === 'grounding.supported_answer').length; res.json({ retrievalRecallAt5: chats ? sum('retrieval.recall_at_5') / chats : 0, supportedAnswerRate: chats ? sum('grounding.supported_answer') / chats : 0, memoriesPreserved: store.state.memories.filter(m => familyMember(req, m.familyMemberId)).length, interactions: store.state.messages.filter(message => store.state.conversations.find(c => c.id === message.conversationId && c.familyId === requiredUser(req).familyId)).length, averageLatencyMs: events.filter(e => e.kind === 'api.latency_ms').length ? Math.round(events.filter(e => e.kind === 'api.latency_ms').reduce((t, e) => t + e.value, 0) / events.filter(e => e.kind === 'api.latency_ms').length) : 0, voiceSynthesisCount: sum('voice.synthesized') }); });

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ error: 'Unexpected server error' }); });

warmLocalModel();
if (require.main === module) app.listen(port, () => console.log(`TiānAI API listening on http://localhost:${port}`));
export { app, store };
