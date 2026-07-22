'use server';

import type { PlanConfig, ProductionPlanItem, DiscrepancyReportOutput, Part } from '@/lib/types';

function findPartOperations(partName: string, partsData: Part[]): Part['operations'] {
  const part = partsData.find(p => p.partName === partName);
  return part ? part.operations : [];
}

function findOperationForTask(task: ProductionPlanItem, partsData: Part[]): { lowestPress: string; stepName: string } | null {
  const ops = findPartOperations(task.partName, partsData);
  const op = ops.find(o => o.stepName === task.operationName);
  if (op) {
    return { lowestPress: op.lowestPress, stepName: op.stepName };
  }
  return null;
}

export async function generateDiscrepancyReport(
  input: { plan: { productionPlan: ProductionPlanItem[]; summary: string }; config: PlanConfig }
): Promise<DiscrepancyReportOutput> {
  const { plan, config } = input;
  const { machinesData, partsData } = config;

  const machineCapacityMap: Map<string, number> = new Map();
  for (const machine of machinesData) {
    machineCapacityMap.set(machine.machineName, machine.capacity);
  }

  const sortedUniqueCapacities = [...new Set(machinesData.map(m => m.capacity))].sort((a, b) => a - b);
  const capacityTierIndex: Map<number, number> = new Map();
  sortedUniqueCapacities.forEach((cap, idx) => capacityTierIndex.set(cap, idx));

  function getSeverity(idealCapacity: number, actualCapacity: number): 'Low' | 'Medium' | 'High' {
    const idealIdx = capacityTierIndex.get(idealCapacity) ?? 0;
    const actualIdx = capacityTierIndex.get(actualCapacity) ?? 0;
    const jump = actualIdx - idealIdx;
    if (jump <= 1) return 'Low';
    if (jump === 2) return 'Medium';
    return 'High';
  }

  const discrepancies: DiscrepancyReportOutput['discrepancies'] = [];

  for (const task of plan.productionPlan) {
    if (task.taskType !== 'Production') continue;

    const opInfo = findOperationForTask(task, partsData);
    if (!opInfo) continue;

    const idealMachineName = opInfo.lowestPress;
    const idealCapacity = machineCapacityMap.get(idealMachineName);
    const actualCapacity = machineCapacityMap.get(task.machineName);

    if (idealCapacity === undefined || actualCapacity === undefined) continue;
    if (actualCapacity <= idealCapacity) continue;

    const idealTasks = plan.productionPlan.filter(
      t => t.taskType === 'Production' && t.machineName === idealMachineName && t.startTime < task.endTime && t.endTime > task.startTime
    );
    let reason: string;
    if (idealTasks.length > 0) {
      const conflicting = idealTasks.find(t => t.startTime < task.endTime && t.endTime > task.startTime);
      if (conflicting) {
        reason = `Ideal machine was busy performing ${conflicting.partName} - ${conflicting.operationName}`;
      } else {
        reason = 'All ideal capacity machines were occupied';
      }
    } else {
      reason = 'All ideal capacity machines were occupied';
    }

    discrepancies.push({
      partName: task.partName,
      operationName: task.operationName,
      idealMachineName,
      idealMachineCapacity: idealCapacity,
      actualMachineName: task.machineName,
      actualMachineCapacity: actualCapacity,
      reason,
      severity: getSeverity(idealCapacity, actualCapacity),
    });
  }

  return { discrepancies };
}
