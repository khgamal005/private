import {trainingProblem, validTrainingId} from './training-request.mjs';

export const ACADEMY_MEDIA_MAX_BYTES = 524288000;
export const ACADEMY_MEDIA_BUCKET = 'academy-course-media';
export const ACADEMY_MEDIA_CHUNK_BYTES = 6 * 1024 * 1024;
const extensions = {'video/mp4':['mp4'], 'video/webm':['webm']};

export function academyMediaFile(file) {
  const name = file?.name ?? file?.fileName, type = file?.type ?? file?.mimeType, size = file?.size ?? file?.sizeBytes;
  if (typeof name !== 'string' || !name || name.length > 180 || /[\u0000-\u001f/\\]/.test(name)) throw trainingProblem('academy_media_name_invalid');
  if (!extensions[type]?.includes(name.toLowerCase().split('.').pop())) throw trainingProblem('academy_media_type_invalid', 415);
  if (!Number.isSafeInteger(size) || size < 1 || size > ACADEMY_MEDIA_MAX_BYTES) throw trainingProblem('academy_media_size_invalid', 413);
  return {fileName:name, mimeType:type, sizeBytes:size};
}

export function academyMediaPayload(action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw trainingProblem('invalid_request');
  if (action === 'create_upload') {
    if (!validTrainingId(input.courseId)) throw trainingProblem('invalid_request');
    return {courseId:input.courseId, ...academyMediaFile(input)};
  }
  if (!['complete_upload','set_download','cancel_upload'].includes(action) || !validTrainingId(input.assetId)) throw trainingProblem('invalid_request');
  if (action === 'set_download' && (typeof input.allowDownload !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1)) throw trainingProblem('invalid_request');
  return {assetId:input.assetId, ...(action === 'set_download' ? {allowDownload:input.allowDownload,expectedVersion:input.expectedVersion} : {})};
}

export function academyMediaPath(assetId, slug='marktone') {
  if (!validTrainingId(assetId) || slug !== 'marktone') throw trainingProblem('invalid_request');
  return `/api/academy-media/${assetId}?tenantSlug=${encodeURIComponent(slug)}`;
}

export function academyMediaId(url) {
  try {
    const value = new URL(url);
    const id = value.pathname.match(/^\/api\/academy-media\/([a-f0-9-]+)$/i)?.[1];
    return value.protocol === 'https:' && value.hostname === 'odeir.com' && !value.port && !value.username && !value.password && validTrainingId(id) && value.searchParams.get('tenantSlug') === 'marktone' ? id : null;
  } catch { return null; }
}

const messages = {
  academy_media_policy_conflict:'تغير إعداد التنزيل لدى مستخدم آخر. افتح الدرس مجددًا قبل التعديل.',
  academy_media_name_invalid:'اختر ملفًا باسم واضح دون رموز غير مسموحة.',
  academy_media_type_invalid:'اختر فيديو MP4 أو WebM.',
  academy_media_size_invalid:'حجم الفيديو المسموح من بايت واحد إلى 500 ميجابايت.',
  academy_media_not_ready:'لم يكتمل رفع الفيديو بعد. استكمل الرفع ثم حاول مرة أخرى.',
  academy_media_upload_expired:'انتهت مهلة الرفع. اختر الفيديو لبدء محاولة جديدة.',
  academy_media_upload_limit:'توجد ملفات قيد الرفع لهذه الدورة. أكملها أو ألغها أولًا.',
  academy_media_not_found:'الفيديو غير متاح أو ليست لديك صلاحية مشاهدته.',
  academy_media_download_disabled:'تنزيل هذا الفيديو غير متاح.',
  academy_delivery_disabled:'يجري تجهيز ربط الدورات والملفات لهذه المنشأة.',
};
export const academyMediaError = code => messages[code] || (/forbidden|permission/.test(code || '') ? 'ليست لديك صلاحية لهذا الإجراء.' : 'تعذر إكمال العملية. حاول مرة أخرى؛ يمكنك استكمال الرفع.');
