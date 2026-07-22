'use server';

import type { PlanConfig, ProductionPlanItem, PlanInsightsOutput } from '@/lib/types';

export async function generatePlanInsights(
  input: { plan: { productionPlan: ProductionPlanItem[]; summary: string }; config: PlanConfig }
): Promise<PlanInsightsOutput> {
  const { plan, config } = input;
  const { machinesData, productionShiftDuration, partsData } = config;

  const machineBusyTime: Map<string, number> = new Map();
  const machineEntries: Map<string, { totalTime: number; busyTime: number }> = new Map();

  for (const machine of machinesData) {
    machineEntries.set(machine.machineName, {
      totalTime: productionShiftDuration,
      busyTime: 0,
    });
  }

  for (const item of plan.productionPlan) {
    const duration = item.endTime - item.startTime;
    const current = machineEntries.get(item.machineName);
    if (current) {
      current.busyTime += duration;
    }
  }

  const machineUtilization = machinesData.map(machine => {
    const entry = machineEntries.get(machine.machineName) || { totalTime: productionShiftDuration, busyTime: 0 };
    const utilizationPercentage = entry.totalTime > 0 ? parseFloat(((entry.busyTime / entry.totalTime) * 100).toFixed(2)) : 0;
    const idleTime = entry.totalTime - entry.busyTime;

    return {
      machineName: machine.machineName,
      utilizationPercentage,
      totalTime: entry.totalTime,
      busyTime: entry.busyTime,
      idleTime,
    };
  });

  const partQuantityMap: Map<string, number> = new Map();
  for (const part of partsData) {
    partQuantityMap.set(part.partName, 0);
  }

  for (const item of plan.productionPlan) {
    if (item.taskType === 'Production') {
      const current = partQuantityMap.get(item.partName) || 0;
      partQuantityMap.set(item.partName, current + item.quantity);
    }
  }

  const partProduction = partsData.map(part => ({
    partName: part.partName,
    quantityProduced: partQuantityMap.get(part.partName) || 0,
    targetQuantity: part.quantityToProduce,
    operations: part.operations,
  }));

  return {
    machineUtilization,
    partProduction,
  };
}
