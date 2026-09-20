export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidDomainStateError extends DomainError {
  readonly code = 'invalid_domain_state';
}

export function assertNever(value: never): never {
  throw new InvalidDomainStateError(`Unhandled closed-state value: ${String(value)}`);
}
