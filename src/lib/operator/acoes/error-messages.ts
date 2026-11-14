// Códigos permanecem nos recibos para diagnóstico, com texto legível na tela.
const messages: Record<string, string> = {
  RULE_EXISTS: 'Já existe uma regra com essa palavra. Peça para editar ou ativar a existente.',
  RULE_SHADOWED: 'Outra regra tem prioridade. Confira as regras existentes.',
  PROTECTED_RULE: 'Essa regra só pode ser desativada pelo operador.',
  INVALID_KEYWORD: 'Escolha uma palavra menos comum, sem vírgula e com até 60 caracteres.',
  INVALID_LINK: 'Use um endereço HTTPS público, sem credenciais.',
  INVALID_MESSAGE: 'Confira o texto da mensagem e o limite de 1.500 caracteres.',
  LINK_DOMAIN_NOT_ALLOWED: 'O domínio do link não está liberado para esta empresa.',
  LINK_NOT_FROM_USER: 'O link precisa vir do pedido humano.',
  DAILY_RULE_LIMIT: 'O limite diário de criação de regras foi atingido.',
  BUSY: 'Outra alteração de regras está em andamento. Tente novamente em instantes.',
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
