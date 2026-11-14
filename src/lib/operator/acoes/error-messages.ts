// Códigos permanecem nos recibos para diagnóstico, com texto legível na tela.
const messages: Record<string, string> = {
  CONFLICT: 'O registro mudou depois. Faça um novo pedido.',
  INVALID_NOTE: 'A nota é inválida. Confira o texto e o tamanho.',
  INVALID_ALIAS: 'O apelido deve ter até 40 caracteres.',
  GATE_CLOSED: 'Esta ação não está mais liberada para a empresa.',
  ACTION_NOT_ALLOWED: 'Esta ação não está liberada para a empresa.',
  JOB_TIMEOUT: 'O pedido expirou. Confira as ações registradas.',
  CLARIFICATION_EXPIRED: 'O prazo para escolher venceu. Faça um novo pedido.',
  CONFIRMATION_EXPIRED: 'O prazo para confirmar venceu.',
  CLARIFICATION_REQUIRED: 'Escolha uma das opções para continuar.',
  CLARIFICATION_FAILED: 'Não foi possível aplicar a escolha. Faça um novo pedido.',
  ANTERIOR_FALHOU: 'Uma ação anterior falhou. Esta ação não foi aplicada.',
  OPERATOR_INCONSISTENT: 'O registro mudou durante a operação. Confira o resultado.',
  EXECUTION_FAILED: 'Não foi possível aplicar a ação.',
  DAILY_JOBS_LIMIT: 'O limite diário de pedidos foi atingido.',
  DAILY_TOKEN_BUDGET: 'O orçamento diário foi atingido.',
  cancelado: 'Ação cancelada.',
  pendente: 'Ação pendente.',
}
export function mensagemErro(code: string) {
  return messages[code] ?? 'Não foi possível concluir a operação. Confira o pedido e tente novamente.'
}
