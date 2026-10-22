import type { LocalTrainingService } from './scheduler-service.ts';
import type { TrainingAdapter } from './training-adapter.ts';
import type { LocalStore } from './storage/local-store.ts';
import type { SyncRuntime } from './sync/bootstrap.ts';
import type { SyncPanelConfig, SyncPanelMessage } from './sync/panel.ts';

/** What the app's OAuth helpers hand back to the UI. */
export interface SyncBeginAuthResult {
  /** Hosted-UI authorize URL; the caller assigns `location.href`. */
  url: string;
  state: string;
}

export interface SyncCompleteAuthResult {
  /** Cognito ID token for `SyncRuntime.enable`. Never persisted by the UI. */
  idToken: string;
}

export interface AppContext {
  service: LocalTrainingService;
  adapter: TrainingAdapter;
  /**
   * Local domain store, exposed so the lazily-created sync runtime can persist
   * its queue and state through ONL-001's `syncStorage` seam. Optional so screens
   * and tests can be constructed without sync wiring.
   */
  store?: LocalStore;
  /**
   * Lazily creates the sync runtime. It must be offline-safe: with no
   * configuration (and no transport) it resolves to `undefined` and performs no
   * network calls, leaving the Settings panel in its inert local-only state.
   * The app memoizes the result so the OAuth callback and the Settings panel
   * share one runtime instance.
   */
  sync?: () => Promise<SyncRuntime | undefined>;
  /**
   * Start Cognito authorization-code + PKCE. `config` defaults to the loaded
   * sync config; the caller navigates to the returned URL.
   */
  syncBeginAuth?: (config?: SyncPanelConfig) => Promise<SyncBeginAuthResult>;
  /**
   * Finish the callback: validate `state`, exchange the code and return the ID
   * token. Used by the boot handler and never persists a token.
   */
  syncCompleteAuth?: (
    callbackUrl: string,
    config?: SyncPanelConfig,
  ) => Promise<SyncCompleteAuthResult>;
  /**
   * One-shot notice from the OAuth boot handler (success or a generic failure),
   * rendered by Settings. Never contains tokens or key material.
   */
  syncAuthNotice?: SyncPanelMessage;
}
