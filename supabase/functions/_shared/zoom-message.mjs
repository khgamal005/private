// The canonical SQL returns a tenant-scoped path; only trusted deployment
// configuration supplies the public origin. Webinar personal URLs pass through.
export function resolveZoomTrainingMessage(job, path, configuredOrigin) {
 if (!path?.startsWith('/training/')) return job;
 let origin;
 try { origin = new URL(configuredOrigin); } catch { throw new Error('zoom_public_origin_required'); }
 if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('zoom_public_origin_required');
 if (!/^\/training\/[a-z0-9-]+\/sessions\/[a-f0-9-]{36}$/.test(path)) throw new Error('zoom_invalid_training_path');
 const url = new URL(path, origin.origin).href;
 return {...job, messageText: job.messageText?.replaceAll(path, url), metadata: {...job.metadata, venueOrLink: url}};
}
