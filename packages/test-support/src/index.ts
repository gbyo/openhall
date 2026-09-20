import { Temporal } from '@js-temporal/polyfill';
import type { Clock } from '@openhall/domain';

export class FakeClock implements Clock {
  #instant: Temporal.Instant;

  constructor(initial: string | Temporal.Instant) {
    this.#instant = typeof initial === 'string' ? Temporal.Instant.from(initial) : initial;
  }

  now(): Temporal.Instant {
    return this.#instant;
  }

  set(instant: string | Temporal.Instant): void {
    this.#instant = typeof instant === 'string' ? Temporal.Instant.from(instant) : instant;
  }

  advance(duration: Temporal.DurationLike): void {
    this.#instant = this.#instant.add(duration);
  }
}
