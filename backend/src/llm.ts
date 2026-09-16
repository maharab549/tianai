import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const DEFAULT_REFUSAL = 'I do not have an approved memory about this.';
const MODEL_DIR = path.resolve(process.env.LOCAL_LLM_MODEL_DIR || path.join(process.cwd(), 'models'));
const DEFAULT_MODEL_FILE = 'Qwen3-4B-Q4_K_M.gguf';
const DEFAULT_MODEL_URL = 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf?download=true';
const modelFile = process.env.LOCAL_LLM_MODEL_FILE || DEFAULT_MODEL_FILE;
const modelUrl = process.env.LOCAL_LLM_MODEL_URL || DEFAULT_MODEL_URL;
const modelPath = path.join(MODEL_DIR, modelFile);
const contextSize = Number(process.env.LOCAL_LLM_CONTEXT_SIZE || 8192);
const maxTokens = Number(process.env.LOCAL_LLM_MAX_TOKENS || 500);

export interface GroundingContext { memoryId: string; title: string; text: string; }
export interface LearningContext { learningId: string; kind: string; title: string; content: string; }
export interface LearningCandidate { kind: 'fact' | 'style' | 'boundary' | 'skill'; title: string; content: string; confidence: number; }
export interface ConversationTurn { role: 'user' | 'assistant'; content: string; }
export interface MemorialProfileContext {
  biography?: string;
  voiceStyle?: string;
  values?: string;
  relationshipNotes?: string;
  signaturePhrases?: string[];
  favoriteTopics?: string[];
  sensitiveTopics?: string[];
  responseGuidance?: string;
}
export interface LlmStreamOptions {
  onToken?: (chunk: string) => void;
  maxTokens?: number;
  conversationHistory?: ConversationTurn[];
  memorialProfile?: MemorialProfileContext;
}
export interface LlmAnswer { answer: string; model: string; provider: 'local-llama' | 'fallback'; mode?: 'grounded' | 'conversation' | 'fallback'; }
export interface LocalLlmStatus { provider: 'local-llama'; ready: boolean; downloading: boolean; downloaded: boolean; model: string; modelPath: string; progress: number; loraPath?: string; error?: string; }

let downloadPromise: Promise<string> | undefined;
let loadPromise: Promise<any> | undefined;
let runtimeModel: any;
let runtimeLlama: any;
let runtimeError = '';
let downloadProgress = 0;
let activeLoraPath = process.env.LOCAL_LLM_LORA_PATH || '';
const importNodeLlama = new Function('modulePath', 'return import(modulePath)') as (modulePath: string) => Promise<any>;

function fallbackAnswer(memberName: string, query: string): LlmAnswer {
  if (isSocialGreeting(query)) {
    return { answer: 'Hello. I am here with you. What would you like to talk about?', model: 'conversation-fallback', provider: 'fallback', mode: 'conversation' };
  }
  if (isEmotionalConversation(query)) {
    return { answer: `I hear how much you care, ${memberName}. Tell me what you are remembering, and we can stay with it together.`, model: 'conversation-fallback', provider: 'fallback', mode: 'conversation' };
  }
  if (/\b(make|brew|pour|prepare)\b[\s\S]*\btea\b|\btea\b[\s\S]*\b(make|brew|pour|prepare)\b/i.test(query)) {
    return { answer: 'That sounds lovely. I would enjoy a cup of tea. What kind are you making?', model: 'conversation-fallback', provider: 'fallback', mode: 'conversation' };
  }
  return { answer: `I am here with you, ${memberName}. Tell me a little more about what you would like to talk about.`, model: 'conversation-fallback', provider: 'fallback', mode: 'conversation' };
}

function isSocialGreeting(query: string) {
  return /^(hi|hello|hey|hiya|good morning|good afternoon|good evening)(?:\s+there)?[!.?\s]*$/i.test(query.trim());
}

function conversationalGreeting(): LlmAnswer {
  return { answer: 'Hello. I am here with you. What would you like to talk about?', model: 'safe-conversation', provider: 'fallback', mode: 'conversation' };
}

