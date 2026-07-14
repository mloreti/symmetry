-- Run this once in the Supabase SQL Editor for this project.

create table if not exists workout_state (
  id smallint primary key default 1,
  current_index int not null default 0,
  session jsonb,
  updated_at timestamptz not null default now()
);
insert into workout_state (id, current_index) values (1, 0)
  on conflict (id) do nothing;

create table if not exists workout_history (
  id bigserial primary key,
  completed_at timestamptz not null default now(),
  entry_index int not null,
  type text not null,
  label text not null
);

create table if not exists exercise_loads (
  name text primary key,
  load numeric not null,
  updated_at timestamptz not null default now()
);

alter table workout_state enable row level security;
alter table workout_history enable row level security;
alter table exercise_loads enable row level security;

-- No login system in this app — the anon key is the only credential, so RLS
-- just grants it full access rather than scoping by user.
create policy "anon full access" on workout_state for all using (true) with check (true);
create policy "anon full access" on workout_history for all using (true) with check (true);
create policy "anon full access" on exercise_loads for all using (true) with check (true);
