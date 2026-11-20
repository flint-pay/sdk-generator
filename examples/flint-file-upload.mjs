import { readFile } from 'node:fs/promises';
import { Client } from '@flintpay/node';

const [path, contentType = 'image/png'] = process.argv.slice(2);
if (!path) throw new Error('Usage: node flint-file-upload.mjs <image-path> [content-type]');

const bytes = await readFile(path);
const client = new Client();
try {
  const file = await client.files.create({
    purpose: 'product',
    content_type: contentType,
    size_bytes: bytes.byteLength,
  });
  const { upload } = file;
  if (!upload) throw new Error('Flint did not return upload instructions');

  const response = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: bytes,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}`);

  const completed = await client.files.complete(file.file_id);
  console.log(completed.file_id, completed.status);
} finally {
  await client.close();
}
