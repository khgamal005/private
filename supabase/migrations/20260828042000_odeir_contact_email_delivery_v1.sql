alter table website.contact_submissions
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_provider_id text;

create index if not exists contact_submissions_reference_idx
  on website.contact_submissions(reference_key);
