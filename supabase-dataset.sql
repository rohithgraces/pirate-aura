create table if not exists public.college_dataset (
  id bigint generated always as identity primary key,
  keywords jsonb not null,
  response text not null,
  created_at timestamptz not null default now()
);

alter table public.college_dataset enable row level security;

drop policy if exists "service role full access on college_dataset" on public.college_dataset;

create policy "service role full access on college_dataset"
on public.college_dataset
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
