// Valores públicos, sintéticos e exclusivos do ambiente descartável.
export const sessionSecret = 'e2e-only-not-a-production-secret'
export const tenants = {
  alpha: { id: 91001, userId: 'e2e-alpha', slug: 'e2e-alpha', leadId: 92001, name: 'Lead Sintético Alpha' },
  beta: { id: 91002, userId: 'e2e-beta', slug: 'e2e-beta', leadId: 92002, name: 'Lead Sintético Beta' },
} as const
