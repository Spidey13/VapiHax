import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildAssistantPayload, updateEnvText } from '../src/vapi/assistantConfig.js';

export async function syncAssistant(): Promise<string> {
  try { process.loadEnvFile?.(); } catch { /* ignore */ }
  const key = process.env.VAPI_PRIVATE_KEY;
  const secret = process.env.VAPI_CUSTOM_LLM_SECRET;
  const publicUrl = process.env.PUBLIC_URL;
  if (!key || !secret || !publicUrl) throw new Error('VAPI_PRIVATE_KEY, VAPI_CUSTOM_LLM_SECRET and PUBLIC_URL must be set');
  const payload = buildAssistantPayload({ publicUrl, secret });
  const existing = process.env.VAPI_ASSISTANT_ID;
  const res = await fetch(`https://api.vapi.ai/assistant${existing ? `/${existing}` : ''}`, {
    method: existing ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${text.slice(0, 600).split(secret).join('<redacted>')}`);
  const id = (JSON.parse(text) as { id: string }).id;
  if (id !== existing) {
    fs.writeFileSync('.env', updateEnvText(fs.readFileSync('.env', 'utf8'), { VAPI_ASSISTANT_ID: id }));
    process.env.VAPI_ASSISTANT_ID = id;
  }
  console.log(`assistant ${existing ? 'updated' : 'created'}: ${id}`);
  return id;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  syncAssistant().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
