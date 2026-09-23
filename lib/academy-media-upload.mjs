import {ACADEMY_MEDIA_CHUNK_BYTES} from './academy-media.mjs';

/** A signed token is scoped to one immutable object. No user JWT is persisted. */
export async function startAcademyVideoUpload({file, ticket, onProgress, onSuccess, onError, UploadClass, autoStart=true}) {
  const Upload = UploadClass || (await import('tus-js-client')).Upload;
  const upload = new Upload(file, {
    endpoint:ticket.endpoint,
    headers:{'x-signature':ticket.token},
    metadata:{bucketName:ticket.bucket, objectName:ticket.objectPath, contentType:file.type, cacheControl:'private, max-age=0'},
    chunkSize:ACADEMY_MEDIA_CHUNK_BYTES,
    retryDelays:[0, 1000, 3000, 5000, 10000],
    uploadDataDuringCreation:true,
    removeFingerprintOnSuccess:true,
    // Isolate resume records by tenant/course/object, including identical files.
    fingerprint:() => Promise.resolve(`academy:${ticket.objectPath}:${file.size}:${file.lastModified}`),
    onProgress:(uploaded,total) => onProgress?.(total ? Math.min(100, Math.floor(uploaded / total * 100)) : 0),
    onSuccess, onError,
  });
  const previous = await upload.findPreviousUploads();
  const safe = previous.find(item => {
    try { const saved = new URL(item.uploadUrl), endpoint = new URL(ticket.endpoint); return saved.origin === endpoint.origin && saved.pathname.startsWith(endpoint.pathname + '/'); }
    catch { return false; }
  });
  if (safe) upload.resumeFromPreviousUpload(safe);
  if(autoStart) upload.start();
  return upload;
}
