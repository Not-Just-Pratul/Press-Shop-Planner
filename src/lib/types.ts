export interface PartOperation {
  stepName: string;
  lowestPress: string;
  dieSettingTime: number;
  timeFor50Pcs: number;
}

export interface Part {
  id: string;
  partName: string;
  partDescription: string;
  operations: PartOperation[];
  selectedOperations?: PartOperation[];
  priority: number;
  quantityToProduce?: number;
  actualQuantityProduced?: number;
}

export interface Machine {
  id: string;
  machineName: string;
  capacity: number;
  available: boolean;
  downtimeDuration?: number;
  downtimeStartTimestamp?: number;
}

export interface BreakTime {
  start: string;
  end: string;
}

export interface BreakTimeMinutes {
  start: number;
  end: number;
}

export interface TimeWindow {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Derived utility types
// ---------------------------------------------------------------------------

export type PartData = Omit<Part, 'id' | 'selectedOperations'>;
export type MachineData = Omit<Machine, 'id' | 'downtimeStartTimestamp'>;

// ---------------------------------------------------------------------------
// Plan configuration & output types
// ---------------------------------------------------------------------------

export interface PlanConfig {
  partsData: Part[];
  machinesData: Machine[];
  productionShiftDuration: number;
  startTime?: string;
  breakTime?: BreakTimeMinutes;
  historicalProductionData?: string;
}

export interface ProductionPlanItem {
  partName: string;
  operationName: string;
  machineName: string;
  quantity: number;
  startTime: number;
  endTime: number;
  taskType: 'Die Setting' | 'Production';
  executionOrder?: number;
}

export interface ProductionPlanMetrics {
  totalPartsRequired: number;
  totalPartsProduced: number;
  totalPartsRemaining: number;
  fullyCompletedPartsCount: number;
  totalPartsCount: number;
  incompletePartsCount: number;
  overallProgressPercentage: number;
  estimatedCompletionTimeMinutes: number;
  pendingOperations: Array<{ partName: string; operationName: string; reason: string }>;
}

export interface ProductionPlan {
  productionPlan: ProductionPlanItem[];
  summary: string;
  metrics?: ProductionPlanMetrics;
}

// ---------------------------------------------------------------------------
// Insights & reporting types
// ---------------------------------------------------------------------------

export interface PlanInsightsOutput {
  machineUtilization: Array<{
    machineName: string;
    utilizationPercentage: number;
    totalTime: number;
    busyTime: number;
    idleTime: number;
  }>;
  partProduction: Array<{
    partName: string;
    quantityProduced: number;
    targetQuantity?: number;
    operations?: PartOperation[];
  }>;
}

export type PlanInsights = PlanInsightsOutput;

export interface DiscrepancyReportOutput {
  discrepancies: Array<{
    partName: string;
    operationName: string;
    idealMachineName: string;
    idealMachineCapacity: number;
    actualMachineName: string;
    actualMachineCapacity: number;
    reason: string;
    severity: 'Low' | 'Medium' | 'High';
  }>;
}

export type DiscrepancyReport = DiscrepancyReportOutput;

// ---------------------------------------------------------------------------
// Server action output types
// ---------------------------------------------------------------------------

export interface GenerateProductionPlanOutput {
  productionPlan: ProductionPlanItem[];
  summary: string;
  metrics?: ProductionPlanMetrics;
}

export interface GenerateAdjustedPlanOutput {
  productionPlan: ProductionPlanItem[];
  summary: string;
  metrics?: ProductionPlanMetrics;
}
