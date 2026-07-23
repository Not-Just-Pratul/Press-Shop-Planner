"use client";

import { useState, useCallback, useEffect } from "react";
import type { Part, Machine, ProductionPlan, PlanInsights, DiscrepancyReport } from "@/lib/types";
import { getAdjustedProductionPlan } from "@/app/actions";
import { useToast } from "@/hooks/use-toast";
import { AppHeader } from "@/components/app/app-header";
import { ConfigPanel } from "@/components/app/config-panel";
import { initialMachines } from "@/lib/initial-data";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Info } from "lucide-react";
import {
  DndContext, closestCenter,
  KeyboardSensor, PointerSensor,
  useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext,
  sortableKeyboardCoordinates, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { Skeleton } from "@/components/ui/skeleton";
import { calculateDuration } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Local storage keys
// ---------------------------------------------------------------------------

const PARTS_STORAGE_KEY = 'press-shop-optimizer-parts';
const PLAN_STORAGE_KEY = 'press-shop-optimizer-plan';
const PLAN_CONFIG_STORAGE_KEY = 'press-shop-optimizer-plan-config';
const ADJUSTED_PLAN_STORAGE_KEY = 'press-shop-optimizer-adjusted-plan';
const ADJUSTED_INSIGHTS_STORAGE_KEY = 'press-shop-optimizer-adjusted-insights';
const ADJUSTED_DISCREPANCY_REPORT_STORAGE_KEY = 'press-shop-optimizer-adjusted-discrepancy-report';
const ADJUSTED_PLAN_CONFIG_STORAGE_KEY = 'press-shop-optimizer-adjusted-plan-config';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DowntimePlannerPage() {
  const [masterPartsList, setMasterPartsList] = useState<Part[]>([]);
  const [partsForPlan, setPartsForPlan] = useState<Part[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // Original plan that will be adjusted
  const [originalPlan, setOriginalPlan] = useState<ProductionPlan | null>(null);

  // Adjusted plan state
  const [adjustedPlan, setAdjustedPlan] = useState<ProductionPlan | null>(null);
  const [adjustedInsights, setAdjustedInsights] = useState<PlanInsights | null>(null);
  const [adjustedDiscrepancyReport, setAdjustedDiscrepancyReport] = useState<DiscrepancyReport | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [shiftDuration, setShiftDuration] = useState(0);
  const [shiftStartTime, setShiftStartTime] = useState("09:00");
  const [breakTime, setBreakTime] = useState<{ start: number; end: number } | undefined>(undefined);

  const { toast } = useToast();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // ---- Load persisted data on mount ----
  useEffect(() => {
    try {
      const savedMasterParts = window.localStorage.getItem(PARTS_STORAGE_KEY);
      const allParts = savedMasterParts ? JSON.parse(savedMasterParts) : [];
      setMasterPartsList(allParts);

      const savedPlanConfig = window.localStorage.getItem(PLAN_CONFIG_STORAGE_KEY);
      const planConfig = savedPlanConfig ? JSON.parse(savedPlanConfig) : {};

      const savedOriginalPlan = window.localStorage.getItem(PLAN_STORAGE_KEY);
      setOriginalPlan(savedOriginalPlan ? JSON.parse(savedOriginalPlan) : null);

      const savedAdjustedPlan = window.localStorage.getItem(ADJUSTED_PLAN_STORAGE_KEY);
      setAdjustedPlan(savedAdjustedPlan ? JSON.parse(savedAdjustedPlan) : null);

      const savedAdjustedInsights = window.localStorage.getItem(ADJUSTED_INSIGHTS_STORAGE_KEY);
      setAdjustedInsights(savedAdjustedInsights ? JSON.parse(savedAdjustedInsights) : null);

      const savedAdjustedDiscrepancyReport = window.localStorage.getItem(ADJUSTED_DISCREPANCY_REPORT_STORAGE_KEY);
      setAdjustedDiscrepancyReport(
        savedAdjustedDiscrepancyReport ? JSON.parse(savedAdjustedDiscrepancyReport) : null,
      );

      const savedAdjustedConfig = window.localStorage.getItem(ADJUSTED_PLAN_CONFIG_STORAGE_KEY);
      const configToLoad = savedAdjustedConfig ? JSON.parse(savedAdjustedConfig) : planConfig;

      setPartsForPlan(
        configToLoad.partsData
          ? configToLoad.partsData.map((p: any, i: number) => ({
              ...p,
              id: p.id || `part-${i}`,
              actualQuantityProduced: p.actualQuantityProduced || 0,
            }))
          : [],
      );
      setMachines(configToLoad.machinesData || initialMachines);
      setShiftDuration(configToLoad.productionShiftDuration || 0);
      setShiftStartTime(configToLoad.startTime || "09:00");
      setBreakTime(configToLoad.breakTime);
    } catch (error) {
      console.error("Failed to load data from localStorage", error);
    }
    setIsDataLoaded(true);
  }, []);

  // ---- Part selection ----
  const handlePartSelectionChange = (partToAdd: Part) => {
    setPartsForPlan(currentParts => {
      if (partToAdd && !currentParts.some(p => p.id === partToAdd.id)) {
        const newPart = { ...partToAdd, actualQuantityProduced: 0 };
        const newParts = [...currentParts, newPart];
        return newParts.map((p, index) => ({ ...p, priority: index + 1 }));
      }
      return currentParts;
    });
  };

  // ---- Generate adjusted plan ----
  const handleGenerateAdjustedPlan = useCallback(
    async (options: { replanTime: string }) => {
      setIsLoading(true);

      if (!originalPlan) {
        toast({
          variant: "destructive",
          title: "No Active Plan",
          description: "There is no existing plan to adjust.",
        });
        setIsLoading(false);
        return;
      }

      if (!options.replanTime) {
        toast({
          variant: "destructive",
          title: "Re-plan Time Not Set",
          description: "Please specify the time to re-plan from.",
        });
        setIsLoading(false);
        return;
      }

      const elapsedTimeSinceShiftStart = calculateDuration(shiftStartTime, options.replanTime);

      if (elapsedTimeSinceShiftStart < 0) {
        toast({
          variant: "destructive",
          title: "Invalid Re-plan Time",
          description: "The re-plan time cannot be before the shift start time.",
        });
        setIsLoading(false);
        return;
      }

      const machinesForPlan = machines.map(({ id, downtimeStartTimestamp, ...rest }) => rest);

      const input = {
        partsData: partsForPlan.map(({ id, ...rest }) => rest),
        machinesData: machinesForPlan,
        productionShiftDuration: shiftDuration,
        elapsedTimeSinceShiftStart,
        currentProductionPlan: originalPlan,
        breakTime,
      };

      const result = await getAdjustedProductionPlan(input as any);

      if (result.error) {
        toast({
          variant: "destructive",
          title: "Error Adjusting Plan",
          description: result.error,
        });
      } else if (result.data) {
        setAdjustedPlan(result.data.plan);
        setAdjustedInsights(result.data.insights);
        setAdjustedDiscrepancyReport(result.data.discrepancyReport);
        toast({
          title: "Plan Adjusted & Saved",
          description: "Production plan has been re-generated and saved.",
        });

        // Persist adjusted plan data
        window.localStorage.setItem(ADJUSTED_PLAN_STORAGE_KEY, JSON.stringify(result.data.plan));
        window.localStorage.setItem(ADJUSTED_INSIGHTS_STORAGE_KEY, JSON.stringify(result.data.insights));
        if (result.data.discrepancyReport) {
          window.localStorage.setItem(
            ADJUSTED_DISCREPANCY_REPORT_STORAGE_KEY,
            JSON.stringify(result.data.discrepancyReport),
          );
        }

        const updatedConfig = {
          partsData: partsForPlan,
          machinesData: machines,
          productionShiftDuration: shiftDuration,
          startTime: shiftStartTime,
          breakTime,
        };
        window.localStorage.setItem(ADJUSTED_PLAN_CONFIG_STORAGE_KEY, JSON.stringify(updatedConfig));
      }

      setIsLoading(false);
    },
    [partsForPlan, machines, toast, originalPlan, shiftStartTime, shiftDuration, breakTime],
  );

  // ---- Drag-and-drop reordering ----
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setPartsForPlan(items => {
        const oldIndex = items.findIndex(item => item.id === active.id);
        const newIndex = items.findIndex(item => item.id === over.id);
        const reorderedItems = arrayMove(items, oldIndex, newIndex);
        return reorderedItems.map((item, index) => ({ ...item, priority: index + 1 }));
      });
    }
  };

  // ---- Reset adjusted plan ----
  const handleResetPlan = useCallback(() => {
    setIsLoading(true);
    setAdjustedPlan(null);
    setAdjustedInsights(null);
    setAdjustedDiscrepancyReport(null);

    window.localStorage.removeItem(ADJUSTED_PLAN_STORAGE_KEY);
    window.localStorage.removeItem(ADJUSTED_INSIGHTS_STORAGE_KEY);
    window.localStorage.removeItem(ADJUSTED_DISCREPANCY_REPORT_STORAGE_KEY);
    window.localStorage.removeItem(ADJUSTED_PLAN_CONFIG_STORAGE_KEY);

    try {
      const savedPlanConfig = window.localStorage.getItem(PLAN_CONFIG_STORAGE_KEY);
      const planConfig = savedPlanConfig ? JSON.parse(savedPlanConfig) : {};

      setPartsForPlan(
        planConfig.partsData
          ? planConfig.partsData.map((p: any, i: number) => ({
              ...p,
              id: p.id || `part-${i}`,
              actualQuantityProduced: 0,
            }))
          : [],
      );
      setMachines(planConfig.machinesData || initialMachines);

      toast({
        title: "Changes Reset",
        description: "Your adjustments have been reverted to the last saved plan.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error Resetting",
        description: "Could not reload the plan from your browser's storage.",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  // ---- Loading skeleton ----
  if (!isDataLoaded) {
    return (
      <div className="flex flex-col h-screen bg-background">
        <AppHeader />
        <main className="flex-1 container mx-auto p-4 md:p-6 lg:p-8">
          <Skeleton className="h-12 w-3/4 mb-4" />
          <Skeleton className="h-8 w-full mb-6" />
          <div className="space-y-4 pt-4">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </main>
      </div>
    );
  }

  // ---- No active plan ----
  if (!originalPlan) {
    return (
      <div className="flex flex-col h-screen bg-background">
        <AppHeader />
        <main className="flex-1 flex flex-col items-center justify-center text-center p-4">
          <Alert className="max-w-xl">
            <Info className="h-4 w-4" />
            <AlertTitle>No Active Plan Found</AlertTitle>
            <AlertDescription>
              There is no production plan currently active in your session.
              Please generate a plan from the main planner page first.
            </AlertDescription>
          </Alert>
          <Link href="/planner" passHref>
            <Button variant="outline" className="mt-6">Go to Planner</Button>
          </Link>
        </main>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="flex flex-col min-h-screen bg-background">
        <AppHeader />
        <main className="flex-1 p-4 md:p-6 lg:p-8 space-y-8">
          <div className="container mx-auto">
            <SortableContext items={partsForPlan.map(p => p.id)} strategy={verticalListSortingStrategy}>
              <ConfigPanel
                parts={partsForPlan}
                setParts={setPartsForPlan}
                machines={machines}
                setMachines={setMachines}
                onGeneratePlan={handleGenerateAdjustedPlan}
                onResetPlan={handleResetPlan}
                isGeneratingPlan={isLoading}
                masterPartsList={masterPartsList}
                onPartSelectionChange={handlePartSelectionChange}
                isAdjustingPlan={true}
                plan={adjustedPlan}
                insights={adjustedInsights}
                discrepancyReport={adjustedDiscrepancyReport}
                shiftDuration={shiftDuration}
                shiftStartTime={shiftStartTime}
              />
            </SortableContext>
          </div>
        </main>
      </div>
    </DndContext>
  );
}