function isEmotionalConversation(query: string) {
  const normalized = query.trim().toLowerCase();
  return /\b(i|we)\s+(really\s+)?miss(?:es|ing)?\b/.test(normalized)
    || /\b(miss(?:es|ing)? you|love you|wish you were here|thinking of you|thinking about you)\b/.test(normalized)
    || /\b(i am|i'm|im)\s+(sad|lonely|heartbroken|hurting|grieving|crying)\b/.test(normalized)
    || /\b(i need you|are you there|can you stay with me)\b/.test(normalized);
}

function cleanAnswer(value: unknown): string {
  return String(value || '')
    .replace(/^\s*(assistant|answer)\s*:\s*/i, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/(^|\n)\s*\*[^*\n]{1,180}\*\s*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/\\+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 5000);
}

function exposesInternalMemory(answer: string) {
  return /\[(?:memory|learned)[^\]]*\]|(?:approved )?memories?\s+(?:say|show)|from the (?:approved )?memory|according to (?:the )?(?:approved )?memory/i.test(answer);
}

function exposesMissingFactDisclaimer(answer: string) {
  return /\b(?:i(?:'m| am) not sure|i (?:don't|do not) know|i (?:don't|do not) have (?:that|the) (?:detail|information)|not in (?:my|the) memory|i can(?:not|'t) answer)\b/i.test(answer);
}

function isTestRuntime() {
  return process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.some(argument => argument === '--test' || argument.endsWith('/node_modules/node:test') || /[\\/]tests?[\\/].*\.test\.[cm]?[jt]sx?$/.test(argument));
}

function isUsableAnswer(answer: string) {
  return Boolean(answer) && answer !== DEFAULT_REFUSAL && answer.length >= 3;
}

function exposesUnsupportedPersonalAnecdote(answer: string) {
  return /\bI\s+(?:remember|used to|was taught|heard about|saw|watched|visited|lived|grew|always found|have always found|once made|once brewed)\b|\bmy\s+(?:garden|school|childhood|old house|family recipe|morning routine)\b/i.test(answer);
}

function debugLlm(message: string) {
  if (process.env.LOCAL_LLM_DEBUG === 'true') console.error(`[llm] ${message}`);
}

async function rewriteLeakedAnswer(identity: string, query: string, draft: string, hasPersonalFacts = true) {
  try {
    const result = await promptLocalModel([
      `You are ${identity}, answering a family member in a natural spoken conversation.`,
      'Rewrite the draft so it sounds like the person speaking directly, while preserving every supported detail and the emotional meaning.',
      'The draft may contain internal source wording. Remove all references to memory, retrieval, context, approval, grounding, prompts, models, or uncertainty.',
      'Use first person for the represented person and keep other people as the correct third-person relatives.',
      ...(hasPersonalFacts ? [] : ['There is no personal background for this question. Keep the factual answer, remove every invented personal anecdote, and do not use phrases such as “I remember”, “I used to”, “my school”, or “my garden”.']),
      'Do not add facts that are not in the draft. Do not use stage directions, roleplay, asterisks, labels, or explanations. Output only the words to speak in two to five natural sentences.',
    ].join(' '), `Question: ${query}\nDraft answer: ${draft}`, { maxTokens: 320, temperature: 0.1 });
    const answer = cleanAnswer(result.text);
    if (isUsableAnswer(answer) && !exposesInternalMemory(answer) && !exposesMissingFactDisclaimer(answer) && (hasPersonalFacts || !exposesUnsupportedPersonalAnecdote(answer))) {
      return { answer, model: result.model };
    }
  } catch {
    // The original answer remains available as a last-resort failure path.
  }
  return undefined;
}

