import { runProviderDisabledStateTests } from './provider-disabled-state.test-helper'

runProviderDisabledStateTests('zouti').catch(error => {
  console.error(error)
  process.exitCode = 1
})
