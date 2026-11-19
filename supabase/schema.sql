begin;

create schema if not exists archivus_private;
revoke all on schema archivus_private from public, anon, authenticated;

create table archivus_private.revision (
  singleton boolean primary key default true check (singleton),
  value bigint not null default 0
);
insert into archivus_private.revision default values;

create table archivus_private.items (
  id uuid primary key,
  parent uuid references archivus_private.items(id) on delete cascade,
  kind text not null check (kind in ('disk', 'folder')),
  name text not null check (char_length(name) between 1 and 120),
  technology text check (technology in ('HDD', 'SSD', 'Otro')),
  interface text check (char_length(interface) <= 60),
  capacity text check (char_length(capacity) <= 60),
  version bigint not null,
  check ((kind = 'disk' and parent is null and technology is not null)
    or (kind = 'folder' and parent is not null and technology is null and interface is null and capacity is null)),
  unique nulls not distinct (parent, name)
);

create function public.archivus_read(known_revision bigint default -1)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when value <> known_revision then jsonb_build_object(
    'revision', value,
    'items', (select coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
              from archivus_private.items item)
  ) end
  from archivus_private.revision where singleton
$$;

create function public.archivus_write(change jsonb)
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

  if operation in ('create', 'edit') and (item_name is null or char_length(item_name) not between 1 and 120) then
    raise exception 'Escribe un nombre de hasta 120 caracteres.';
  end if;

  if operation = 'create' and target.id is not null then
    if target.kind = item_kind
       and target.parent is not distinct from destination and target.name = item_name
       and target.technology is not distinct from disk_type
       and target.interface is not distinct from disk_interface
       and target.capacity is not distinct from disk_capacity then
      return public.archivus_read();
    end if;
    raise exception 'Este registro ya existe. Cierra esta ventana y vuelve a intentarlo.';
  end if;

  if operation = 'move' or (operation = 'create' and item_kind = 'folder') then
    if destination is null or not exists (select 1 from archivus_private.items where id = destination) then
      raise exception 'La carpeta o el disco de destino ya no existe.';
    end if;
  end if;

  case operation
    when 'create' then
      insert into archivus_private.items (id, parent, kind, name, technology, interface, capacity, version)
      values (item_id, destination, item_kind, item_name, disk_type, disk_interface, disk_capacity, current_revision + 1);
    when 'edit' then
      update archivus_private.items
      set name = item_name, technology = disk_type, interface = disk_interface,
          capacity = disk_capacity, version = current_revision + 1
      where id = item_id;
    when 'move' then
      if target.kind <> 'folder' then raise exception 'Selecciona una carpeta para mover.'; end if;
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

revoke all on function public.archivus_read(bigint) from public, anon, authenticated;
revoke all on function public.archivus_write(jsonb) from public, anon, authenticated;
grant execute on function public.archivus_read(bigint), public.archivus_write(jsonb) to anon;
commit;
