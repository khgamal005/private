create index people_staff_department_reference_idx
on people.staff_profiles (department_id)
where department_id is not null;

create index academy_course_runs_course_reference_idx
on academy.course_runs (course_id);