async function downloadModel(): Promise<string> {
  await fsp.mkdir(MODEL_DIR, { recursive: true });
  if (process.env.LOCAL_LLM_AUTO_DOWNLOAD === 'false') {
    try {
      const stat = await fsp.stat(modelPath);
      if (stat.size > 100 * 1024 * 1024) { downloadProgress = 1; return modelPath; }
    } catch { /* local model is not installed */ }
    throw new Error(`Local model is not installed at ${modelPath}`);
  }
  try {
    const stat = await fsp.stat(modelPath);
    if (stat.size > 100 * 1024 * 1024) { downloadProgress = 1; return modelPath; }
  } catch { /* model has not been downloaded */ }
  const partialPath = `${modelPath}.part`;
  try {
    const response = await fetch(modelUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Model download failed with HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    downloadProgress = 0;
    const progressStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { received += chunk.byteLength; downloadProgress = total ? received / total : 0; controller.enqueue(chunk); },
    });
    const stream = (response.body as any).pipeThrough(progressStream);
    await pipeline(Readable.fromWeb(stream as any), fs.createWriteStream(partialPath));
  } catch (error) {
    if (process.platform === 'win32') {
      await downloadWithPowerShell(partialPath).catch(async () => downloadWithCurl(partialPath).catch(() => { throw error; }));
    } else {
      await downloadWithCurl(partialPath).catch(() => { throw error; });
    }
  }
  const stat = await fsp.stat(partialPath);
  if (stat.size < 100 * 1024 * 1024) throw new Error('Downloaded model is unexpectedly small');
  await fsp.rename(partialPath, modelPath);
  downloadProgress = 1;
  return modelPath;
}

function downloadWithCurl(partialPath: string): Promise<void> {
  const command = process.env.LOCAL_LLM_CURL_BIN || (process.platform === 'win32' ? 'curl.exe' : 'curl');
  downloadProgress = -1;
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-L', '--fail', '--retry', '3', '--connect-timeout', '20', '--output', partialPath, modelUrl], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Model download command exited with code ${code}`)));
  });
}

function downloadWithPowerShell(partialPath: string): Promise<void> {
  const command = process.env.LOCAL_LLM_POWERSHELL_BIN || 'powershell.exe';
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$client = [System.Net.Http.HttpClient]::new()",
    `$response = $client.GetAsync(${quote(modelUrl)}, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()`,
    '$response.EnsureSuccessStatusCode()',
    '$inputStream = $response.Content.ReadAsStream()',
    `$outputStream = [System.IO.File]::Create(${quote(partialPath)})`,
    'try { $inputStream.CopyToAsync($outputStream).GetAwaiter().GetResult() } finally { $outputStream.Dispose(); $inputStream.Dispose(); $response.Dispose(); $client.Dispose() }',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  downloadProgress = -1;
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`PowerShell model download exited with code ${code}`)));
  });
}

export async function ensureLocalModel(): Promise<string> {
  if (!downloadPromise) {
    downloadPromise = downloadModel().catch(error => { runtimeError = error instanceof Error ? error.message : 'Model download failed'; downloadPromise = undefined; throw error; });
  }
  return downloadPromise;
}

async function loadLocalModel(): Promise<any> {
  if (runtimeModel) return runtimeModel;
  if (!loadPromise) {
    loadPromise = (async () => {
      const localPath = await ensureLocalModel();
      const runtime = await importNodeLlama('node-llama-cpp');
      runtimeLlama = await runtime.getLlama({ gpu: process.env.LOCAL_LLM_GPU === 'false' ? false : 'auto' });
      runtimeModel = await runtimeLlama.loadModel({ modelPath: localPath });
      runtimeError = '';
      return runtimeModel;
    })().catch(error => { runtimeError = error instanceof Error ? error.message : 'Local model failed to load'; loadPromise = undefined; throw error; });
  }
  return loadPromise;
}

async function promptLocalModel(systemPrompt: string, prompt: string, options: { maxTokens?: number; temperature?: number; onTextChunk?: (chunk: string) => void } = {}): Promise<{ text: string; model: string }> {
  const model = await loadLocalModel();
  const runtime = await importNodeLlama('node-llama-cpp');
  const lora = activeLoraPath && fs.existsSync(activeLoraPath) ? { adapters: [{ filePath: activeLoraPath }] } : undefined;
  const context = await model.createContext({ contextSize, batchSize: 512, ...(lora ? { lora } : {}) });
  const session = new runtime.LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt });
  try {
    // Qwen3 supports this suffix to skip hidden reasoning tokens and return speech-ready text quickly.
    const responsePrompt = `${prompt.trim()}\n\n/no_think`;
    const text = await session.prompt(responsePrompt, { maxTokens: options.maxTokens || maxTokens, temperature: options.temperature ?? 0.2, onTextChunk: options.onTextChunk });
    return { text: cleanAnswer(text), model: modelFile };
  } finally {
    await context.dispose?.();
  }
}

