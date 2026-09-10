SELECT public.sac_provision_agent(
  'autonomia', 'AutonomIA', 'atendimento', 'Atendimento AutonomIA',
  'sac_autonomia', 'sac_hom_autonomia_owner', 'sac_hom_autonomia_app',
  'sac_hom_autonomia_worker', '{}'::jsonb, NULL
);

SELECT public.sac_provision_agent(
  'dr-lucas', 'Dr. Lucas', 'atendimento', 'Atendimento Dr. Lucas',
  'sac_dr_lucas', 'sac_hom_lucas_owner', 'sac_hom_lucas_app',
  'sac_hom_lucas_worker', '{}'::jsonb, NULL
);

SELECT public.sac_provision_agent(
  'casal-do-trafego', 'Casal do Tráfego', 'atendimento', 'Atendimento Casal do Tráfego',
  'sac_casal_trafego', 'sac_hom_casal_owner', 'sac_hom_casal_app',
  'sac_hom_casal_worker', '{}'::jsonb, NULL
);

SELECT public.sac_provision_agent(
  'gramado-plazza', 'Gramado Plazza', 'atendimento', 'Atendimento Gramado Plazza',
  'sac_gramado_plazza', 'sac_hom_gramado_owner', 'sac_hom_gramado_app',
  'sac_hom_gramado_worker', '{}'::jsonb, NULL
);

SELECT public.sac_provision_agent(
  'bella-franklin', 'Bella Franklin', 'atendimento', 'Atendimento Bella Franklin',
  'sac_bella_franklin', 'sac_hom_bella_owner', 'sac_hom_bella_app',
  'sac_hom_bella_worker', '{}'::jsonb, NULL
);

INSERT INTO public.sac_channel_accounts
  (tenant_id, agent_id, id, channel, provider, external_account_id, display_name, status)
VALUES
  ('autonomia', 'atendimento', 'whatsapp-mineracao', 'whatsapp', 'meta',
   'agente24horas-readonly', 'AutonomIA · anúncios e mineração · somente leitura', 'disabled'),
  ('bella-franklin', 'atendimento', 'instagram-principal', 'instagram', 'meta',
   '17841400715053626', '@isabellafranklind · ativo Meta localizado', 'disabled');
