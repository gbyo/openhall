import type { DestinationFlowReconciler } from '@openhall/application';

/**
 * Small polling loop for the room-flow reconciler. The database stays
 * the durable work source and the reconciler is safe across replicas, so
 * this loop only sets how often the worker looks for pre-departure expiries
 * and queue promotions. Tests invoke runOne/runBatch directly instead.
 */
export interface DestinationFlowWorker {
  stop(): void;
}

export function startDestinationFlowWorker(
  reconciler: DestinationFlowReconciler,
  pollMs: number,
  onError?: (error: unknown) => void,
): DestinationFlowWorker {
  let stopped = false;
  let active = false;
  const timer = setInterval(() => {
    if (stopped || active) return;
    active = true;
    reconciler
      .runBatch(25)
      .catch((error: unknown) => {
        if (onError) {
          onError(error);
        }
      })
      .finally(() => {
        active = false;
      });
  }, pollMs);
  // A slow tick must never keep the process alive on its own.
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
