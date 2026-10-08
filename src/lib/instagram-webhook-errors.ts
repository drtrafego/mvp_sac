// Shared error type for tenant resolution. Route modules only export HTTP handlers/config.
export class AmbiguousCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmbiguousCredentialError'
  }
}
