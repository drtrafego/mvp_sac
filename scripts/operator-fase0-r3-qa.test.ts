// Incorpora o harness adversarial recebido na rodada 3. A bateria canônica
// fica no harness de integração para não manter duas cópias divergentes dos
// mocks de autenticação, Neon HTTP e OpenRouter.
//
// Uso (fora do sandbox):
// node --require ./scripts/operator-server-only-register.cjs --experimental-test-module-mocks --import tsx --test scripts/operator-fase0-r3-qa.test.ts

import './operator-fase0-integration.test'
