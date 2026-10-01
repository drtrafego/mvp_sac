import { runProviderDisabledStateTests } from './provider-disabled-state.test-helper'

runProviderDisabledStateTests('greenn').catch(error => {
  console.error(error)
  process.exitCode = 1
})