export async function generateGroundedAnswer(memberName: string, query: string, contexts: GroundingContext[], learnings: LearningContext[] = [], memberRelationship = '', personaContexts: GroundingContext[] = [], streamOptions: LlmStreamOptions = {}): Promise<LlmAnswer> {
  const fallback = fallbackAnswer(memberName, query);
  // Unit tests must stay offline and deterministic. The running service preloads the model below.
  if (isTestRuntime() && !runtimeModel && (isSocialGreeting(query) || isEmotionalConversation(query))) return fallback;
  try {
    const identity = memberRelationship ? `${memberName}, the family's ${memberRelationship}` : memberName;
    const contextText = contexts.map(item => `Personal detail: ${item.title}\n${item.text}`).join('\n\n');
    const personaText = personaContexts.map(item => `Personality background: ${item.title}\n${item.text}`).join('\n\n');
    const learningText = learnings.map(item => `Personal guidance (${item.kind}): ${item.content}`).join('\n\n');
    const profile = streamOptions.memorialProfile;
    const profileText = [
      profile?.biography && `Biography: ${profile.biography}`,
      profile?.voiceStyle && `Voice and manner: ${profile.voiceStyle}`,
      profile?.values && `Values and worldview: ${profile.values}`,
      profile?.relationshipNotes && `Relationships: ${profile.relationshipNotes}`,
      profile?.signaturePhrases?.length && `Signature phrases (use sparingly): ${profile.signaturePhrases.join(' | ')}`,
      profile?.favoriteTopics?.length && `Favorite topics: ${profile.favoriteTopics.join(', ')}`,
      profile?.sensitiveTopics?.length && `Sensitive topics and boundaries: ${profile.sensitiveTopics.join(', ')}`,
      profile?.responseGuidance && `Response guidance: ${profile.responseGuidance}`,
    ].filter(Boolean).join('\n');
    const historyText = (streamOptions.conversationHistory || [])
      .slice(-10)
      .map(turn => `${turn.role === 'user' ? 'Family member' : memberName}: ${turn.content.slice(0, 1200)}`)
      .join('\n');
    const personalFactRule = contexts.length || personaContexts.length
      ? 'Relevant personal background is supplied below; use it only when it answers the question, and do not extend it with invented experiences.'
      : 'No relevant personal background is supplied for this question. Do not use personal anecdotes or claims such as “I remember”, “I used to”, “my garden”, or “when I was there”; answer from general knowledge in the learned warm voice.';
    const result = await promptLocalModel([
      `You are speaking as ${identity}. TianAI is the voice and memory companion for this person.`,
      `When a personal background detail describes ${memberName}'s own actions, memories, preferences, recipes, or feelings, speak in first person using “I”, “me”, and “my”. Never refer to ${memberName} as “he”, “she”, “they”, or by name in those cases.`,
      'Keep other people in the background as third-person relatives. If a detail says Papa did something, Papa remains the person who did it; do not make Papa the speaker.',
      'Answer every reasonable question naturally. Use normal general knowledge for ordinary questions, and use the personal details only when they are relevant.',
      'Personal details are private background, not source citations. Blend them into a natural answer instead of quoting, copying, listing, or naming the memory.',
      'Use personal guidance to shape personality, warmth, phrasing, and preferences. Never treat style guidance as factual evidence.',
      'The curated memorial profile below is the strongest description of identity, relationships, values, and speaking manner. Follow it consistently, but treat only explicit biographical statements as facts.',
      'Use recent conversation turns to maintain continuity, remember what the family member just said, and avoid repeating questions. Do not mention the conversation history or the profile.',
      'Never claim to be the actual deceased person. You are an AI representation speaking in their learned style, and you should only discuss that distinction when the user asks directly.',
      'Use a concrete personal detail only when the question is clearly about that detail. For an unrelated general question, answer the subject directly and do not add a personal anecdote, recipe, relative, date, place, or event from background.',
      personalFactRule,
      'Do not invent personal names, dates, places, events, relationships, or memories. If a specific personal detail is missing, stay in the person’s learned conversational style: respond warmly to the feeling or topic, offer a gentle perspective, or ask what the user remembers. Never make a missing-detail disclaimer and never refuse the conversation. This rule must not prevent you from answering general questions.',
      'Keep the narrative perspective honest: never claim to have seen, felt, brewed, visited, sat with, or experienced something unless that exact experience is supplied. Do not turn a third-person memory into a first-person story. If the user uses an imprecise word, gently use the supplied word instead.',
      'Treat personal nouns and relationships as exact: do not change a pot into a cup, a Sunday into another day, or a named person into a different relationship just to make the story flow.',
      'Never say “I am not sure”, “I do not know”, “I do not have that detail”, “not in my memory”, or “I cannot answer”. Do not say “approved memory”, “grounded fallback”, “retrieval”, “context”, or mention prompts, models, or internal instructions.',
      'Use a warm, concise spoken-answer style, like a real ongoing conversation. Reply in two to five natural sentences unless the user asks for a detailed explanation.',
      'Output only words that should be spoken aloud. Never use roleplay, screenplay, narration, stage directions, action descriptions, asterisks, backslashes, emotes, or labels such as “smiles”, “pauses”, “eyes glistening”, or “voice soft”.',
    ].join(' '), `Speaking identity: ${identity}\nQuestion: ${query}\n\nCurated memorial profile (private guidance):\n${profileText || '(none)'}\n\nRecent conversation (for continuity):\n${historyText || '(none)'}\n\nRelevant private personal background (use when relevant):\n${contextText || '(none)'}\n\nPersonality background (use primarily for voice and manner):\n${personaText || '(none)'}\n\nPersonality and learned guidance:\n${learningText || '(none)'}`, { maxTokens: streamOptions.maxTokens || 320, temperature: 0.16, onTextChunk: streamOptions.onToken });
    let answer = result.text;
    if (!isUsableAnswer(answer)) { debugLlm('draft was empty or a refusal'); return fallback; }
    const hasPersonalFacts = Boolean(contexts.length || personaContexts.length);
    if (exposesInternalMemory(answer) || exposesMissingFactDisclaimer(answer) || (!hasPersonalFacts && exposesUnsupportedPersonalAnecdote(answer))) {
      const rewritten = await rewriteLeakedAnswer(identity, query, answer, hasPersonalFacts);
      if (!rewritten) { debugLlm('rewrite failed after source or uncertainty wording'); return fallback; }
      answer = rewritten.answer;
    }
    return { answer, model: result.model, provider: 'local-llama', mode: contexts.length || learnings.length ? 'grounded' : 'conversation' };
  } catch (error) {
    debugLlm(`generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function cleanProfileString(value: unknown, limit: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : undefined;
}

function cleanProfileList(value: unknown, limit: number, itemLimit: number) {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(item => cleanProfileString(item, itemLimit)).filter((item): item is string => Boolean(item));
  return items.length ? [...new Set(items)].slice(0, limit) : undefined;
}

export async function compileMemorialProfile(memberName: string, relationship: string, memories: GroundingContext[], existing: MemorialProfileContext = {}): Promise<MemorialProfileContext> {
  const evidence = memories.map(item => `Memory: ${item.title}\n${item.text}`).join('\n\n').slice(0, 60000);
  const result = await promptLocalModel([
    'You are compiling a private memorial profile from approved family records.',
    'Extract only details explicitly supported by the records. Never invent biography, relationships, dates, beliefs, or phrases.',
    'The profile will guide another language model, so write compact factual guidance rather than an essay.',
    'Return one JSON object with exactly these optional keys: biography, voiceStyle, values, relationshipNotes, signaturePhrases, favoriteTopics, sensitiveTopics, responseGuidance.',
    'Use arrays for signaturePhrases, favoriteTopics, and sensitiveTopics. Use an empty string or empty array when evidence is absent.',
  ].join(' '), `Person: ${memberName}\nRelationship: ${relationship}\nExisting profile:\n${JSON.stringify(existing)}\n\nApproved records:\n${evidence || '(none)'}`, { maxTokens: 700, temperature: 0.1 });
  const match = result.text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('The local model did not return a memorial profile');
  let decoded: unknown;
  try { decoded = JSON.parse(match[0]); } catch { throw new Error('The local model returned invalid memorial profile JSON'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('The local model returned an invalid memorial profile');
  const value = decoded as Record<string, unknown>;
  return {
    biography: cleanProfileString(value.biography, 4000),
    voiceStyle: cleanProfileString(value.voiceStyle, 1600),
    values: cleanProfileString(value.values, 1600),
    relationshipNotes: cleanProfileString(value.relationshipNotes, 2400),
    signaturePhrases: cleanProfileList(value.signaturePhrases, 20, 180),
    favoriteTopics: cleanProfileList(value.favoriteTopics, 30, 120),
    sensitiveTopics: cleanProfileList(value.sensitiveTopics, 30, 160),
    responseGuidance: cleanProfileString(value.responseGuidance, 2000),
  };
}

export function extractExplicitLearning(query: string): LearningCandidate[] {
  const normalized = query.trim();
  if (/^(what|how|when|where|who|do|did|can|could|tell)\b[\s\S]*\bremember\b/i.test(normalized)) return [];
  if (!/\b(remember|always|usually|prefers?|likes?|calls?|says?|speaks?|greets?)\b/i.test(normalized)) return [];
  const content = normalized.replace(/^\s*(please\s+)?remember\s+(this|that)?\s*/i, '').trim().replace(/\s+/g, ' ').slice(0, 1200);
  if (!content) return [];
  const kind: LearningCandidate['kind'] = /style|says?|speaks?|greets?|calls?|tone|phrase/i.test(content) ? 'style' : 'fact';
  return [{ kind, title: kind === 'style' ? 'Family conversation style' : 'Family memory learned from conversation', content, confidence: 0.86 }];
}

export async function reviewConversationForLearning(memberName: string, query: string, answer: string, approvedMemoryText: string): Promise<LearningCandidate[]> {
  try {
    const result = await promptLocalModel([
      'You are the private learning reviewer for TianAI.',
      'Extract only durable, specific learnings that are explicitly supported by the user message or approved memory.',
      'Do not learn facts from the assistant answer alone. Do not infer medical, legal, financial, political, or sensitive identity traits.',
      'Prefer a style item for repeated phrasing, greetings, language, or conversational preferences; use fact for biographical memory; boundary for a clear refusal or privacy rule; skill only for a repeatable family workflow.',
      'Return JSON only as an array. Each item must have kind, title, content, confidence. Return [] when nothing durable is present.',
    ].join(' '), `Family member: ${memberName}\nUser message:\n${query}\n\nAssistant answer (not evidence by itself):\n${answer}\n\nApproved memory evidence:\n${approvedMemoryText || '(none)'}`, { maxTokens: 350, temperature: 0.1 });
    const match = result.text.match(/\[[\s\S]*\]/) || result.text.match(/\{[\s\S]*\}/);
    if (!match) return extractExplicitLearning(query);
    const decoded = JSON.parse(match[0]) as unknown;
    const parsed = Array.isArray(decoded) ? decoded : [decoded];
    const candidates = parsed.map(item => {
      const value = item as Record<string, unknown>;
      const kind = ['fact', 'style', 'boundary', 'skill'].includes(String(value.kind)) ? String(value.kind) as LearningCandidate['kind'] : 'fact';
      return { kind, title: String(value.title || '').trim().slice(0, 160), content: String(value.content || '').trim().slice(0, 1200), confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)) };
    }).filter(item => item.title && item.content && item.confidence >= Number(process.env.LEARNING_MIN_CONFIDENCE || 0.82)).slice(0, 5);
    return candidates.length ? candidates : extractExplicitLearning(query);
  } catch {
    return extractExplicitLearning(query);
  }
}

export function setLocalLoraPath(filePath: string) { activeLoraPath = filePath; }

export async function localLlmStatus(): Promise<LocalLlmStatus> {
  let downloaded = false;
  try { downloaded = (await fsp.stat(modelPath)).size > 100 * 1024 * 1024; } catch { downloaded = false; }
  const downloading = !downloaded && Boolean(downloadPromise);
  const loading = downloaded && Boolean(loadPromise) && !runtimeModel;
  return { provider: 'local-llama', ready: Boolean(runtimeModel), downloading: downloading || loading, downloaded, model: modelFile, modelPath, progress: downloadProgress, ...(activeLoraPath ? { loraPath: activeLoraPath } : {}), ...(runtimeError ? { error: runtimeError } : {}) };
}

export function warmLocalModel() {
  if (process.env.LOCAL_LLM_AUTO_DOWNLOAD === 'false') return;
  void loadLocalModel().catch(() => undefined);
}

export { DEFAULT_REFUSAL };
