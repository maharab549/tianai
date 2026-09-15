export const API_URL = import.meta.env.VITE_API_URL || '/api';
export const assetUrl = (url?: string) => !url ? '' : url.startsWith('http') ? url : `${API_URL.replace(/\/api$/, '')}${url}`;
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('tianai_token');
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Request failed (${response.status})`); }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export async function streamApi<T = any>(path: string, body: unknown, onDelta: (delta: string) => void): Promise<T> {
  const token = localStorage.getItem('tianai_token');
  const response = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Request failed (${response.status})`); }
  if (!response.body) throw new Error('Streaming is unavailable in this browser');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let result: T | undefined;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
    const events = buffer.split('\n\n'); buffer = events.pop() || '';
    for (const event of events) { const line = event.split('\n').find(value => value.startsWith('data: ')); if (!line) continue; const payload = JSON.parse(line.slice(6)); if (payload.delta) onDelta(payload.delta); if (payload.done) result = payload.result as T; }
  }
  if (!result) throw new Error('The streamed response ended without a result');
  return result;
}
