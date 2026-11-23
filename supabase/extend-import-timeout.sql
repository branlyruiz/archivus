create or replace function public.archivus_import(disk_id uuid, volume_name text, entries jsonb)
returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '30s'
as $$
declare
  current_revision bigint;
  destination uuid := disk_id;
  new_entries integer := 0;
  inserted integer;
  entry_depth integer;
  deepest integer;
begin
  if jsonb_typeof(entries) is distinct from 'array' then
    raise exception 'El inventario debe incluir una lista de rutas.';
  end if;
  if jsonb_array_length(entries) not between 1 and 50000 then
    raise exception 'El inventario debe contener entre 1 y 50.000 rutas.';
  end if;

  create temporary table archivus_import_paths (
    path text primary key,
    parent_path text not null,
    name text not null,
    kind text not null,
    depth integer not null,
    resolved uuid
  ) on commit drop;

  if exists (
    select 1 from jsonb_to_recordset(entries) as input(path text, type text)
    where path is null or char_length(path) not between 1 and 4096
      or path ~ '(^|/)\.{1,2}(/|$)|(^/|//|/$)'
      or type is null or type not in ('directory', 'file')
      or char_length(regexp_replace(path, '^.*/', '')) > 255
  ) then
    raise exception 'El JSON contiene una ruta o un tipo de registro inválido.';
  end if;

  insert into pg_temp.archivus_import_paths (path, parent_path, name, kind, depth)
  select path,
    case when strpos(path, '/') = 0 then '' else regexp_replace(path, '/[^/]+$', '') end,
    regexp_replace(path, '^.*/', ''),
    case type when 'directory' then 'folder' else 'file' end,
    array_length(string_to_array(path, '/'), 1)
  from jsonb_to_recordset(entries) as input(path text, type text);

  if exists (
    select 1 from pg_temp.archivus_import_paths as child
    left join pg_temp.archivus_import_paths as parent on parent.path = child.parent_path
    where child.depth > 1 and parent.kind is distinct from 'folder'
  ) then
    raise exception 'Hay rutas cuya carpeta contenedora falta en el JSON.';
  end if;

  select max(depth) into deepest from pg_temp.archivus_import_paths;
  if deepest > 256 then raise exception 'El JSON contiene una ruta demasiado profunda.'; end if;
  create index on pg_temp.archivus_import_paths (depth);

  select value into current_revision from archivus_private.revision where singleton for update;
  if destination is null then
    volume_name := btrim(volume_name);
    if volume_name is null or char_length(volume_name) not between 1 and 120 then
      raise exception 'Escribe un nombre de disco de hasta 120 caracteres.';
    end if;
    select id into destination from archivus_private.items where parent is null and name = volume_name;
    if destination is null then
      destination := gen_random_uuid();
      insert into archivus_private.items (id, kind, name, technology, version)
      values (destination, 'disk', volume_name, 'Otro', current_revision + 1);
      new_entries := 1;
    end if;
  elsif not exists (select 1 from archivus_private.items where id = destination and kind = 'disk') then
    raise exception 'El disco de destino ya no existe.';
  end if;

  insert into pg_temp.archivus_import_paths values ('', '', '', 'disk', 0, destination);
  analyze pg_temp.archivus_import_paths;
  for entry_depth in 1..deepest loop
    insert into archivus_private.items (id, parent, kind, name, version)
    select gen_random_uuid(), parent.resolved, child.kind, child.name, current_revision + 1
    from pg_temp.archivus_import_paths as child
      join pg_temp.archivus_import_paths as parent on parent.path = child.parent_path
    where child.depth = entry_depth
    on conflict (parent, name) do nothing;
    get diagnostics inserted = row_count;
    new_entries := new_entries + inserted;

    update pg_temp.archivus_import_paths as child
    set resolved = (
      select item.id
      from archivus_private.items as item
      where item.parent = parent.resolved and item.name = child.name and item.kind = child.kind
    )
    from pg_temp.archivus_import_paths as parent
    where child.depth = entry_depth and parent.path = child.parent_path;
    if exists (select 1 from pg_temp.archivus_import_paths where depth = entry_depth and resolved is null) then
      raise exception 'Una ruta coincide con un registro de otro tipo. Revisa el destino antes de importar.';
    end if;
  end loop;

  if new_entries > 0 then
    update archivus_private.revision set value = current_revision + 1 where singleton;
  end if;
  return jsonb_build_object(
    'added', (select count(*) from archivus_private.items
              where version = current_revision + 1 and parent is not null),
    'disk', destination
  );
exception
  when unique_violation then raise exception 'El JSON contiene rutas duplicadas.';
end
$$;

notify pgrst, 'reload schema';
