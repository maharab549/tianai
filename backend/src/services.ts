import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DataStore, embed, metric } from './store';
import { Memory } from './types';
import { AvatarResult, VoiceResult } from './service-types';

export interface VoiceSynthesisOptions { referenceAudioPath?: string; promptText?: string; }
export interface VoiceStreamResult { stream: ReadableStream<Uint8Array>; sampleRate: number; model: string; cleanup: () => void; }
export interface VoiceProvider {
  synthesize(text: string, familyMemberId: string, outputDir: string, options?: VoiceSynthesisOptions): Promise<VoiceResult>;
  stream?(text: string, outputDir: string, options?: VoiceSynthesisOptions): Promise<VoiceStreamResult>;
  delete(modelPath: string): void;
}
export interface AvatarProvider { render(audioUrl: string, referencePhoto?: string): AvatarResult; }

function wavFile(data: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    child.stderr.on('data', chunk => { errorOutput = `${errorOutput}${chunk.toString()}`.slice(-2000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(errorOutput.trim() || `${command} exited with code ${code}`)));
  });
}

export async function prepareReferenceAudio(inputPath: string, outputDir: string): Promise<{ path: string; cleanup: () => void }> {
  const normalizedPath = path.join(outputDir, `.reference-${randomUUID()}.wav`);
  const ffmpeg = process.env.AUDIO_FFMPEG_BIN || 'ffmpeg';
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    await runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', normalizedPath]);
    if (fs.statSync(normalizedPath).size > 44) return { path: normalizedPath, cleanup: () => fs.rmSync(normalizedPath, { force: true }) };
    fs.rmSync(normalizedPath, { force: true });
  } catch (error) {
    fs.rmSync(normalizedPath, { force: true });
    if (path.extname(inputPath).toLowerCase() !== '.wav') {
      throw new Error('Reference audio needs ffmpeg normalization. Install ffmpeg or upload a WAV recording.');
    }
  }
  return { path: inputPath, cleanup: () => undefined };
}

export class LocalVoiceProvider implements VoiceProvider {
  async synthesize(text: string, familyMemberId: string, outputDir: string): Promise<VoiceResult> {
    fs.mkdirSync(outputDir, { recursive: true });
    const fileName = `voice-${familyMemberId}-${randomUUID()}.wav`;
    const sampleRate = 16000;
    const duration = Math.min(4, Math.max(1, text.length / 28));
    const samples = Math.floor(sampleRate * duration);
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const envelope = Math.min(1, i / 500) * Math.min(1, (samples - i) / 3000);
      data.writeInt16LE(Math.round(Math.sin(i / 9) * 1800 * envelope), i * 2);
    }
    fs.writeFileSync(path.join(outputDir, fileName), wavFile(data, sampleRate));
    return { fileName, model: 'local-fallback-tone', aiGenerated: true, disclosure: 'Local fallback audio; configure CosyVoice for a consented cloned voice.' };
  }
  delete(modelPath: string) { if (fs.existsSync(modelPath)) fs.rmSync(modelPath, { force: true }); }
}

export class CosyVoiceProvider implements VoiceProvider {
  constructor(private readonly endpoint = (process.env.COSYVOICE_URL || '').replace(/\/$/, ''), private readonly sampleRate = Number(process.env.VOICE_SAMPLE_RATE || 22050)) {}

