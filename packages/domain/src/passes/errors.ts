import { DomainError } from '../errors.js';
import type { PassLifecycleState } from './lifecycle.js';

export class InvalidPassTransitionError extends DomainError {
  readonly code = 'invalid_pass_transition';

  constructor(
    readonly from: PassLifecycleState,
    readonly to: PassLifecycleState,
  ) {
    super(`Invalid pass transition from ${from} to ${to}`);
  }
}
