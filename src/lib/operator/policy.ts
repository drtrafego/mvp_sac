export function operatorCompanyIsAvailable(settings: { enabled: boolean; killSwitch: boolean } | null | undefined): boolean {
  return Boolean(settings?.enabled) && !settings?.killSwitch
}
