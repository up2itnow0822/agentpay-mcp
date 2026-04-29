import { defaultBudgetState } from '../budget-state';

export interface CheckBudgetResult {
  ok: true;
  budget: ReturnType<typeof defaultBudgetState.getSnapshot>;
}

export async function checkBudget(): Promise<CheckBudgetResult> {
  return {
    ok: true,
    budget: defaultBudgetState.getSnapshot(),
  };
}
