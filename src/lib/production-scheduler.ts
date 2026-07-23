import type { Part, Machine, PlanConfig, ProductionPlanItem, TimeWindow } from './types';

export interface SchedulerInput {
  partsData: Part[];
  machinesData: Machine[];
  productionShiftDuration: number;
  breakTime?: { start: number; end: number };
  freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  elapsedTimeSinceShiftStart?: number;
  currentProductionPlan?: { productionPlan: ProductionPlanItem[]; summary: string };
  historicalProductionData?: string;
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

export function parseMachineCapacity(machineName: string): number {
  const match = machineName.match(/(\d+)T/);
  return match ? parseInt(match[1], 10) : 0;
}

export function getDieRemovalTime(capacity: number): number {
  return capacity <= 50 ? 10 : 15;
}

/**
 * Merge overlapping or adjacent time windows
 */
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

/**
 * Build all unavailable time windows for a machine (downtime, break, constraints)
 */
export function buildMachineUnavailableWindows(
  machine: Machine,
  shiftDuration: number,
  breakTime?: { start: number; end: number },
  freeUpConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>
): TimeWindow[] {
  const rawWindows: TimeWindow[] = [];

  if (!machine.available) {
    rawWindows.push({ start: 0, end: shiftDuration });
    return rawWindows;
  }

  if (machine.downtimeDuration && machine.downtimeDuration > 0) {
    rawWindows.push({ start: 0, end: machine.downtimeDuration });
  }

  if (breakTime && breakTime.start < breakTime.end) {
    if (breakTime.start < shiftDuration && breakTime.end > 0) {
      rawWindows.push({
        start: Math.max(0, breakTime.start),
        end: Math.min(shiftDuration, breakTime.end),
      });
    }
  }

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

/**
 * Given a start time and required working duration, allocate work across available working time,
 * pausing during any unavailable windows (such as shift break 1:00 PM - 1:30 PM or downtime).
 * Returns an array of working segments: { start, end, duration }
 */
export function allocateWorkingSegments(
  desiredStart: number,
  requiredWorkingMinutes: number,
  shiftDuration: number,
  unavailableWindows: TimeWindow[]
): { segments: TimeWindow[]; finishTime: number } | null {
  if (requiredWorkingMinutes <= 0) {
    return { segments: [], finishTime: desiredStart };
  }

  let curr = Math.max(0, desiredStart);
  let remainingMinutes = requiredWorkingMinutes;
  const segments: TimeWindow[] = [];

  while (curr < shiftDuration && remainingMinutes > 0) {
    // Check if curr falls inside an unavailable window
    const blockingWin = unavailableWindows.find(w => curr >= w.start && curr < w.end);

    if (blockingWin) {
      // Pause production; jump time to end of unavailable window
      curr = blockingWin.end;
      continue;
    }

    // Find the next upcoming unavailable window after curr
    const nextWin = unavailableWindows.find(w => w.start > curr);
    const maxContinuousWork = nextWin ? Math.min(remainingMinutes, nextWin.start - curr) : remainingMinutes;

    if (maxContinuousWork <= 0) {
      if (nextWin) {
        curr = nextWin.end;
      } else {
        break;
      }
      continue;
    }

    const segEnd = curr + maxContinuousWork;
    if (segEnd > shiftDuration) {
      const actualWork = shiftDuration - curr;
      if (actualWork > 0) {
        segments.push({ start: curr, end: shiftDuration });
      }
      return null; // Truncated/incomplete
    }

    segments.push({ start: curr, end: segEnd });
    remainingMinutes -= maxContinuousWork;
    curr = segEnd;
  }

  if (remainingMinutes > 0) {
    return null; // Could not fit full duration within shift
  }

  return { segments, finishTime: curr };
}

/**
 * Calculate available machines matching or exceeding the press capacity requirement
 */
export function getSuitableMachines(requiredPress: string, machines: Machine[]): Machine[] {
  const reqCapacity = parseMachineCapacity(requiredPress);
  if (reqCapacity === 0) return [];

  return machines
    .filter(m => m.capacity >= reqCapacity)
    .sort((a, b) => a.capacity - b.capacity);
}

/**
 * Parallel Priority-Based Job Shop Production Scheduler
 */
export function runProductionScheduler(input: SchedulerInput): SchedulerOutput {
  const {
    partsData,
    machinesData,
    productionShiftDuration,
    breakTime = { start: 240, end: 270 }, // Default 1:00 PM - 1:30 PM for a 9:00 AM shift (240 to 270 mins)
    freeUpMachineConstraints,
    elapsedTimeSinceShiftStart = 0,
    currentProductionPlan,
  } = input;

  const sortedParts = [...partsData].sort((a, b) => a.priority - b.priority);

  // Build unavailable windows for each machine
  const machineUnavailableWindows = new Map<string, TimeWindow[]>();
  for (const m of machinesData) {
    machineUnavailableWindows.set(
      m.machineName,
      buildMachineUnavailableWindows(m, productionShiftDuration, breakTime, freeUpMachineConstraints)
    );
  }

  // Track availability end time for each machine (when die removal finishes)
  const machineBusyUntil = new Map<string, number>();
  for (const m of machinesData) {
    machineBusyUntil.set(m.machineName, 0);
  }

  // If adjusting plan, preserve locked tasks before elapsedTime
  const productionPlan: ProductionPlanItem[] = [];
  let globalExecutionOrder = 1;

  if (currentProductionPlan && elapsedTimeSinceShiftStart > 0) {
    const lockedWindowEnd = elapsedTimeSinceShiftStart + 15;
    const lockedTasks = currentProductionPlan.productionPlan.filter(t => t.startTime < lockedWindowEnd);

    for (const task of lockedTasks) {
      productionPlan.push({
        ...task,
        executionOrder: globalExecutionOrder++,
      });
      const busy = machineBusyUntil.get(task.machineName) || 0;
      machineBusyUntil.set(task.machineName, Math.max(busy, task.endTime));
    }
  }

  // Parallel Scheduling Data Structures
  interface CandidateCandidate {
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

  // Track state for each part
  const nextOpIndexMap = new Map<string, number>();
  const partReadyTimeMap = new Map<string, number>();
  const partTotalOpsCount = new Map<string, number>();

  for (const part of sortedParts) {
    nextOpIndexMap.set(part.id, 0);
    partReadyTimeMap.set(part.id, elapsedTimeSinceShiftStart);
    const activeOps = part.selectedOperations && part.selectedOperations.length > 0
      ? part.selectedOperations
      : part.operations;
    partTotalOpsCount.set(part.id, activeOps.length);
  }

  const pendingOperations: Array<{ partName: string; operationName: string; reason: string }> = [];

  // Loop until no more eligible operations across any part can be scheduled
  while (true) {
    let bestCandidate: CandidateCandidate | null = null;

    // Evaluate all parts that still have unassigned operations
    for (let pIdx = 0; pIdx < sortedParts.length; pIdx++) {
      const part = sortedParts[pIdx];
      const targetQty = part.quantityToProduce || 0;
      if (targetQty <= 0) continue;

      const currOpIdx = nextOpIndexMap.get(part.id) || 0;
      const activeOps = part.selectedOperations && part.selectedOperations.length > 0
        ? part.selectedOperations
        : part.operations;

      if (currOpIdx >= activeOps.length) continue; // All operations for this part scheduled

      const operation = activeOps[currOpIdx];
      const partReadyTime = partReadyTimeMap.get(part.id) || elapsedTimeSinceShiftStart;
      const actualAlreadyProduced = part.actualQuantityProduced || 0;
      const remainingQtyNeeded = Math.max(0, targetQty - actualAlreadyProduced);
      const qtyToSchedule = remainingQtyNeeded > 0 ? remainingQtyNeeded : targetQty;

      const totalProdMinutes = qtyToSchedule > 0
        ? Math.ceil((qtyToSchedule / 50) * operation.timeFor50Pcs)
        : operation.timeFor50Pcs;

      const suitableMachines = getSuitableMachines(operation.lowestPress, machinesData);

      if (suitableMachines.length === 0) {
        continue;
      }

      // Test all suitable machines for this eligible operation
      for (const candidate of suitableMachines) {
        const busyTime = machineBusyUntil.get(candidate.machineName) || 0;
        const candidateStart = Math.max(partReadyTime, busyTime);
        const windows = machineUnavailableWindows.get(candidate.machineName) || [];

        // Allocate Die Setting
        const dieAlloc = allocateWorkingSegments(candidateStart, operation.dieSettingTime, productionShiftDuration, windows);
        if (!dieAlloc) continue;

        // Allocate Production
        const prodAlloc = allocateWorkingSegments(dieAlloc.finishTime, totalProdMinutes, productionShiftDuration, windows);
        if (!prodAlloc) continue;

        // Allocate Die Removal
        const dieRemoval = getDieRemovalTime(candidate.capacity);
        const dieRemovalAlloc = allocateWorkingSegments(prodAlloc.finishTime, dieRemoval, productionShiftDuration, windows);
        const freeAfter = dieRemovalAlloc ? dieRemovalAlloc.finishTime : prodAlloc.finishTime + dieRemoval;

        // Pick candidate with earliest production completion time
        if (
          !bestCandidate ||
          prodAlloc.finishTime < bestCandidate.earliestFinish ||
          (prodAlloc.finishTime === bestCandidate.earliestFinish && part.priority < bestCandidate.part.priority)
        ) {
          bestCandidate = {
            partIndex: pIdx,
            part,
            opIndex: currOpIdx,
            operation,
            bestMachine: candidate,
            dieAlloc,
            prodAlloc,
            machineFreeAfter: freeAfter,
            earliestFinish: prodAlloc.finishTime,
          };
        }
      }
    }

    if (!bestCandidate) {
      // No more operations can be scheduled
      break;
    }

    // Schedule the winning candidate operation
    const { part, operation, bestMachine, dieAlloc, prodAlloc, machineFreeAfter, opIndex } = bestCandidate;
    const targetQty = part.quantityToProduce || 0;
    const actualAlreadyProduced = part.actualQuantityProduced || 0;
    const remainingQtyNeeded = Math.max(0, targetQty - actualAlreadyProduced);
    const qtyToSchedule = remainingQtyNeeded > 0 ? remainingQtyNeeded : targetQty;

    // 1. Add Die Setting segments
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

    // 2. Add Production segments
    const totalProdSegMins = prodAlloc.segments.reduce((s, seg) => s + (seg.end - seg.start), 0);

    for (let i = 0; i < prodAlloc.segments.length; i++) {
      const seg = prodAlloc.segments[i];
      const segMins = seg.end - seg.start;
      const segQty = i === prodAlloc.segments.length - 1
        ? qtyToSchedule - productionPlan
            .filter(p => p.partName === part.partName && p.operationName === operation.stepName && p.taskType === 'Production')
            .reduce((s, p) => s + p.quantity, 0)
        : Math.round((segMins / totalProdSegMins) * qtyToSchedule);

      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: Math.max(1, segQty),
        startTime: seg.start,
        endTime: seg.end,
        taskType: 'Production',
        executionOrder: globalExecutionOrder++,
      });
    }

    // Update state: next operation for this part can only start after prodAlloc.finishTime
    machineBusyUntil.set(bestMachine.machineName, machineFreeAfter);
    partReadyTimeMap.set(part.id, prodAlloc.finishTime);
    nextOpIndexMap.set(part.id, opIndex + 1);
  }

  // Sort final production plan chronologically for clean rendering
  productionPlan.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  productionPlan.forEach((task, idx) => {
    task.executionOrder = idx + 1;
  });

  // Check for incomplete operations
  const partCompletionStatus = new Map<string, { totalQty: number; producedQty: number; isComplete: boolean }>();

  for (const part of sortedParts) {
    const targetQty = part.quantityToProduce || 0;
    const actualAlreadyProduced = part.actualQuantityProduced || 0;
    const currScheduledOpIdx = nextOpIndexMap.get(part.id) || 0;
    const totalOps = partTotalOpsCount.get(part.id) || 0;
    const isComplete = totalOps > 0 && currScheduledOpIdx >= totalOps;

    if (!isComplete && totalOps > 0) {
      const activeOps = part.selectedOperations && part.selectedOperations.length > 0
        ? part.selectedOperations
        : part.operations;
      const unscheduledOp = activeOps[currScheduledOpIdx];
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

  // Calculate metrics
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
  const overallProgressPercentage = totalPartsRequired > 0
    ? parseFloat(((totalPartsProduced / totalPartsRequired) * 100).toFixed(1))
    : 0;

  const estimatedCompletionTimeMinutes = productionPlan.length > 0
    ? Math.max(...productionPlan.map(p => p.endTime))
    : 0;

  // Build summary string
  const summaryLines: string[] = [];
  summaryLines.push(`Generated parallel-optimized production plan with ${productionPlan.length} tasks across ${totalPartsCount} parts.`);
  summaryLines.push(`Progress: ${totalPartsProduced} / ${totalPartsRequired} units (${overallProgressPercentage}% completed).`);
  summaryLines.push(`Fully completed parts: ${fullyCompletedPartsCount} of ${totalPartsCount}.`);

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
