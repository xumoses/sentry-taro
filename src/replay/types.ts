import type { NetworkDetailOptions } from '../sdk/network-details';
import type {
  Breadcrumb,
  BreadcrumbHint,
  DsnComponents,
  Event,
  EventHint,
  FeedbackEvent,
  ReplayEnvelope,
} from '@sentry/core';

export interface TaroReplayEvent {
  type: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface TaroReplayMetadata {
  environment?: string;
  release?: string;
  sdk?: {
    name: string;
    version: string;
  };
  user?: Record<string, unknown>;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, Record<string, unknown>>;
  dist?: string;
}

export interface TaroReplayAttributeLike {
  name: string;
  value: unknown;
}

export interface TaroReplayNodeLike {
  nodeType: number;
  nodeName?: string;
  tagName?: string;
  sid?: string;
  uid?: string;
  textContent?: string | null;
  parentNode?: TaroReplayNodeLike | null;
  childNodes?: TaroReplayNodeLike[];
  attributes?: TaroReplayAttributeLike[] | ArrayLike<TaroReplayAttributeLike>;
  getAttribute?: (name: string) => unknown;
  hasAttribute?: (name: string) => boolean;
  /** Runtime event signatures vary (including Taro's third capture argument). */
  addEventListener?: (...args: any[]) => void;
  removeEventListener?: (...args: any[]) => void;
}

export interface TaroReplayMutationRecordLike {
  type: 'attributes' | 'characterData' | 'childList';
  target: TaroReplayNodeLike;
  addedNodes?: TaroReplayNodeLike[] | ArrayLike<TaroReplayNodeLike>;
  removedNodes?: TaroReplayNodeLike[] | ArrayLike<TaroReplayNodeLike>;
  nextSibling?: TaroReplayNodeLike | null;
  previousSibling?: TaroReplayNodeLike | null;
  attributeName?: string | null;
}

export interface TaroReplayMutationObserverLike {
  observe(target: TaroReplayNodeLike, options: Record<string, boolean>): void;
  disconnect(): void;
}

export interface TaroReplayMutationObserverConstructor {
  new (callback: (records: TaroReplayMutationRecordLike[]) => void): TaroReplayMutationObserverLike;
}

export interface TaroReplayCapture {
  marker: string;
  version: number;
  replayId: string;
  href: string;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  events: TaroReplayEvent[];
  metadata?: TaroReplayMetadata | undefined;
  stats: {
    eventCount: number;
    mutationCount: number;
    breadcrumbCount: number;
    networkCount: number;
    approximateBytes: number;
  };
  warnings: string[];
}

export interface TaroReplayRecorderController {
  addBreadcrumb(breadcrumb: Breadcrumb): boolean;
  getCapture(): TaroReplayCapture;
  stop(reason?: string): TaroReplayCapture;
  /** Drain a session segment without detaching; rolling buffers are returned without draining. */
  takeSegment?(): TaroReplayCapture;
  /** Clear an already captured error buffer and continue its mirror as a live session. */
  promoteToSession?(maxDurationMs: number): boolean;
  recordPageScroll?(position: { scrollTop?: number; scrollLeft?: number }): boolean;
  recordViewport?(size: { width: number; height: number }): boolean;
  /** Read one explicitly marked, currently mounted Canvas/container frame. */
  recordCanvas?(node: TaroReplayNodeLike, readFrame: () => string | undefined): boolean;
}

/** Controller returned by startTaroReplayRecorder; every optional hook is implemented. */
export type TaroReplayRecorder = Required<TaroReplayRecorderController>;

export type TaroReplayNetworkOptions = NetworkDetailOptions;

export interface StartTaroReplayRecorderOptions extends TaroReplayNetworkOptions {
  root: TaroReplayNodeLike;
  MutationObserver: TaroReplayMutationObserverConstructor;
  href?: string;
  width?: number;
  height?: number;
  /** Trusted, caller-built page CSS using Replay selectors; no stylesheet is read at runtime. */
  stylesheet?: string;
  /** Audited build-time image sources; dynamic data URLs remain filtered. */
  staticImageSources?: Readonly<Record<string, string>>;
  /** Masks every Taro text node by default. Set to false only for privacy-safe content. */
  maskAllText?: boolean;
  /** Masks ordinary inputs by default; password and explicitly marked inputs always stay masked. */
  maskInputValues?: boolean;
  /** Official Replay spelling; overrides maskInputValues when provided. */
  maskAllInputs?: boolean;
  /** Defaults to true; audited staticImageSources are an explicit per-image permission. */
  blockAllMedia?: boolean;
  /** Opt in to explicitly marked Canvas image frames; pixels cannot be text-masked. */
  recordCanvas?: boolean;
  /** Attributes whose display text is masked; defaults to title, placeholder and aria-label. */
  maskAttributes?: readonly string[];
  /** Stop an excessive observer batch rather than blocking the application logic thread. */
  mutationLimit?: number;
  maxDurationMs?: number;
  maxEvents?: number;
  maxBytes?: number;
  /** Keeps a rolling tail while retaining the initial Meta + FullSnapshot checkpoint. */
  rollingWindowMs?: number;
  /** Allows a process-wide coordinator to keep one id across root attachments. */
  replayId?: string;
  metadata?: TaroReplayMetadata;
  now?: () => number;
  onEvent?: (event: TaroReplayEvent) => void;
  /** Lightweight budget notification; contains no event payload or live mutable state. */
  onBufferChange?: (
    stats: Pick<TaroReplayCapture['stats'], 'eventCount' | 'approximateBytes'>,
  ) => void;
  /** Drain a full session segment synchronously; rolling buffers never invoke this hook. */
  onBufferFull?: () => void;
  onStop?: (capture: TaroReplayCapture) => void;
}

/** @deprecated Use StartTaroReplayRecorderOptions. */
export type StartTaroDomReplayPocOptions = StartTaroReplayRecorderOptions;
/** @deprecated Use TaroReplayRecorder. */
export type TaroDomReplayPocController = TaroReplayRecorder;
/** @deprecated Use TaroReplayCapture. */
export type TaroReplayPocCapture = TaroReplayCapture;
/** @deprecated Use TaroReplayEvent. */
export type TaroReplayPocEvent = TaroReplayEvent;
/** @deprecated Use TaroReplayMetadata. */
export type TaroReplayPocMetadata = TaroReplayMetadata;

export interface SentryReplayClient {
  getDsn?(): DsnComponents | undefined;
  getOptions?(): {
    environment?: string | undefined;
    release?: string | undefined;
    dist?: string | undefined;
    enableSystemInfo?: boolean | undefined;
  };
  /** Cached technical defaults shared with errors; never scope/user identity. */
  getRuntimeContexts?(): PromiseLike<Record<string, Record<string, unknown>>>;
  on?(
    hook: 'beforeAddBreadcrumb',
    callback: (breadcrumb: Breadcrumb, hint?: BreadcrumbHint) => void,
  ): (() => void) | undefined;
  on?(
    hook: 'beforeSendEvent',
    callback: (event: Event, hint?: EventHint) => void,
  ): (() => void) | undefined;
  recordDroppedEvent?(reason: 'queue_overflow', category: 'replay', count?: number): void;
  on?(
    hook: 'beforeSendFeedback',
    callback: (event: FeedbackEvent, options?: { includeReplay?: boolean }) => void,
  ): (() => void) | undefined;
  sendEnvelope(envelope: ReplayEnvelope): PromiseLike<unknown>;
}

/** Structural SDK interface used by the internal Replay implementation. */
export interface SentryMiniappReplaySdk {
  SDK_NAME?: string;
  SDK_VERSION?: string;
  getClient(): SentryReplayClient | undefined;
  addBreadcrumb?(breadcrumb: Breadcrumb, hint?: BreadcrumbHint): void;
  startTaroDomReplayPoc(options: StartTaroReplayRecorderOptions): TaroReplayRecorderController;
}

export interface TaroReplayRuntime {
  document: { getElementById(id: string): TaroReplayNodeLike | null };
  MutationObserver: StartTaroReplayRecorderOptions['MutationObserver'];
  getCurrentInstance(): {
    router?: {
      $taroPath?: string;
      path?: string;
    };
  };
  getWindowInfo?(): {
    windowWidth?: number;
    windowHeight?: number;
    screenWidth?: number;
    screenHeight?: number;
  };
  /** Returns compiled shared and page CSS for a normalized route. */
  getReplayStyles?(route: string): string | undefined;
  /** Returns trusted, size-bounded static images referenced by this normalized route. */
  getReplayImageSources?(route: string): StartTaroReplayRecorderOptions['staticImageSources'];
  getEnv?(): string;
  getAccountInfoSync?(): {
    miniProgram?: {
      envVersion?: string;
      version?: string;
    };
  };
  getAppBaseInfo?(): {
    SDKVersion?: string;
    version?: string;
    language?: string;
  };
  getDeviceInfo?(): { brand?: string; model?: string; system?: string; platform?: string };
}

export interface TaroReplayContext {
  route: string;
  href: string;
  platform: string;
  environment?: string;
  release?: string;
}

export interface TaroReplayPrivacyOptions {
  /** Default true. Disable only when every visible string is known synthetic data. */
  maskAllText?: boolean;
  /** Default true. */
  maskInputValues?: boolean;
  maskAllInputs?: boolean;
  blockAllMedia?: boolean;
  maskAttributes?: string[];
  /** Default false. Custom metadata.user is discarded unless explicitly enabled. */
  allowUser?: boolean;
}

export interface TaroReplayLimitOptions {
  maxDurationMs?: number;
  maxEvents?: number;
  mutationLimit?: number;
  maxBytes?: number;
  rollingWindowMs?: number;
}

export interface CreateTaroReplayOptions extends TaroReplayNetworkOptions {
  sdk: SentryMiniappReplaySdk;
  runtime: TaroReplayRuntime;
  privacy?: TaroReplayPrivacyOptions;
  limits?: TaroReplayLimitOptions;
  captureBreadcrumbs?: boolean;
  /** Default false. Only explicitly marked canvases may supply unmasked pixels. */
  recordCanvas?: boolean;
  sendOnManualStop?: boolean;
  sendOnDurationStop?: boolean;
  sendOnDispose?: boolean;
  frameworkVersion?: string;
  replayId?: string;
  href?: (route: string) => string;
  getMetadata?: (context: TaroReplayContext) => TaroReplayMetadata | undefined;
  onCapture?: (capture: TaroReplayCapture) => void | Promise<void>;
  onEvent?: (event: TaroReplayEvent) => void;
  /** Synchronous opportunity to drain a full session segment. */
  onBufferFull?: () => void;
  /** Lightweight post-append size notification; never includes recorded values. */
  onBufferChange?: (
    stats: Pick<TaroReplayCapture['stats'], 'eventCount' | 'approximateBytes'>,
  ) => void;
  onError?: (error: unknown) => void;
}

export interface TaroReplayControllerView {
  addBreadcrumb?(breadcrumb: Breadcrumb): boolean;
  readonly replayId: string;
  getCapture(): TaroReplayCapture;
  takeSegment?(): TaroReplayCapture;
  /** Drain an uploaded error buffer and keep the same observer/node mirror. */
  promoteToSession?(maxDurationMs: number): boolean;
  recordPageScroll?(position: { scrollTop?: number; scrollLeft?: number }): boolean;
  recordViewport?(size: { width: number; height: number }): boolean;
  recordCanvas?(node: TaroReplayNodeLike, readFrame: () => string | undefined): boolean;
}

export interface TaroReplayHandle {
  start(): boolean;
  stop(reason?: string): Promise<TaroReplayCapture | undefined>;
  getController(): TaroReplayControllerView | undefined;
  dispose(): void;
}

export type TaroReplayState = 'idle' | 'recording' | 'stopped';

export type UseTaroReplayOptions = Omit<CreateTaroReplayOptions, 'runtime'>;

export interface UseTaroReplayResult extends TaroReplayHandle {
  readonly state: TaroReplayState;
  readonly error: Error | undefined;
}
