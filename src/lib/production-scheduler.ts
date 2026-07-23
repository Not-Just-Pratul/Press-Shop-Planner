import type { Part, Machine, ProductionPlanItem, TimeWindow } from './types';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SchedulerInput {
  partsData: Part[];
  machinesData: Machine[];
  productionShiftDuration: number;
  breakTime?: { start: number; end: number };
  freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  elapsedTimeSinceShiftStart?: number;
  currentProductionPlan?: { productionPlan: ProductionPlanItem[]; summary: string };
}

export interface SchedulerOutput {
  productionPlan: ProductionPlanItem[];
  summary: string;
  metrics: {
    totalPartsRequired: number;
    totalPartsProduced: number;
    totalPartsRemaining: number;
    fullyCompletedPartsCount: number;
    totalPartsCount: number;
    incompletePartsCount: number;
    overallProgressPercentage: number;
    estimatedCompletionTimeMinutes: number;
    pendingOperations: Array<{ partName: string; operationName: string; reason: string }>;
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Extract numeric capacity from a machine name like "200T Press" → 200 */
export function parseMachineCapacity(machineName: string): number {
  const match = machineName.match(/(\d+)T/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Die removal time: 10 mins for ≤50T machines, 15 mins for >50T */
export function getDieRemovalTime(capacity: number): number {
  return capacity <= 50 ? 10 : 15;
}

/** Merge overlapping or adjacent time windows into non-overlapping set */
export function mergeTimeWindows(windows: TimeWindow[]): TimeWindow[] {
  if (windows.length <= 1) return windows;

  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeWindow[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];

    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Machine unavailability windows
// ---------------------------------------------------------------------------

/**
 * Build all unavailable time windows for a machine (downtime, break, constraints).
 * Returns a merged, sorted array of non-overlapping TimeWindows.
 */
export function buildMachineUnavailableWindows(
  machine: Machine,
  shiftDuration: number,
  breakTime?: { start: number; end: number },
  freeUpConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>,
): TimeWindow[] {
  const rawWindows: TimeWindow[] = [];

  // Machine completely offline for entire shift
  if (!machine.available) {
    rawWindows.push({ start: 0, end: shiftDuration });
    return rawWindows;
  }

  // Machine starts with downtime
  if (machine.downtimeDuration && machine.downtimeDuration > 0) {
    rawWindows.push({ start: 0, end: machine.downtimeDuration });
  }

  // Break window (e.g. 1:00 PM – 1:30 PM)
  if (breakTime && breakTime.start < breakTime.end) {
    if (breakTime.start < shiftDuration && breakTime.end > 0) {
      rawWindows.push({
        start: Math.max(0, breakTime.start),
        end: Math.min(shiftDuration, breakTime.end),
      });
    }
  }

  // Free-up constraints – machine blocked during specific windows
  if (freeUpConstraints) {
    for (const c of freeUpConstraints) {
      if (c.machineName === machine.machineName && c.startTime < c.endTime) {
        rawWindows.push({
          start: Math.max(0, c.startTime),
          end: Math.min(shiftDuration, c.endTime),
        });
      }
    }
  }

  return mergeTimeWindows(rawWindows);
}

// ---------------------------------------------------------------------------
// Working segment allocation
// ---------------------------------------------------------------------------

/**
 * Given a desired start time and required working duration, allocate work across
 * available time, pausing during any unavailable windows (e.g. break 1:00–1:30 PM).
 *
 * @returns Array of working segments and the finish time, or null if the work
 *          cannot fit within the remaining shift.
 */
export function allocateWorkingSegments(
  desiredStart: number,
  requiredWorkingMinutes: number,
  shiftDuration: number,
  unavailableWindows: TimeWindow[],
): { segments: TimeWindow[]; finishTime: number } | null {
  if (requiredWorkingMinutes <= 0) {
    return { segments: [], finishTime: desiredStart };
  }

  let cursor = Math.max(0, desiredStart);
  let remainingMinutes = requiredWorkingMinutes;
  const segments: TimeWindow[] = [];

  while (cursor < shiftDuration && remainingMinutes > 0) {
    // Skip if cursor is inside an unavailable window
    const blockingWindow = unavailableWindows.find(w => cursor >= w.start && cursor < w.end);
    if (blockingWindow) {
      cursor = blockingWindow.end;
      continue;
    }

    // Find the next unavailable window after cursor
    const nextWindow = unavailableWindows.find(w => w.start > cursor);
    const maxContinuousWork = nextWindow
      ? Math.min(remainingMinutes, nextWindow.start - cursor)
      : remainingMinutes;

    if (maxContinuousWork <= 0) {
      cursor = nextWindow ? nextWindow.end : shiftDuration;
      continue;
    }

    const segmentEnd = cursor + maxContinuousWork;

    // Segment exceeds shift end – truncate and report incomplete
    if (segmentEnd > shiftDuration) {
      const actualWork = shiftDuration - cursor;
      if (actualWork > 0) {
        segments.push({ start: cursor, end: shiftDuration });
      }
      return null;
    }

    segments.push({ start: cursor, end: segmentEnd });
    remainingMinutes -= maxContinuousWork;
    cursor = segmentEnd;
  }

  // Could not fit full duration within shift
  if (remainingMinutes > 0) {
    return null;
  }

  return { segments, finishTime: cursor };
}

// ---------------------------------------------------------------------------
// Machine suitability
// ---------------------------------------------------------------------------

/** Return machines that meet or exceed the required press capacity, sorted ascending */
export function getSuitableMachines(requiredPress: string, machines: Machine[]): Machine[] {
  const requiredCapacity = parseMachineCapacity(requiredPress);
  if (requiredCapacity === 0) return [];

  return machines
    .filter(m => m.capacity >= requiredCapacity)
    .sort((a, b) => a.capacity - b.capacity);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScheduleCandidate {
  partIndex: number;
  part: Part;
  opIndex: number;
  operation: Part['operations'][0];
  bestMachine: Machine;
  dieAlloc: { segments: TimeWindow[]; finishTime: number };
  prodAlloc: { segments: TimeWindow[]; finishTime: number };
  machineFreeAfter: number;
  earliestFinish: number;
}

// ---------------------------------------------------------------------------
// Main scheduler
// ---------------------------------------------------------------------------

/**
 * Parallel Priority-Based Job Shop Production Scheduler.
 *
 * Dispatches operations across available machines using an event-driven
 * approach that maximises machine utilisation while respecting:
 *   - Per-part operation sequence (Op N must complete before Op N+1)
 *   - Break windows (all machines pause during break)
 *   - Machine downtime and free-up constraints
 *   - Priority ordering of parts
 */
export function runProductionScheduler(input: SchedulerInput): SchedulerOutput {
  const {
    partsData,
    machinesData,
    productionShiftDuration,
    breakTime = { start: 240, end: 270 }, // Default 1:00 PM – 1:30 PM (for 9:00 AM shift)
    freeUpMachineConstraints,
    elapsedTimeSinceShiftStart = 0,
    currentProductionPlan,
  } = input;

  const sortedParts = [...partsData].sort((a, b) => a.priority - b.priority);

  // ---- Build unavailable windows for each machine ----
  const machineUnavailableWindows = new Map<string, TimeWindow[]>();
  for (const machine of machinesData) {
    machineUnavailableWindows.set(
      machine.machineName,
      buildMachineUnavailableWindows(machine, productionShiftDuration, breakTime, freeUpMachineConstraints),
    );
  }

  // ---- Track when each machine becomes free ----
  const machineBusyUntil = new Map<string, number>();
  for (const machine of machinesData) {
    machineBusyUntil.set(machine.machineName, 0);
  }

  // ---- Preserve locked tasks when adjusting an existing plan ----
  const productionPlan: ProductionPlanItem[] = [];
  let globalExecutionOrder = 1;

  if (currentProductionPlan && elapsedTimeSinceShiftStart > 0) {
    const lockedWindowEnd = elapsedTimeSinceShiftStart + 15;
    const lockedTasks = currentProductionPlan.productionPlan.filter(
      t => t.startTime < lockedWindowEnd,
    );

    for (const task of lockedTasks) {
      productionPlan.push({ ...task, executionOrder: globalExecutionOrder++ });
      const busy = machineBusyUntil.get(task.machineName) || 0;
      machineBusyUntil.set(task.machineName, Math.max(busy, task.endTime));
    }
  }

  // ---- Per-part scheduling state ----
  const nextOpIndexMap = new Map<string, number>();
  const partReadyTimeMap = new Map<string, number>();
  const partTotalOpsCount = new Map<string, number>();

  for (const part of sortedParts) {
    nextOpIndexMap.set(part.id, 0);
    partReadyTimeMap.set(part.id, elapsedTimeSinceShiftStart);

    const activeOps =
      part.selectedOperations && part.selectedOperations.length > 0
        ? part.selectedOperations
        : part.operations;
    partTotalOpsCount.set(part.id, activeOps.length);
  }

  const pendingOperations: Array<{ partName: string; operationName: string; reason: string }> = [];

  // ---- Greedy dispatch loop ----
  while (true) {
    let bestCandidate: ScheduleCandidate | null = null;

    for (let pIdx = 0; pIdx < sortedParts.length; pIdx++) {
      const part = sortedParts[pIdx];
      const targetQty = part.quantityToProduce || 0;
      if (targetQty <= 0) continue;

      const currentOpIndex = nextOpIndexMap.get(part.id) || 0;
      const activeOps =
        part.selectedOperations && part.selectedOperations.length > 0
          ? part.selectedOperations
          : part.operations;

      // All operations for this part already scheduled
      if (currentOpIndex >= activeOps.length) continue;

      const operation = activeOps[currentOpIndex];
      const partReadyTime = partReadyTimeMap.get(part.id) || elapsedTimeSinceShiftStart;
      const actualAlreadyProduced = part.actualQuantityProduced || 0;
      const remainingQty = Math.max(0, targetQty - actualAlreadyProduced);
      const qtyToSchedule = remainingQty > 0 ? remainingQty : targetQty;

      const totalProdMinutes =
        qtyToSchedule > 0
          ? Math.ceil((qtyToSchedule / 50) * operation.timeFor50Pcs)
          : operation.timeFor50Pcs;

      const suitableMachines = getSuitableMachines(operation.lowestPress, machinesData);
      if (suitableMachines.length === 0) continue;

      // Evaluate each suitable machine for this operation
      for (const candidateMachine of suitableMachines) {
        const busyUntil = machineBusyUntil.get(candidateMachine.machineName) || 0;
        const candidateStart = Math.max(partReadyTime, busyUntil);
        const windows = machineUnavailableWindows.get(candidateMachine.machineName) || [];

        // Allocate die setting
        const dieAlloc = allocateWorkingSegments(
          candidateStart, operation.dieSettingTime, productionShiftDuration, windows,
        );
        if (!dieAlloc) continue;

        // Allocate production
        const prodAlloc = allocateWorkingSegments(
          dieAlloc.finishTime, totalProdMinutes, productionShiftDuration, windows,
        );
        if (!prodAlloc) continue;

        // Allocate die removal (non-blocking – machine just becomes busy)
        const dieRemoval = getDieRemovalTime(candidateMachine.capacity);
        const dieRemovalAlloc = allocateWorkingSegments(
          prodAlloc.finishTime, dieRemoval, productionShiftDuration, windows,
        );
        const freeAfter = dieRemovalAlloc
          ? dieRemovalAlloc.finishTime
          : prodAlloc.finishTime + dieRemoval;

        // Pick candidate with earliest production finish (ties broken by priority)
        if (
          !bestCandidate ||
          prodAlloc.finishTime < bestCandidate.earliestFinish ||
          (prodAlloc.finishTime === bestCandidate.earliestFinish &&
            part.priority < bestCandidate.part.priority)
        ) {
          bestCandidate = {
            partIndex: pIdx,
            part,
            opIndex: currentOpIndex,
            operation,
            bestMachine: candidateMachine,
            dieAlloc,
            prodAlloc,
            machineFreeAfter: freeAfter,
            earliestFinish: prodAlloc.finishTime,
          };
        }
      }
    }

    // No more operations can be scheduled
    if (!bestCandidate) break;

    // ---- Commit the winning candidate ----
    const { part, operation, bestMachine, dieAlloc, prodAlloc, machineFreeAfter, opIndex } =
      bestCandidate;
    const targetQty = part.quantityToProduce || 0;
    const actualAlreadyProduced = part.actualQuantityProduced || 0;
    const remainingQty = Math.max(0, targetQty - actualAlreadyProduced);
    const qtyToSchedule = remainingQty > 0 ? remainingQty : targetQty;

    // Add die setting segments
    for (const seg of dieAlloc.segments) {
      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: 0,
        startTime: seg.start,
        endTime: seg.end,
        taskType: 'Die Setting',
        executionOrder: globalExecutionOrder++,
      });
    }

    // Add production segments (distribute quantity proportionally across segments)
    const totalProdSegMins = prodAlloc.segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    let producedSoFar = 0;

    for (let i = 0; i < prodAlloc.segments.length; i++) {
      const seg = prodAlloc.segments[i];
      const segMins = seg.end - seg.start;
      const isLastSegment = i === prodAlloc.segments.length - 1;

      const segQty = isLastSegment
        ? qtyToSchedule - producedSoFar
        : Math.round((segMins / totalProdSegMins) * qtyToSchedule);

      const finalQty = Math.max(1, segQty);
      producedSoFar += finalQty;

      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: finalQty,
        startTime: seg.start,
        endTime: seg.end,
        taskType: 'Production',
        executionOrder: globalExecutionOrder++,
      });
    }

    // Update scheduling state
    machineBusyUntil.set(bestMachine.machineName, machineFreeAfter);
    partReadyTimeMap.set(part.id, prodAlloc.finishTime);
    nextOpIndexMap.set(part.id, opIndex + 1);
  }

  // ---- Sort plan chronologically and reassign execution orders ----
  productionPlan.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  productionPlan.forEach((task, idx) => {
    task.executionOrder = idx + 1;
  });

  // ---- Identify incomplete operations ----
  const partCompletionStatus = new Map<
    string,
    { totalQty: number; producedQty: number; isComplete: boolean }
  >();

  for (const part of sortedParts) {
    const targetQty = part.quantityToProduce || 0;
    const actualAlreadyProduced = part.actualQuantityProduced || 0;
    const scheduledOpIndex = nextOpIndexMap.get(part.id) || 0;
    const totalOps = partTotalOpsCount.get(part.id) || 0;
    const isComplete = totalOps > 0 && scheduledOpIndex >= totalOps;

    if (!isComplete && totalOps > 0) {
      const activeOps =
        part.selectedOperations && part.selectedOperations.length > 0
          ? part.selectedOperations
          : part.operations;
      const unscheduledOp = activeOps[scheduledOpIndex];
      if (unscheduledOp) {
        pendingOperations.push({
          partName: part.partName,
          operationName: unscheduledOp.stepName,
          reason: `Could not fit operation within shift duration (${productionShiftDuration} mins)`,
        });
      }
    }

    partCompletionStatus.set(part.id, {
      totalQty: targetQty,
      producedQty: isComplete ? targetQty : actualAlreadyProduced,
      isComplete,
    });
  }

  // ---- Calculate summary metrics ----
  let totalPartsRequired = 0;
  let totalPartsProduced = 0;
  let fullyCompletedPartsCount = 0;

  partCompletionStatus.forEach((status) => {
    totalPartsRequired += status.totalQty;
    totalPartsProduced += status.producedQty;
    if (status.isComplete) fullyCompletedPartsCount++;
  });

  const totalPartsCount = sortedParts.length;
  const incompletePartsCount = totalPartsCount - fullyCompletedPartsCount;
  const totalPartsRemaining = Math.max(0, totalPartsRequired - totalPartsProduced);
  const overallProgressPercentage =
    totalPartsRequired > 0
      ? parseFloat(((totalPartsProduced / totalPartsRequired) * 100).toFixed(1))
      : 0;

  const estimatedCompletionTimeMinutes =
    productionPlan.length > 0 ? Math.max(...productionPlan.map(p => p.endTime)) : 0;

  // ---- Build summary string ----
  const summaryLines: string[] = [
    `Generated parallel-optimized production plan with ${productionPlan.length} tasks across ${totalPartsCount} parts.`,
    `Progress: ${totalPartsProduced} / ${totalPartsRequired} units (${overallProgressPercentage}% completed).`,
    `Fully completed parts: ${fullyCompletedPartsCount} of ${totalPartsCount}.`,
  ];

  if (pendingOperations.length > 0) {
    summaryLines.push(`Pending/Delayed operations: ${pendingOperations.length}.`);
  }

  return {
    productionPlan,
    summary: summaryLines.join(' '),
    metrics: {
      totalPartsRequired,
      totalPartsProduced,
      totalPartsRemaining,
      fullyCompletedPartsCount,
      totalPartsCount,
      incompletePartsCount,
      overallProgressPercentage,
      estimatedCompletionTimeMinutes,
      pendingOperations,
    },
  };
}
