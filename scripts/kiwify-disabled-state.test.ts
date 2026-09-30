import { runProviderDisabledStateTests } from './provider-disabled-state.test-helper'

runProviderDisabledStateTests('kiwify').catch(error => {
  console.error(error)
  process.exitCode = 1
})