  private async request(text: string, outputDir: string, options: VoiceSynthesisOptions = {}): Promise<{ response: Response; cleanup: () => void }> {
    if (!this.endpoint) throw new Error('COSYVOICE_URL is not configured');
    if (!options.referenceAudioPath || !fs.existsSync(options.referenceAudioPath)) throw new Error('An approved reference recording is required for voice synthesis');
    const reference = await prepareReferenceAudio(options.referenceAudioPath, outputDir);
    try {
      const form = new FormData();
      form.append('tts_text', text.slice(0, 4000));
      form.append('prompt_text', (options.promptText || '').trim().slice(0, 1500));
      form.append('prompt_wav', new Blob([fs.readFileSync(reference.path)], { type: 'audio/wav' }), 'prompt.wav');
      const response = await fetch(`${this.endpoint}/inference_zero_shot`, { method: 'POST', body: form });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        const detail = (await response.text()).trim().slice(0, 300);
        throw new Error(`CosyVoice returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      if (contentType.includes('application/json')) {
        const payload = await response.json() as { error?: string; message?: string };
        throw new Error(payload.error || payload.message || 'CosyVoice returned no audio');
      }
      if (!response.body) throw new Error('CosyVoice returned an empty audio stream');
      return { response, cleanup: reference.cleanup };
    } catch (error) {
      reference.cleanup();
      throw error;
    }
  }

  async synthesize(text: string, familyMemberId: string, outputDir: string, options: VoiceSynthesisOptions = {}): Promise<VoiceResult> {
    const request = await this.request(text, outputDir, options);
    try {
      const bytes = Buffer.from(await request.response.arrayBuffer());
      if (!bytes.length) throw new Error('CosyVoice returned an empty audio response');
      fs.mkdirSync(outputDir, { recursive: true });
      const fileName = `voice-${familyMemberId}-${randomUUID()}.wav`;
      const audio = bytes.subarray(0, 4).toString() === 'RIFF' ? bytes : wavFile(bytes, this.sampleRate);
      fs.writeFileSync(path.join(outputDir, fileName), audio);
      return { fileName, model: 'cosyvoice-zero-shot', aiGenerated: true, disclosure: 'AI-generated voice response using the approved reference recording.' };
    } finally {
      request.cleanup();
    }
  }

  async stream(text: string, outputDir: string, options: VoiceSynthesisOptions = {}): Promise<VoiceStreamResult> {
    const request = await this.request(text, outputDir, options);
    return { stream: request.response.body!, sampleRate: this.sampleRate, model: 'cosyvoice-zero-shot-stream', cleanup: request.cleanup };
  }

  delete(modelPath: string) { if (fs.existsSync(modelPath)) fs.rmSync(modelPath, { force: true }); }
}

export function createVoiceProvider(): VoiceProvider {
  return process.env.COSYVOICE_URL ? new CosyVoiceProvider() : new LocalVoiceProvider();
}

export class LocalAvatarProvider implements AvatarProvider {
  render(audioUrl: string, referencePhoto?: string): AvatarResult {
    return { provider: 'local-2d-talking-head', audioUrl, referencePhoto, aiGenerated: true, disclosure: 'AI-generated avatar response' };
  }
}

function readOptionalModule(name: string): any | undefined {
  try { return require(name); } catch { return undefined; }
}

async function processExternalFile(memory: Memory, filePath: string): Promise<string> {
  const endpoint = (process.env.DOCUMENT_PROCESSOR_URL || '').replace(/\/$/, '');
  if (!endpoint) return '';
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), memory.originalName || path.basename(filePath));
  form.append('memoryType', memory.type);
  const response = await fetch(`${endpoint}/extract`, { method: 'POST', body: form });
  if (!response.ok) return '';
  const payload = await response.json() as { text?: string };
  return String(payload.text || '').trim();
}

async function extractText(memory: Memory, storageDir: string): Promise<string> {
  if (memory.transcript?.trim()) return memory.transcript.trim();
  if (!memory.storagePath) return '';
  const filePath = path.join(storageDir, memory.storagePath);
  if (!fs.existsSync(filePath)) return '';
  const external = await processExternalFile(memory, filePath).catch(() => '');
  if (external) return external;
  const extension = path.extname(memory.originalName || filePath).toLowerCase();
  if (['.txt', '.md', '.markdown', '.csv', '.json', '.xml', '.html', '.htm', '.rtf'].includes(extension) || memory.type === 'text') return fs.readFileSync(filePath, 'utf8').trim();
  if (extension === '.docx') {
    const mammoth = readOptionalModule('mammoth');
    if (!mammoth) return '';
    const result = await mammoth.extractRawText({ buffer: fs.readFileSync(filePath) });
    return String(result.value || '').trim();
  }
  if (extension === '.pdf') {
    const pdfPackage = readOptionalModule('pdf-parse');
    if (!pdfPackage) return '';
    const parser = pdfPackage.default || pdfPackage;
    const result = await parser(fs.readFileSync(filePath));
    return String(result.text || '').trim();
  }
  return '';
}

export async function processMemory(store: DataStore, memoryId: string, familyId: string, storageDir = process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage')) {
  const memory = store.state.memories.find(m => m.id === memoryId);
  if (!memory) return;
  memory.processingStatus = 'processing';
  const text = await extractText(memory, storageDir).catch(() => '');
  store.state.memoryEmbeddings = store.state.memoryEmbeddings.filter(e => e.memoryId !== memoryId);
  if (!text) {
    memory.processingStatus = 'needs_processor';
    memory.processedAt = new Date().toISOString();
    metric(store, familyId, 'memory.awaiting_processor', 1, { memoryId, type: memory.type });
    store.save();
    return;
  }
  memory.transcript = text.slice(0, 200000);
  memory.processingStatus = 'processed';
  memory.processedAt = new Date().toISOString();
  for (const chunk of chunkText(memory.transcript)) {
    store.state.memoryEmbeddings.push({ id: randomUUID(), memoryId, chunkText: chunk, embedding: embed(chunk), metadata: { familyMemberId: memory.familyMemberId, sourceType: memory.type, sourceId: memoryId, consentStatus: memory.consentStatus } });
  }
  metric(store, familyId, 'memory.processed', 1, { memoryId, processor: memory.type === 'audio' || memory.type === 'video' ? 'external-asr-or-transcript' : memory.type === 'photo' ? 'external-ocr-or-caption' : 'local-document-parser' });
  store.save();
}

export function chunkText(text: string): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 80) chunks.push(words.slice(i, i + 80).join(' '));
  return chunks;
}
