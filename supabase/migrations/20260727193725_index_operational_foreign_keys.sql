begin;

create index sales_contacts_owner_reference_idx
on sales_core.contacts (owner_staff_id);

create index sales_contacts_course_reference_idx
on sales_core.contacts (interest_course_id);

create index sales_contacts_creator_reference_idx
on sales_core.contacts (created_by_subject_id);

create index sales_opportunities_contact_reference_idx
on sales_core.opportunities (contact_id);

create index sales_opportunities_course_reference_idx
on sales_core.opportunities (course_id);

create index sales_opportunities_stage_reference_idx
on sales_core.opportunities (stage_id);

create index sales_opportunities_owner_reference_idx
on sales_core.opportunities (owner_staff_id);

create index sales_opportunities_creator_reference_idx
on sales_core.opportunities (created_by_subject_id);

create index sales_activities_creator_reference_idx
on sales_core.activities (created_by_subject_id);

create index work_tasks_creator_reference_idx
on work_core.tasks (created_by_subject_id);

commit;
