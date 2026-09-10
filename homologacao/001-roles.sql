DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'sac_hom_autonomia_owner', 'sac_hom_autonomia_app', 'sac_hom_autonomia_worker',
    'sac_hom_lucas_owner', 'sac_hom_lucas_app', 'sac_hom_lucas_worker',
    'sac_hom_casal_owner', 'sac_hom_casal_app', 'sac_hom_casal_worker',
    'sac_hom_gramado_owner', 'sac_hom_gramado_app', 'sac_hom_gramado_worker',
    'sac_hom_bella_owner', 'sac_hom_bella_app', 'sac_hom_bella_worker'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    END IF;
  END LOOP;
END
$roles$;
