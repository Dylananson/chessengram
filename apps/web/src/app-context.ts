import type { LocalTrainingService } from './scheduler-service.ts';
import type { TrainingAdapter } from './training-adapter.ts';

export interface AppContext {
  service: LocalTrainingService;
  adapter: TrainingAdapter;
}