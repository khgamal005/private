begin;

create index training_automation_jobs_course_run_reference_idx
on academy.training_automation_jobs (course_run_id);

commit;
