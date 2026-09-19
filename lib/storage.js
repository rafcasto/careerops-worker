// Where a generated PDF lives so the member (and the admin) can get it back:
//   1. Google Drive — the admin's shared folder, one subfolder per member
//      (GOOGLE_DRIVE_FOLDER_ID; the site proxies member downloads);
//   2. Firebase Storage — when the project has a bucket;
//   3. inline base64 in the Firestore doc (a CV PDF is ~50–150 kB, far under 1 MB).
// Every doc records which one it used so the site knows how to serve it.
import { getStorage } from 'firebase-admin/storage';
import { firestore } from './firestore.js';
import { driveConfigured, ensureFolder, uploadPdf } from './drive.js';

let bucketOk = null;
async function bucket() {
  if (bucketOk !== null) return bucketOk;
  try { firestore(); const b = getStorage().bucket(); const [exists] = await b.exists(); bucketOk = exists ? b : false; }
  catch { bucketOk = false; }
  return bucketOk;
}

export const SIGNED_URL_DAYS = 7;

export async function savePdf(uid, relName, buffer, { log, memberLabel } = {}) {
  if (driveConfigured()) {
    try {
      const folder = await ensureFolder(process.env.GOOGLE_DRIVE_FOLDER_ID, memberLabel || uid);
      const f = await uploadPdf({ folderId: folder, name: relName, buffer });
      if (log) await log(`uploaded to Google Drive: ${memberLabel || uid}/${relName}`);
      return { storage: 'drive', driveFileId: f.id, driveLink: f.webViewLink ?? null, storagePath: `${memberLabel || uid}/${relName}`, url: null, urlExpires: null, size: buffer.length };
    } catch (e) { if (log) await log(`Drive upload failed (${e.message}) — falling back`); }
  }
  const b = await bucket();
  if (b) {
    const path = `careerops/${uid}/output/${relName}`;
    const f = b.file(path);
    await f.save(buffer, { contentType: 'application/pdf', resumable: false });
    const expires = Date.now() + SIGNED_URL_DAYS * 86_400_000;
    const [url] = await f.getSignedUrl({ action: 'read', expires });
    return { storage: 'bucket', storagePath: path, url, urlExpires: expires, size: buffer.length };
  }
  if (log) await log('no Drive folder or Storage bucket configured — storing the PDF inline in Firestore');
  if (buffer.length > 900_000) throw new Error('PDF too large to store inline — configure Google Drive or Firebase Storage');
  return { storage: 'inline', storagePath: null, url: null, urlExpires: null, size: buffer.length, pdfBase64: buffer.toString('base64') };
}
