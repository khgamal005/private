/** Server-issued training journey projections. UI roles never grant authorization. */
export type TrainingRole = 'manager' | 'instructor' | 'learner';
export type TrainingUnitKind = 'text' | 'video' | 'link' | 'quiz' | 'assignment';
export type LearningMode = 'self_paced' | 'live' | 'blended';
export type TrainingPayload = Record<string, unknown>;
export type TrainingMutationResult = Record<string, unknown>;
export type TrainingMutation = (action: string, payload: TrainingPayload, success: string) => Promise<TrainingMutationResult | null>;
export interface TrainingPolicy {
  minAttendancePercent: number;
  minAssessmentPercent: number;
  requireCompletedRun: boolean;
  certificateEnabled: boolean;
  termsVersion: string;
  supportEmail: string;
}
export interface TrainingQuestion { id: string; prompt: string; options: string[]; correctOptionIndex?: number }
export interface TrainingUnit {
  id: string; title: string; kind: TrainingUnitKind; position?: number; required: boolean;
  minimumSeconds: number; completedAt?: string | null; score?: number | null;
  maxAttempts?: number; attemptCount?: number; passPercent?: number;
  body?: string; url?: string; questions?: TrainingQuestion[];
}
export interface TrainingVersion {
  id: string; version: number; title?: string; status: string; learningMode: LearningMode;
  policy: TrainingPolicy; units: TrainingUnit[];
}
export interface TrainingCourse { id: string; title: string; versions: TrainingVersion[] }
export interface TrainingFinancialAccess {
  trainingAllowed: boolean; certificationAllowed: boolean; financialStatus: string; reasonCodes: string[];
  paidMinor?: number; totalMinor?: number; outstandingMinor?: number; overdueSince?: string | null; graceEndsOn?: string | null;
  invoiceId?: string | null; currency?: string; policy?: 'full' | 'installments' | 'company_credit'; policyVersion?: number; sponsor?: boolean;
}
export interface TrainingCertificate { id: string; number: string; verificationCode?: string; status: string; issuedAt: string }
export interface TrainingEnrollment {
  id: string; studentId: string; studentName: string; studentEmail?: string; courseId: string; courseTitle: string;
  runId?: string | null; runTitle?: string | null; status: string; versionId?: string | null;
  financialAccess: TrainingFinancialAccess;
  progress: { completedUnits: number; totalUnits: number; percent: number };
  units?: TrainingUnit[];
  certificate?: TrainingCertificate | null;
  eligibility?: { eligible: boolean; reasons: string[] };
  sessions?: Array<{ id: string; title: string; startsAt?: string; endsAt?: string; status?: string; joinUrl?: string }>;
  policy?: TrainingPolicy;
}
export interface TrainingSubmission {
  id: string; enrollmentId: string; studentName?: string; courseTitle?: string; unitTitle?: string;
  body: string; unitId: string; attempt?: number; submittedAt?: string;
  grade: { score: number; feedback?: string; gradedAt?: string } | null;
}
export interface TrainingInstructor { id?: string; subjectId: string; name?: string; fullName?: string; runId?: string; active?: boolean }
export interface TrainingLearningSnapshot {
  role: TrainingRole; courses: TrainingCourse[]; enrollments: TrainingEnrollment[];
  instructors?: TrainingInstructor[]; instructorCandidates?: Array<{ subjectId: string; name: string }>; submissions?: TrainingSubmission[];
  requests?: TrainingRequest[]; availableRuns?: Array<{ id: string; courseId: string; title: string }>;
  pagination?: { offset: number; limit?: number; hasMore?: boolean; total?: number };
}
export interface TrainingViewer {
  canManage?: boolean; canApprovePayments?: boolean; canReadAccounting?: boolean;
  canReadAdmissions?: boolean; canManageAdmissions?: boolean; canManageCourses?: boolean;
  canManageTasks?: boolean; canManageSponsors?: boolean; canManagePolicies?: boolean;
  [key: string]: unknown;
}
export interface TrainingJourneySnapshot {
  role: TrainingRole;
  tenant: { id: string; slug: string; name: string; timezone?: string; currency?: string };
  viewer: TrainingViewer;
  learning: TrainingLearningSnapshot | null;
  operations?: TrainingOperationsSnapshot | null;
}
export const TRAINING_ROLE_LABELS: Record<TrainingRole, string> = {
  manager: 'إدارة التدريب', instructor: 'المحاضر', learner: 'المتدرب',
};
export const TRAINING_UNIT_LABELS: Record<TrainingUnitKind, string> = {
  text: 'درس نصي', video: 'فيديو', link: 'مصدر خارجي', quiz: 'اختبار', assignment: 'واجب',
};
export const LEARNING_MODE_LABELS: Record<LearningMode, string> = {
  self_paced: 'تعلم ذاتي', live: 'تدريب مباشر', blended: 'تدريب مدمج',
};
export function safeTrainingExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export type TrainingFinance = TrainingFinancialAccess;
export interface TrainingHandoff { id: string; contactId: string; contactName: string; courseId: string; courseTitle: string; courseRunId?: string; status: string; paymentStatus: string; enrollmentId?: string; financial?: TrainingFinance }
export interface TrainingOperationEnrollment { id: string; handoffId?: string; studentId: string; studentName: string; studentEmail?: string; courseId: string; courseTitle: string; courseRunId?: string; runTitle?: string; status: string; financial?: TrainingFinance }
export interface TrainingRequest { id: string; enrollmentId: string; kind: 'transfer' | 'defer' | 'withdraw' | 'access_exception' | 'resume'; status: string; reason: string; assignedStaffId?: string; dueAt?: string; targetRunId?: string }
export interface TrainingOperationsSnapshot {
  offset?: number; pageSize?: number; hasMore?: boolean;
  enabled: boolean; settings: { graceDays: number; timezone: string };
  handoffs: TrainingHandoff[]; enrollments: TrainingOperationEnrollment[];
  invoices: Array<{ id: string; number: string; customerAccountId: string; customerName: string; totalMinor: number; currency: string }>;
  payments?: Array<{ id: string; number: string; customerAccountId: string; amountMinor: number; status: string }>;
  runs: Array<{ id: string; courseId: string; title: string; status: string; capacity?: number; enrolledCount?: number }>;
  staff: Array<{ id: string; name: string }>;
  requests: TrainingRequest[];
  tasks: Array<{ id: string; title: string; status: string; assignedStaffId?: string; dueAt?: string }>;
  automation?: { enabled: boolean; admissionsStaffId?: string | null; financeStaffId?: string | null; escalationStaffId?: string | null; assignmentDueDays: number; gradingDueDays: number; staffCandidates: Array<{ id: string; name: string }>; cronAvailable: boolean };
  capabilities: { canManage: boolean; canVerifyPayments: boolean; canApproveCredit: boolean };
}
