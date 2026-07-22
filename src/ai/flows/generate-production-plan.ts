'use server';

import type { Part, Machine, PlanConfig, ProductionPlanItem } from '@/lib/types';

function getDieRemovalTime(capacity: number): number {
  return capacity <= 50 ? 10 : 15;
}

interface TimeWindow {
  start: number;
  end: number;
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
  const match = requiredPress.match(/(\d+)T/);
  const requiredCapacity = match ? parseInt(match[1], 10) : 0;
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

export async function generateProductionPlan(
  input: PlanConfig & {
    freeUpMachineConstraints?: Array<{ machineName: string; startTime: number; endTime: number }>;
  }
): Promise<{ productionPlan: ProductionPlanItem[]; summary: string }> {
  const {
    partsData,
    machinesData,
    productionShiftDuration,
    breakTime,
    freeUpMachineConstraints
  } = input;

  const invalidPart = partsData.find(p => !p.quantityToProduce || p.quantityToProduce <= 0);
  if (invalidPart) {
    return {
      productionPlan: [],
      summary: 'Error: Please fill in the necessary quantity for all parts in the planner.',
    };
  }

  const sortedParts = [...partsData].sort((a, b) => a.priority - b.priority);

  const sortedMachines = [...machinesData].sort((a, b) => a.capacity - b.capacity);
  const suitableMachinesCache = new Map<string, Machine[]>();

  function getCachedAvailableMachines(requiredPress: string): Machine[] {
    const match = requiredPress.match(/(\d+)T/);
    const requiredCapacity = match ? parseInt(match[1], 10) : 0;
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

  if (freeUpMachineConstraints && freeUpMachineConstraints.length > 0) {
    for (const constraint of freeUpMachineConstraints) {
      const windows = machineUnavailableWindows.get(constraint.machineName) || [];
      windows.push({ start: constraint.startTime, end: constraint.endTime });
      machineUnavailableWindows.set(constraint.machineName, windows.sort((a, b) => a.start - b.start || a.end - b.end));
    }
  }

  const machineBusyUntil: Map<string, number> = new Map();
  for (const machine of machinesData) {
    machineBusyUntil.set(machine.machineName, 0);
  }

  const partPrevOpEnd: Map<string, number> = new Map();
  const productionPlan: ProductionPlanItem[] = [];
  let totalCompleted = 0;
  const partStatus: { name: string; status: string; quantity: number }[] = [];

  for (const part of sortedParts) {
    let partStart = partPrevOpEnd.get(part.partName) || 0;
    let allOpsComplete = true;

    for (let opIndex = 0; opIndex < part.operations.length; opIndex++) {
      const operation = part.operations[opIndex];
      const requiredPress = operation.lowestPress;
      const dieSettingTime = operation.dieSettingTime;
      const productionTime = operation.timeFor50Pcs;
      const quantity = part.quantityToProduce || 0;
      const scaledProductionTime = quantity > 50 ? Math.ceil((quantity / 50)) * productionTime : productionTime;

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

      productionPlan.push({
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
        partPrevOpEnd.set(part.id, prodStart);
        allOpsComplete = false;
        continue;
      }

      productionPlan.push({
        partName: part.partName,
        operationName: operation.stepName,
        machineName: bestMachine.machineName,
        quantity: quantity,
        startTime: prodStart,
        endTime: prodEnd,
        taskType: 'Production',
      });

      const dieRemoval = getDieRemovalTime(bestMachine.capacity);
      const machineAvailableAfter = prodEnd + dieRemoval;

      machineBusyUntil.set(bestMachine.machineName, Math.min(machineAvailableAfter, productionShiftDuration));
      partPrevOpEnd.set(part.id, prodEnd);
      partStart = prodEnd;
    }

    if (allOpsComplete) {
      totalCompleted++;
      partStatus.push({ name: part.partName, status: 'Fully completed', quantity: part.quantityToProduce || 0 });
    } else {
      partStatus.push({ name: part.partName, status: 'Partially completed or not started', quantity: 0 });
    }
  }

  const summaryParts = partStatus.map(p => {
    if (p.status === 'Fully completed') {
      return `- ${p.name}: ${p.quantity} units fully completed.`;
    }
    return `- ${p.name}: ${p.status}.`;
  }).join('\n');

  const summary = `Generated optimized production plan with ${productionPlan.length} tasks for ${sortedParts.length} parts. ${totalCompleted} parts fully completed.\n${summaryParts}`;

  return { productionPlan, summary };
}
