begin;

alter table archivus_private.items
  drop constraint items_kind_check,
  drop constraint items_name_check,
  drop constraint items_check,
  add constraint items_kind_check check (kind in ('disk', 'folder', 'file')),
  add constraint items_name_check check (char_length(name) between 1 and case when kind = 'disk' then 120 else 255 end),
  add constraint items_check check (
    (kind = 'disk' and parent is null and technology is not null)
    or (kind in ('folder', 'file') and parent is not null and technology is null and interface is null and capacity is null)
  );

create or replace function public.archivus_write(change jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  operation text := change->>'action';
  item_id uuid := (change->>'id')::uuid;
  destination uuid := (change->>'parent')::uuid;
  item_name text := btrim(change->>'name');
  item_kind text := change->>'kind';
  disk_type text := change->>'technology';
  disk_interface text := nullif(btrim(change->>'interface'), '');
  disk_capacity text := nullif(btrim(change->>'capacity'), '');
  disk_color text := nullif(change->>'color', '');
  target archivus_private.items%rowtype;
  current_revision bigint;
begin
  -- Serializing writes keeps cycle checks, confirmations and snapshots consistent.
  select value into current_revision from archivus_private.revision where singleton for update;

  if operation is null or operation not in ('create', 'edit', 'move', 'delete') or item_id is null then
    raise exception 'La operación no es válida.';
  end if;

  select * into target from archivus_private.items where id = item_id;
  if operation <> 'create' and (target.id is null or target.version is distinct from (change->>'version')::bigint) then
    raise exception 'Este registro cambió en otro dispositivo. Cierra esta ventana y vuelve a intentarlo.';
  end if;

  if operation in ('create', 'edit') and (item_name is null or char_length(item_name) not between 1 and case when coalesce(target.kind, item_kind) = 'file' then 255 when coalesce(target.kind, item_kind) = 'folder' then 255 else 120 end) then
    raise exception 'Revisa la longitud del nombre del registro.';
  end if;

  if operation = 'create' and target.id is not null then
    if target.kind = item_kind
       and target.parent is not distinct from destination and target.name = item_name
       and target.technology is not distinct from disk_type
       and target.interface is not distinct from disk_interface
       and target.capacity is not distinct from disk_capacity
       and (not (change ? 'color') or target.color is not distinct from disk_color) then
      return public.archivus_read();
    end if;
    raise exception 'Este registro ya existe. Cierra esta ventana y vuelve a intentarlo.';
  end if;

  if operation = 'move' or (operation = 'create' and item_kind in ('folder', 'file')) then
    if destination is null or not exists (select 1 from archivus_private.items where id = destination and kind in ('disk', 'folder')) then
      raise exception 'La carpeta o el disco de destino ya no existe.';
    end if;
  end if;

  case operation
    when 'create' then
      insert into archivus_private.items (id, parent, kind, name, technology, interface, capacity, color, version)
      values (item_id, destination, item_kind, item_name, disk_type, disk_interface, disk_capacity, disk_color, current_revision + 1);
    when 'edit' then
      update archivus_private.items
      set name = item_name, technology = disk_type, interface = disk_interface,
          capacity = disk_capacity, color = case when change ? 'color' then disk_color else target.color end,
          version = current_revision + 1
      where id = item_id;
    when 'move' then
      if target.kind = 'disk' then raise exception 'Selecciona una carpeta o un archivo para mover.'; end if;
      if exists (
        with recursive lineage as (
          select id, parent from archivus_private.items where id = destination
          union all
          select item.id, item.parent from archivus_private.items item join lineage on item.id = lineage.parent
        )
        select 1 from lineage where id = item_id
      ) then
        raise exception 'Una carpeta no puede moverse dentro de sí misma ni de sus subcarpetas.';
      end if;
      update archivus_private.items set parent = destination, version = current_revision + 1 where id = item_id;
    when 'delete' then
      if current_revision is distinct from (change->>'revision')::bigint then
        raise exception 'El inventario cambió. Cierra esta ventana y revisa de nuevo qué se eliminará.';
      end if;
      delete from archivus_private.items where id = item_id;
  end case;

  update archivus_private.revision set value = current_revision + 1 where singleton;
  return public.archivus_read();
exception
  when unique_violation then raise exception 'Ya hay un registro con ese nombre en esta ubicación.';
  when check_violation or not_null_violation then raise exception 'Revisa el tipo y las especificaciones del registro.';
end
$$;

create function public.archivus_import(disk_id uuid, volume_name text, entries jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
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
    set resolved = item.id
    from pg_temp.archivus_import_paths as parent
      join archivus_private.items as item on item.parent = parent.resolved
    where child.depth = entry_depth and parent.path = child.parent_path
      and item.name = child.name and item.kind = child.kind;
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

revoke all on function public.archivus_import(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.archivus_import(uuid, text, jsonb) to anon;

commit;
