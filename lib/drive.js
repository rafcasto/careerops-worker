// Google Drive uploads with a service account — plain REST + a self-signed JWT
// (no googleapis dependency). Credentials: GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL +
// GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY if set, else the Firebase service
// account. The target folder (GOOGLE_DRIVE_FOLDER_ID) must be shared with that
// account as Editor, and the Drive API enabled on its project.
import { createSign } from 'node:crypto';

let cached = { token: null, exp: 0 };

function creds() {
  const email = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (email && key) return { email, key };
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) return null;
  const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return { email: sa.client_email, key: sa.private_key };
}

export const driveConfigured = () => !!(process.env.GOOGLE_DRIVE_FOLDER_ID && creds());
export const driveAccountEmail = () => creds()?.email ?? null;

export async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const c = creds();
  if (!c) throw new Error('no Google service account configured');
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(c.key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Drive auth failed: ${j.error_description || j.error || r.status}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

const API = 'https://www.googleapis.com/drive/v3';
const q = (s) => s.replace(/'/g, "\\'");

async function drive(path, init = {}) {
  const r = await fetch(`${API}${path}${path.includes('?') ? '&' : '?'}supportsAllDrives=true`, { ...init, headers: { authorization: `Bearer ${await accessToken()}`, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`Drive ${init.method ?? 'GET'} ${path.split('?')[0]} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// <root>/<label>/ — one subfolder per member (label = email or uid), created on demand.
const folderCache = new Map();
export async function ensureFolder(parentId, name) {
  const key = `${parentId}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);
  const found = await drive(`/files?q=${encodeURIComponent(`'${q(parentId)}' in parents and name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}&fields=files(id)&includeItemsFromAllDrives=true`);
  let id = found.files?.[0]?.id;
  if (!id) {
    const made = await drive('/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }) });
    id = made.id;
  }
  folderCache.set(key, id);
  return id;
}

export async function uploadPdf({ folderId, name, buffer }) {
  const boundary = `careerops-${Date.now()}`;
  const meta = JSON.stringify({ name, parents: [folderId], mimeType: 'application/pdf' });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
    buffer, Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,size`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': `multipart/related; boundary=${boundary}` }, body,
  });
  if (!r.ok) throw new Error(`Drive upload → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export async function probeFolder(folderId) {
  try { const f = await drive(`/files/${folderId}?fields=id,name,capabilities/canAddChildren`); return { ok: true, name: f.name, canWrite: !!f.capabilities?.canAddChildren }; }
  catch (e) { return { ok: false, error: e.message }; }
}
