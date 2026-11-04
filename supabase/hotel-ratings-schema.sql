-- Hotel ratings (hotel-ratings.html): reference copy of the schema applied on 2026-11-04
-- to the shared That Sorted Life project (cwnlofcrstwxoemzyazm) as migration "hotel_stays_ratings".
-- Kept here for reference only; it is not part of a supabase/migrations history.
--
-- Access model: anyone can read finalised stays. Writes, and reading drafts, need a signed-in
-- Supabase user listed in public.hotel_rating_editors (Ramo's account was added after the migration:
--   insert into public.hotel_rating_editors (user_id) select id from auth.users where email = '<editor email>';)

create table public.hotel_rating_editors (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.hotel_rating_editors enable row level security;
revoke all on public.hotel_rating_editors from anon, authenticated;

create or replace function public.is_hotel_rating_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.hotel_rating_editors e where e.user_id = (select auth.uid()));
$$;
revoke all on function public.is_hotel_rating_editor() from public, anon;
grant execute on function public.is_hotel_rating_editor() to authenticated;

create table public.hotel_stays (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  property text not null check (length(btrim(property)) between 1 and 120),
  brand text check (brand is null or length(brand) <= 80),
  city text not null check (length(btrim(city)) between 1 and 80),
  country text not null check (length(btrim(country)) between 1 and 80),
  stars smallint check (stars between 1 and 5),
  room text check (room is null or length(room) <= 120),
  check_in date not null,
  check_out date,
  rate_amount numeric(12,2) check (rate_amount >= 0),          -- nightly, incl. taxes and fees, original currency
  rate_currency text not null default 'ZAR' check (rate_currency ~ '^[A-Z]{3}$'),
  rate_zar numeric(12,2) check (rate_zar >= 0),                -- optional conversion when the currency is not ZAR
  rate_zar_on date,                                            -- date of that conversion
  inclusions text check (inclusions is null or length(inclusions) <= 200),
  score_design numeric(3,1) check (score_design between 0 and 10),          -- weight 20
  score_location numeric(3,1) check (score_location between 0 and 10),      -- weight 15
  score_amenities numeric(3,1) check (score_amenities between 0 and 10),    -- weight 10
  score_facilities numeric(3,1) check (score_facilities between 0 and 10),  -- weight 15
  score_service numeric(3,1) check (score_service between 0 and 10),        -- weight 20
  score_experience numeric(3,1) check (score_experience between 0 and 10),  -- weight 20
  highlight text check (highlight is null or length(highlight) <= 1000),
  improve text check (improve is null or length(improve) <= 1000),
  status text not null default 'final' check (status in ('draft','final')),
  rubric_version text not null default 'v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_stays_dates check (check_out is null or check_out >= check_in)
);
create index hotel_stays_check_in_idx on public.hotel_stays (check_in desc);
create index hotel_stays_owner_idx on public.hotel_stays (owner_id);

create or replace function public.hotel_stays_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger hotel_stays_touch before update on public.hotel_stays
  for each row execute function public.hotel_stays_touch();

alter table public.hotel_stays enable row level security;

create policy hotel_stays_read_final on public.hotel_stays
  for select to anon, authenticated
  using (status = 'final');
create policy hotel_stays_read_editor on public.hotel_stays
  for select to authenticated
  using ((select public.is_hotel_rating_editor()));
create policy hotel_stays_insert_editor on public.hotel_stays
  for insert to authenticated
  with check ((select public.is_hotel_rating_editor()) and owner_id = (select auth.uid()));
create policy hotel_stays_update_editor on public.hotel_stays
  for update to authenticated
  using ((select public.is_hotel_rating_editor()))
  with check ((select public.is_hotel_rating_editor()));
create policy hotel_stays_delete_editor on public.hotel_stays
  for delete to authenticated
  using ((select public.is_hotel_rating_editor()));

revoke all on public.hotel_stays from anon, authenticated;
grant select on public.hotel_stays to anon;
grant select, insert, update, delete on public.hotel_stays to authenticated;
