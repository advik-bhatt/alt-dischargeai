/**
 * The app clock. Every timestamp the backend produces or compares comes from here, so the judge can
 * watch day 30 arrive with POST /admin/clock/advance instead of waiting a month.
 */
export class Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Epoch seconds, the unit DynamoDB TTL expects. */
  nowEpochSeconds(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  advanceDays(days: number): void {
    this.offsetMs += days * 24 * 60 * 60 * 1000;
  }

  advanceMs(ms: number): void {
    this.offsetMs += ms;
  }

  reset(): void {
    this.offsetMs = 0;
  }

  get offsetDays(): number {
    return this.offsetMs / (24 * 60 * 60 * 1000);
  }
}
