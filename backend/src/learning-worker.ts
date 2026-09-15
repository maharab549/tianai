import { parentPort, workerData } from 'node:worker_threads';
import { reviewConversationForLearning } from './llm';

const input = workerData as { memberName: string; query: string; answer: string; approvedMemoryText: string };
reviewConversationForLearning(input.memberName, input.query, input.answer, input.approvedMemoryText)
  .then(result => parentPort?.postMessage({ ok: true, result }))
  .catch(error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Learning review failed' }));
