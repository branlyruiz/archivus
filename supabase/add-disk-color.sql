begin;

alter table archivus_private.items
  add column color text check (color is null or (
    kind = 'disk' and color in (
      'rojo', 'naranja', 'amarillo', 'verde', 'turquesa', 'azul',
      'morado', 'rosa', 'gris', 'negro', 'blanco'
    )
  ));

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

  if operation in ('create', 'edit') and (item_name is null or char_length(item_name) not between 1 and 120) then
    raise exception 'Escribe un nombre de hasta 120 caracteres.';
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

  if operation = 'move' or (operation = 'create' and item_kind = 'folder') then
    if destination is null or not exists (select 1 from archivus_private.items where id = destination) then
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

commit;
