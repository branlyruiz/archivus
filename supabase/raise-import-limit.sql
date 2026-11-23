do $migration$
declare
  definition text := pg_get_functiondef('public.archivus_import(uuid,text,jsonb)'::regprocedure);
begin
  if position('jsonb_array_length(entries) not between 1 and 100000' in definition) = 0 then
    if position('jsonb_array_length(entries) not between 1 and 50000' in definition) = 0 then
      raise exception 'La validación de importación cambió. Revisa la función antes de aplicar la migración.';
    end if;
    execute replace(
      replace(definition, 'jsonb_array_length(entries) not between 1 and 50000',
        'jsonb_array_length(entries) not between 1 and 100000'),
      'entre 1 y 50.000 rutas', 'entre 1 y 100.000 rutas');
  end if;
end
$migration$;

alter function public.archivus_import(uuid, text, jsonb) set statement_timeout = '45s';
alter function public.archivus_read(bigint) set statement_timeout = '30s';
alter function public.archivus_write(jsonb) set statement_timeout = '30s';
notify pgrst, 'reload schema';
