begin;

create table archivus_private.sync_baseline (
  singleton boolean primary key default true check (singleton),
  revision bigint not null
);
alter table archivus_private.sync_baseline enable row level security;
insert into archivus_private.sync_baseline (revision)
select value from archivus_private.revision where singleton;

create table archivus_private.deleted_items (
  id uuid primary key,
  version bigint not null
);
alter table archivus_private.deleted_items enable row level security;
create index archivus_items_sync_order on archivus_private.items (version, id);
create index archivus_deleted_sync_order on archivus_private.deleted_items (version, id);

create function archivus_private.track_deleted_items()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  insert into archivus_private.deleted_items (id, version)
  select removed.id, revision.value + 1
  from deleted_rows removed
  cross join archivus_private.revision revision where revision.singleton
  on conflict (id) do update set version = excluded.version;
  return null;
end
$$;

create trigger archivus_track_deletions
after delete on archivus_private.items
referencing old table as deleted_rows
for each statement execute function archivus_private.track_deleted_items();

create function public.archivus_sync(
  known_revision bigint default -1,
  target_revision bigint default null,
  cursor_version bigint default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = '' set statement_timeout = '20s'
as $$
declare
  latest bigint;
  cutoff bigint;
  base bigint;
  minimum bigint;
  page jsonb;
begin
  select value into latest from archivus_private.revision where singleton;
  select revision into minimum from archivus_private.sync_baseline where singleton;

  if target_revision is null and known_revision = latest then return null; end if;
  if target_revision > latest or (target_revision is not null and target_revision < minimum) then
    return jsonb_build_object('restart', true);
  end if;

  cutoff := coalesce(target_revision, latest);
  base := case when known_revision between minimum and cutoff then known_revision else -1 end;

  with active as (
    select item.id, item.version, to_jsonb(item) as record
    from archivus_private.items item
    where item.version > base and item.version <= cutoff
      and (item.version, item.id) > (
        coalesce(cursor_version, -1), coalesce(cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
    order by item.version, item.id limit 2001
  ), removed as (
    select gone.id, gone.version, null::jsonb as record
    from archivus_private.deleted_items gone
    where base >= 0 and gone.version > base and gone.version <= cutoff
      and (gone.version, gone.id) > (
        coalesce(cursor_version, -1), coalesce(cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
    order by gone.version, gone.id limit 2001
  ), ordered as (
    select * from active
    union all
    select * from removed
    order by version, id limit 2001
  ), payload as (
    select * from ordered order by version, id limit 2000
  )
  select jsonb_build_object(
    'from', base, 'revision', cutoff, 'latest', latest,
    'records', coalesce((select jsonb_agg(jsonb_build_array(id, record) order by version, id) from payload), '[]'::jsonb),
    'cursor', case when (select count(*) from ordered) > 2000 then
      (select jsonb_build_array(version, id) from payload order by version desc, id desc limit 1)
    end
  ) into page;

  return page;
end
$$;

revoke all on function public.archivus_sync(bigint,bigint,bigint,uuid) from public, anon, authenticated;
grant execute on function public.archivus_sync(bigint,bigint,bigint,uuid) to anon;

-- Existing installed clients can still request the previous response format.
do $migration$
declare
  definition text := pg_get_functiondef('public.archivus_write(jsonb)'::regprocedure);
begin
  if position('return public.archivus_read();' in definition) = 0 then
    raise exception 'Revisa la respuesta de archivus_write antes de aplicar la migración.';
  end if;
  execute replace(definition, 'return public.archivus_read();',
    'if change->>''sync_only'' = ''true'' then return jsonb_build_object(''saved'', true); end if;
  return public.archivus_read();');
end
$migration$;

notify pgrst, 'reload schema';
commit;
