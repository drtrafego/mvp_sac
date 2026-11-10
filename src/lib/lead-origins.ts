// Origens que uma pessoa pode escolher ao editar um lead (espelha
// SOURCE_OPTIONS de src/components/leads/AddLeadModal.tsx; um teste confere
// que as duas listas não divergem). O servidor não importa o componente
// porque ele é "use client".
export const EDITABLE_LEAD_SOURCES = [
  'indicacao', 'mineracao', 'meta_ads', 'instagram', 'whatsapp', 'email',
  'hotmart', 'kiwify', 'greenn', 'zouti', 'organico',
] as const
