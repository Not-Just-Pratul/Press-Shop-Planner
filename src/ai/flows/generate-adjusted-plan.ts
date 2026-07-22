'use server';

import type { Part, Machine, PlanConfig, ProductionPlanItem, TimeWindow, GenerateAdjustedPlanOutput } from '@/lib/types';

function getDieRemovalTime(capacity: number): number {
  return capacity <= 50 ? 10 : 15;
}

function parseMachineCapacity(machineName: string): number {
  const match = machineName.match(/(\d+)T/);
  return match ? parseInt(match[1], 10) : 0;
}

function buildUnavailableWindows(
  machine: Machine,
  shiftDuration: number,
  breakTime?: TimeWindow
): TimeWindow[] {
  const windows: TimeWindow[] = [];

  if (!machine.available) {
    windows.push({ start: 0, end: shiftDuration });
    return windows;
  }

  if (machine.downtimeDuration && machine.downtimeDuration > 0) {
    windows.push({ start: 0, end: machine.downtimeDuration });
  }

  if (breakTime) {
    windows.push({ start: breakTime.start, end: breakTime.end });
  }

  return windows.sort((a, b) => a.start - b.start || a.end - b.end);
}

function findEarliestStart(
  preferredStart: number,
  duration: number,
  shiftDuration: number,
  unavailableWindows: TimeWindow[]
): number | null {
  let start = Math.max(0, preferredStart);

  while (start + duration <= shiftDuration) {
    let blocked = false;
    for (const win of unavailableWindows) {
      if (start < win.end && start + duration > win.start) {
        start = win.end;
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      return start;
    }
  }

  return null;
}

function getAvailableMachines(
  requiredPress: string,
  machines: Machine[]
): Machine[] {
  const requiredCapacity = parseMachineCapacity(requiredPress);
  if (requiredCapacity === 0) return [];

  const sorted = [...machines].sort((a, b) => a.capacity - b.capacity);
  const suitable: Machine[] = [];
  let foundIdeal = false;

  for (const machine of sorted) {
    if (machine.capacity < requiredCapacity) continue;

    if (!foundIdeal) {
      suitable.push(machine);
      if (machine.capacity === requiredCapacity) {
        foundIdeal = true;
      }
    } else if (machine.capacity === suitable[suitable.length - 1]?.capacity) {
      suitable.push(machine);
    } else {
      break;
    }
  }

  return suitable;
}

export async function generateAdjustedPlan(
  input: {
    partsData: (Part & { actualQuantityProduced?: number })[];
    machinesData: Machine[];
    productionShiftDuration: number;
    elapsedTimeSinceShiftStart: number;
    currentProductionPlan: { productionPlan: ProductionPlanItem[]; summary: string };
    breakTime?: { start: number; end: number };
    historicalProductionData?: string;
    freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  }
): Promise<GenerateAdjustedPlanOutput> {
  const { partsData, machinesData, productionShiftDuration, elapsedTimeSinceShiftStart, currentProductionPlan, breakTime, freeUpMachineConstraints } = input;

  const lockWindowEnd = elapsedTimeSinceShiftStart + 45;
  const lockedTasks = currentProductionPlan.productionPlan.filter(
    t => t.startTime < lockWindowEnd
  );

  const partsNeedingReplan = partsData
    .map(p => ({
      ...p,
      remainingQuantity: (p.quantityToProduce || 0) - (p.actualQuantityProduced || 0),
    }))
    .filter(p => p.remainingQuantity > 0)
    .sort((a, b) => a.priority - b.priority);

  const sortedMachines = [...machinesData].sort((a, b) => a.capacity - b.capacity);
  const suitableMachinesCache = new Map<string, Machine[]>();

  function getCachedAvailableMachines(requiredPress: string): Machine[] {
    const requiredCapacity = parseMachineCapacity(requiredPress);
    if (requiredCapacity === 0) return [];

    if (suitableMachinesCache.has(requiredPress)) {
      return suitableMachinesCache.get(requiredPress)!;
    }

    const suitable: Machine[] = [];
    let foundIdeal = false;

    for (const machine of sortedMachines) {
      if (machine.capacity < requiredCapacity) continue;

      if (!foundIdeal) {
        suitable.push(machine);
        if (machine.capacity === requiredCapacity) {
          foundIdeal = true;
        }
      } else if (machine.capacity === suitable[suitable.length - 1]?.capacity) {
        suitable.push(machine);
      } else {
        break;
      }
    }

    suitableMachinesCache.set(requiredPress, suitable);
    return suitable;
  }

  const machineUnavailableWindows: Map<string, TimeWindow[]> = new Map();
  for (const machine of machinesData) {
    machineUnavailableWindows.set(machine.machineName, buildUnavailableWindows(machine, productionShiftDuration, breakTime));
  }

  if (input.freeUpMachineConstraints && input.freeUpMachineConstraints.length > 0) {
    for (const constraint of input.freeUpMachineConstraints) {
      const windows = machineUnavailableWindows.get(constraint.machineName) || [];
      windows.push({ start: constraint.startTime, end: constraint.endTime });
      machineUnavailableWindows.set(constraint.machineName, windows.sort((a, b) => a.start - b.start || a.end - b.end));
    }
  }

  const machineBusyUntil: Map<string, number> = new Map();
  for (const machine of machinesData) {
    const windows = machineUnavailableWindows.get(machine.machineName) || [];
    let availableFrom = 0;
    for (const win of windows) {
      if (win.start <= availableFrom) {
        availableFrom = Math.max(availableFrom, win.end);
      }
    }
    machineBusyUntil.set(machine.machineName, availableFrom);
  }

  const newTasks: ProductionPlanItem[] = [];
  const partCompletion: Map<string, boolean> = new Map();

  for (const part of partsNeedingReplan) {
    let partStart = elapsedTimeSinceShiftStart;
    let allOpsComplete = true;

    for (let opIndex = 0; opIndex < part.operations.length; opIndex++) {
      const operation = part.operations[opIndex];
      const requiredPress = operation.lowestPress;
      const dieSettingTime = operation.dieSettingTime;
      const productionTime = operation.timeFor50Pcs;
      const remainingQty = part.remainingQuantity;
      const scaledProductionTime = remainingQty > 50 ? Math.ceil((remainingQty / 50)) * productionTime : productionTime;

      const suitable = getCachedAvailableMachines(requiredPress);

      let bestMachine: Machine | undefined;
      let earliestStart = Infinity;

      for (const candidate of suitable) {
        const busyUntil = machineBusyUntil.get(candidate.machineName) || 0;
        const start = findEarliestStart(
          Math.max(partStart, busyUntil),
          dieSettingTime + scaledProductionTime + getDieRemovalTime(candidate.capacity),
          productionShiftDuration,
          machineUnavailableWindows.get(candidate.machineName) || []
        );

        if (start !== null && start < earliestStart) {
          earliestStart = start;
          bestMachine = candidate;
        }
      }

      if (!bestMachine || earliestStart >= productionShiftDuration) {
        allOpsComplete = false;
        continue;
      }

      const dieStart = earliestStart;
      const dieEnd = dieStart + dieSettingTime;

      if (dieEnd > productionShiftDuration) {
        allOpsComplete = false;
        continue;
      }

      newTasks.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: 0,
        startTime: dieStart,
        endTime: dieEnd,
        taskType: 'Die Setting',
      });

      const prodStart = dieEnd;
      const prodEnd = prodStart + scaledProductionTime;

      if (prodEnd > productionShiftDuration) {
        machineBusyUntil.set(bestMachine.machineName, prodStart);
        partStart = prodStart;
        allOpsComplete = false;
        continue;
      }

      newTasks.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: remainingQty,
        startTime: prodStart,
        endTime: prodEnd,
        taskType: 'Production',
      });

      const dieRemoval = getDieRemovalTime(bestMachine.capacity);
      const machineAvailableAfter = prodEnd + dieRemoval;

      machineBusyUntil.set(bestMachine.machineName, Math.min(machineAvailableAfter, productionShiftDuration));
      partStart = prodEnd;
    }

    partCompletion.set(part.id, allOpsComplete);
  }

  const combinedPlan = [...lockedTasks, ...newTasks].sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);

  const lockedSummary = lockedTasks.length > 0
    ? `- ${lockedTasks.length} locked tasks preserved from original plan.`
    : '- No tasks were locked.';
  const rescheduledSummary = partsNeedingReplan.map(p => {
    const status = partCompletion.get(p.id) ? 'fully rescheduled' : 'partially rescheduled';
    return `- Rescheduled ${p.partName} to produce remaining ${p.remainingQuantity} units (${status}).`;
  }).join('\n');

  const summary = `Plan adjusted at ${elapsedTimeSinceShiftStart} minutes into the shift.\n${lockedSummary}\n${rescheduledSummary}`;

  return {
    productionPlan: combinedPlan,
    summary,
  };
}
