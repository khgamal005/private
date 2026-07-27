begin;

create index assessment_results_tenant_reference_idx
on academy.assessment_results (tenant_id);

create index assessment_results_assessor_reference_idx
on academy.assessment_results (assessed_by_subject_id)
where assessed_by_subject_id is not null;

create index attendance_records_session_reference_idx
on academy.attendance_records (session_id);

create index attendance_records_marker_reference_idx
on academy.attendance_records (marked_by_subject_id)
where marked_by_subject_id is not null;

create index student_communications_tenant_reference_idx
on academy.student_communications (tenant_id);

create index student_communications_sender_reference_idx
on academy.student_communications (sent_by_subject_id)
where sent_by_subject_id is not null;

create index certificates_course_run_reference_idx
on academy.certificates (course_run_id);

create index certificates_issuer_reference_idx
on academy.certificates (issued_by_subject_id)
where issued_by_subject_id is not null;

create index certificates_revoker_reference_idx
on academy.certificates (revoked_by_subject_id)
where revoked_by_subject_id is not null;

commit;
