import type { Part, Machine, ProductionPlanItem, TimeWindow, PartScheduleStatus } from './types';

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
  partStatuses: PartScheduleStatus[];
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

interface OperationAssignment {
  part: Part;
  partIndex: number;
  opIndex: number;
  operation: Part['operations'][0];
  targetQty: number;
  bestMachine: Machine;
  dieAlloc: { segments: TimeWindow[]; finishTime: number };
  prodAlloc: { segments: TimeWindow[]; finishTime: number };
  dieRemovalAlloc: { segments: TimeWindow[]; finishTime: number };
  machineFreeAfter: number;
}

// ---------------------------------------------------------------------------
// Main scheduler
// ---------------------------------------------------------------------------

/**
 * Parallel Multi-Part Production Scheduler.
 *
 * Uses a machine-centric dispatch loop: for each free machine, find the best
 * eligible operation from any part whose previous operations are complete.
 * This ensures maximum machine utilization and true parallel execution.
 *
 * Key behaviors:
 *   - Every free machine picks up work immediately if eligible ops exist
 *   - Per-part process sequence is strictly enforced
 *   - Break windows, downtime, and constraints are respected
 *   - Priority ordering determines which operation runs first on a machine
 *   - Detailed status reporting for every part
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

  // ---- Sort machines by capacity ascending for deterministic dispatch ----
  const sortedMachines = [...machinesData].sort((a, b) => a.capacity - b.capacity);

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
  const partProducedQty = new Map<string, number>();

  for (const part of sortedParts) {
    nextOpIndexMap.set(part.id, 0);
    partReadyTimeMap.set(part.id, elapsedTimeSinceShiftStart);
    partProducedQty.set(part.id, part.actualQuantityProduced || 0);

    const activeOps =
      part.selectedOperations && part.selectedOperations.length > 0
        ? part.selectedOperations
        : part.operations;
    partTotalOpsCount.set(part.id, activeOps.length);
  }

  const pendingOperations: Array<{ partName: string; operationName: string; reason: string }> = [];

  // -----------------------------------------------------------------------
  // Helper: Try to schedule the next operation of a part on a specific machine
  // -----------------------------------------------------------------------
  function tryScheduleOperation(
    part: Part,
    currentOpIndex: number,
    machine: Machine,
    candidateStart: number,
  ): OperationAssignment | null {
    const activeOps =
      part.selectedOperations && part.selectedOperations.length > 0
        ? part.selectedOperations
        : part.operations;

    const operation = activeOps[currentOpIndex];
    const targetQty = part.quantityToProduce || 0;
    const alreadyProduced = partProducedQty.get(part.id) || 0;
    const remainingQty = Math.max(0, targetQty - alreadyProduced);
    const qtyToSchedule = remainingQty > 0 ? remainingQty : targetQty;

    const totalProdMinutes =
      qtyToSchedule > 0
        ? Math.ceil((qtyToSchedule / 50) * operation.timeFor50Pcs)
        : operation.timeFor50Pcs;

    const windows = machineUnavailableWindows.get(machine.machineName) || [];

    // Allocate die setting
    const dieAlloc = allocateWorkingSegments(
      candidateStart, operation.dieSettingTime, productionShiftDuration, windows,
    );
    if (!dieAlloc) return null;

    // Allocate production
    const prodAlloc = allocateWorkingSegments(
      dieAlloc.finishTime, totalProdMinutes, productionShiftDuration, windows,
    );
    if (!prodAlloc) return null;

    // Allocate die removal
    const dieRemoval = getDieRemovalTime(machine.capacity);
    const dieRemovalAlloc = allocateWorkingSegments(
      prodAlloc.finishTime, dieRemoval, productionShiftDuration, windows,
    );
    if (!dieRemovalAlloc) return null;

    return {
      part,
      partIndex: sortedParts.indexOf(part),
      opIndex: currentOpIndex,
      operation,
      targetQty: qtyToSchedule,
      bestMachine: machine,
      dieAlloc,
      prodAlloc,
      dieRemovalAlloc,
      machineFreeAfter: dieRemovalAlloc.finishTime,
    };
  }

  // -----------------------------------------------------------------------
  // Parallel Dispatch Loop
  // -----------------------------------------------------------------------
  // In each pass, iterate over every machine. For each machine that is free,
  // find the best eligible operation from any ready part and schedule it.
  // This ensures all machines are kept busy when work is available.
  // -----------------------------------------------------------------------

  let iterationsWithoutWork = 0;
  const MAX_IDLE_ITERATIONS = 50; // Safety limit

  while (iterationsWithoutWork < MAX_IDLE_ITERATIONS) {
    let scheduledInThisPass = false;

    // For this pass, snapshot which machines are currently available
    // so we don't double-schedule the same machine
    const machinesToCheck = new Set(sortedMachines.map(m => m.machineName));

    for (const machine of sortedMachines) {
      if (!machinesToCheck.has(machine.machineName)) continue;

      const machineFreeTime = machineBusyUntil.get(machine.machineName) || 0;

      // Skip if machine is not free at current time
      // (it may have been assigned work earlier in this pass)
      // We advance candidate start to machineFreeTime

      // Find the best eligible operation for this machine
      let bestAssignment: OperationAssignment | null = null;
      let bestPriority = Infinity;

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

        const partReadyTime = partReadyTimeMap.get(part.id) || elapsedTimeSinceShiftStart;

        // Part's previous operation hasn't completed yet - can't schedule
        if (partReadyTime > machineFreeTime) continue;

        const operation = activeOps[currentOpIndex];

        // Check if this machine is suitable (capacity >= required)
        const requiredCapacity = parseMachineCapacity(operation.lowestPress);
        if (machine.capacity < requiredCapacity) continue;

        // Try to schedule this operation on this machine
        const assignment = tryScheduleOperation(
          part, currentOpIndex, machine, machineFreeTime,
        );

        if (!assignment) continue;

        // Pick by priority (lower number = higher priority)
        // If same priority, pick the one that came first (smaller part index)
        if (part.priority < bestPriority) {
          bestAssignment = assignment;
          bestPriority = part.priority;
        }
      }

      // If we found work for this machine, commit it
      if (bestAssignment) {
        commitAssignment(bestAssignment);
        // Mark this machine as taken for this pass
        machinesToCheck.delete(machine.machineName);
        scheduledInThisPass = true;
      }
    }

    if (!scheduledInThisPass) {
      iterationsWithoutWork++;
    } else {
      iterationsWithoutWork = 0;
    }

    // Also try to advance time: if all machines are busy and all parts waiting,
    // we can advance to the next event time (earliest machine free or part ready)
    if (!scheduledInThisPass) {
      // Find earliest machine free time > current time
      let nextEventTime = productionShiftDuration;
      for (const machine of machinesData) {
        const freeTime = machineBusyUntil.get(machine.machineName) || 0;
        if (freeTime > 0 && freeTime < nextEventTime) {
          nextEventTime = freeTime;
        }
      }
      // Find earliest part ready time > current time
      for (const part of sortedParts) {
        const readyTime = partReadyTimeMap.get(part.id) || 0;
        if (readyTime > 0 && readyTime < nextEventTime) {
          nextEventTime = readyTime;
        }
      }

      // If no event is beyond current time but before shift end, we're done
      if (nextEventTime >= productionShiftDuration) {
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helper: commit an assignment to the production plan
  // -----------------------------------------------------------------------
  function commitAssignment(assignment: OperationAssignment): void {
    const { part, operation, opIndex } = assignment;

    // Add die setting segments
    for (const seg of assignment.dieAlloc.segments) {
      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: assignment.bestMachine?.machineName || '',
        quantity: 0,
        startTime: seg.start,
        endTime: seg.end,
        taskType: 'Die Setting',
        executionOrder: globalExecutionOrder++,
      });
    }

    // Add production segments (distribute quantity proportionally across segments)
    const totalProdSegMins = assignment.prodAlloc.segments.reduce(
      (sum, seg) => sum + (seg.end - seg.start), 0,
    );
    let producedSoFar = 0;

    // Use a local reference to avoid TypeScript issues with the bestMachine reference
    const machineName = assignment.bestMachine?.machineName || '';

    for (let i = 0; i < assignment.prodAlloc.segments.length; i++) {
      const seg = assignment.prodAlloc.segments[i];
      const segMins = seg.end - seg.start;
      const isLastSegment = i === assignment.prodAlloc.segments.length - 1;

      const segQty = isLastSegment
        ? assignment.targetQty - producedSoFar
        : Math.round((segMins / totalProdSegMins) * assignment.targetQty);

      const finalQty = Math.max(1, segQty);
      producedSoFar += finalQty;

      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: machineName,
        quantity: finalQty,
        startTime: seg.start,
        endTime: seg.end,
        taskType: 'Production',
        executionOrder: globalExecutionOrder++,
      });
    }

    // Update scheduling state
    if (assignment.bestMachine) {
      machineBusyUntil.set(assignment.bestMachine.machineName, assignment.machineFreeAfter);
    }
    partReadyTimeMap.set(part.id, assignment.prodAlloc.finishTime);
    nextOpIndexMap.set(part.id, opIndex + 1);
  }

  // Sort plan chronologically and reassign execution orders
  productionPlan.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  productionPlan.forEach((task, idx) => {
    task.executionOrder = idx + 1;
  });

  // ---- Build Part Schedule Statuses ----
  const partStatuses: PartScheduleStatus[] = [];

  for (const part of sortedParts) {
    const targetQty = part.quantityToProduce || 0;
    const totalOps = partTotalOpsCount.get(part.id) || 0;
    const scheduledOpIndex = nextOpIndexMap.get(part.id) || 0;
    const completedOps = scheduledOpIndex;
    const alreadyProduced = partProducedQty.get(part.id) || 0;
    const producedInPlan = productionPlan
      .filter(p => p.partName === part.partName && p.taskType === 'Production')
      .reduce((sum, p) => sum + p.quantity, 0);
    const totalProduced = alreadyProduced + producedInPlan;
    const remainingQty = Math.max(0, targetQty - totalProduced);

    let status: PartScheduleStatus['status'];
    if (totalOps === 0 || completedOps >= totalOps) {
      status = 'Completed';
    } else if (completedOps > 0 && completedOps < totalOps) {
      const partReadyTime = partReadyTimeMap.get(part.id) || 0;
      if (partReadyTime >= productionShiftDuration) {
        status = 'Could Not Be Fully Scheduled in Current Shift';
      } else {
        // Check if this part's next operation is waiting for a machine
        const currentOpIndex = nextOpIndexMap.get(part.id) || 0;
        if (currentOpIndex < totalOps) {
          const activeOps =
            part.selectedOperations && part.selectedOperations.length > 0
              ? part.selectedOperations
              : part.operations;
          const nextOp = activeOps[currentOpIndex];
          const requiredCapacity = parseMachineCapacity(nextOp.lowestPress);
          const suitableMachines = machinesData.filter(m => m.capacity >= requiredCapacity && m.available);
          const allSuitableBusy = suitableMachines.every(m => {
            const busyUntil = machineBusyUntil.get(m.machineName) || 0;
            const windows = machineUnavailableWindows.get(m.machineName) || [];
            const partReadyTimeVal = partReadyTimeMap.get(part.id) || 0;
            // Check if machine is available for the remaining shift
            const alloc = allocateWorkingSegments(
              Math.max(partReadyTimeVal, busyUntil),
              nextOp.dieSettingTime + Math.ceil((targetQty / 50) * nextOp.timeFor50Pcs) + getDieRemovalTime(m.capacity),
              productionShiftDuration,
              windows,
            );
            return alloc === null;
          });

          if (allSuitableBusy && suitableMachines.length > 0) {
            status = 'Waiting for Machine';
          } else {
            status = 'Waiting for Previous Process';
          }
        } else {
          status = 'Could Not Be Fully Scheduled in Current Shift';
        }
      }
    } else {
      // completedOps === 0 && totalOps > 0
      const partReadyTime = partReadyTimeMap.get(part.id) || 0;
      if (partReadyTime >= productionShiftDuration) {
        status = 'Could Not Be Fully Scheduled in Current Shift';
      } else {
        status = 'Waiting for Machine';
      }
    }

    partStatuses.push({
      partName: part.partName,
      totalOperations: totalOps,
      completedOperations: completedOps,
      status,
      totalQuantity: targetQty,
      remainingQuantity: remainingQty,
    });
  }

  // ---- Identify incomplete operations ----
  const partCompletionStatus = new Map<
    string,
    { totalQty: number; producedQty: number; isComplete: boolean }
  >();

  for (const part of sortedParts) {
    const targetQty = part.quantityToProduce || 0;
    const producedInPlan = productionPlan
      .filter(p => p.partName === part.partName && p.taskType === 'Production')
      .reduce((sum, p) => sum + p.quantity, 0);
    const alreadyProduced = partProducedQty.get(part.id) || 0;
    const totalProduced = alreadyProduced + producedInPlan;
    const scheduledOpIndex = nextOpIndexMap.get(part.id) || 0;
    const totalOps = partTotalOpsCount.get(part.id) || 0;
    const isComplete = totalOps > 0 && scheduledOpIndex >= totalOps && totalProduced >= targetQty;

    if (!isComplete && totalOps > 0) {
      const activeOps =
        part.selectedOperations && part.selectedOperations.length > 0
          ? part.selectedOperations
          : part.operations;
      const unscheduledOpIndex = scheduledOpIndex < totalOps ? scheduledOpIndex : totalOps - 1;
      if (unscheduledOpIndex >= 0 && unscheduledOpIndex < activeOps.length) {
        const unscheduledOp = activeOps[unscheduledOpIndex];
        // Determine a more specific reason
        let reason = `Could not fit operation within shift duration (${productionShiftDuration} mins)`;
        if (scheduledOpIndex === 0 && totalOps > 0) {
          // Never started
          const requiredCapacity = parseMachineCapacity(unscheduledOp.lowestPress);
          const suitableMachines = machinesData.filter(m => m.capacity >= requiredCapacity && m.available);
          if (suitableMachines.length === 0) {
            reason = `No suitable machine available for minimum requirement of ${unscheduledOp.lowestPress}`;
          } else {
            reason = `Awaiting machine availability for operation: ${unscheduledOp.stepName}`;
          }
        } else if (scheduledOpIndex > 0 && scheduledOpIndex < totalOps) {
          reason = `Previous operation completed, awaiting machine for: ${unscheduledOp.stepName}`;
        }
        pendingOperations.push({
          partName: part.partName,
          operationName: unscheduledOp.stepName,
          reason,
        });
      }
    }

    partCompletionStatus.set(part.id, {
      totalQty: targetQty,
      producedQty: totalProduced,
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
    `Generated parallel multi-part production plan with ${productionPlan.length} tasks across ${totalPartsCount} parts.`,
    `Progress: ${totalPartsProduced} / ${totalPartsRequired} units (${overallProgressPercentage}% completed).`,
    `Fully completed parts: ${fullyCompletedPartsCount} of ${totalPartsCount}.`,
  ];

  // Add per-part status summary
  const inProgressParts = partStatuses.filter(p => p.status === 'Waiting for Machine' || p.status === 'Waiting for Previous Process');
  const partiallyScheduled = partStatuses.filter(p => p.status === 'Could Not Be Fully Scheduled in Current Shift');
  if (partiallyScheduled.length > 0) {
    summaryLines.push(`Parts partially scheduled: ${partiallyScheduled.map(p => `${p.partName} (${p.completedOperations}/${p.totalOperations} ops)`).join(', ')}.`);
  }
  if (inProgressParts.length > 0) {
    summaryLines.push(`Parts awaiting resources: ${inProgressParts.map(p => `${p.partName} - ${p.status}`).join(', ')}.`);
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
    partStatuses,
  };
}