import { snapshotNetworkOptions } from './network-details';
import {
  getClient,
  initAndBind,
  setContext,
  eventFiltersIntegration,
  spanStreamingIntegration,
  dedupeIntegration,
  functionToStringIntegration,
} from '@sentry/core';
import type { Integration } from '@sentry/core';
import { miniappStackParser } from './stacktrace';
import { wrap as wrapCallback } from './helpers';
import { setConsentGranted, isConsentGranted } from './consent';

import { MiniappClient } from './client';
import { appName, isMiniappEnvironment, isMinigame } from './crossPlatform';
import {
  GlobalHandlers,
  TryCatch,
  LinkedErrors,
  HttpContext,
  performanceIntegration,
  RewriteFrames,
  NetworkBreadcrumbs,
  PageBreadcrumbs,
  PageTracing,
  ConsoleBreadcrumbs,
  SessionIntegration,
  NetworkStatusIntegration,
  MinigameIntegration,
  MinigameFrameRateIntegration,
} from './integrations/index';
import type { MiniappClientOptions, MiniappOptions, ReportDialogOptions } from './types';

/**
 * 构造一组**全新**的默认集成实例。
 *
 * 必须每次 init 现造新实例：集成的 setupOnce/cleanup 会把补丁状态留在实例上，跨多次 init 或
 * 多 client 复用同一批单例会让状态互踩（close 后再 init、或并存两个 client 时尤甚）。这与
 * client.close() 清 core 的 setupOnce 门禁（按 name）互补——name 门禁放行后，全新实例才能干净
 * 地重新 setupOnce。
 */
export function getDefaultIntegrations(options: MiniappOptions = {}): Integration[] {
  const integrations: Integration[] = [
    // Core integrations
    new HttpContext(),
    dedupeIntegration(),
    functionToStringIntegration(),
    new GlobalHandlers(),
    new TryCatch(),
    new LinkedErrors(),
    // Performance monitoring
    performanceIntegration({
      enableNavigation: true,
      enableRender: true,
      enableResource: true,
      enableUserTiming: true,
      sampleRate: 1.0,
      reportInterval: 30000,
    }),
  ];
  if (options.enableSourceMap !== false) {
    integrations.push(new RewriteFrames());
  }

  const networkOptions: Record<string, any> = {
    traceNetworkBody: options.traceNetworkBody,
    ...snapshotNetworkOptions(options),
  };
  if (options.enableTracePropagation !== undefined) {
    networkOptions['enableTracePropagation'] = options.enableTracePropagation;
  }
  if (options.tracePropagationTargets !== undefined) {
    networkOptions['tracePropagationTargets'] = options.tracePropagationTargets;
  }
  integrations.push(new NetworkBreadcrumbs(networkOptions));

  // 自动 Session 管理（默认启用）
  if (options.enableAutoSessionTracking !== false) {
    integrations.push(new SessionIntegration());
  }

  // 页面生命周期和用户交互面包屑（默认启用，可分别关闭）
  const enablePageLifecycleBreadcrumbs = options.enableNavigationBreadcrumbs !== false;
  const enableUserInteractionBreadcrumbs = options.enableUserInteractionBreadcrumbs !== false;
  if (enablePageLifecycleBreadcrumbs || enableUserInteractionBreadcrumbs) {
    integrations.push(
      new PageBreadcrumbs({
        enableLifecycle: enablePageLifecycleBreadcrumbs,
        enableUserInteraction: enableUserInteractionBreadcrumbs,
      }),
    );
  }

  if (
    options.enablePageTracing !== false &&
    (options.tracesSampleRate !== undefined || options.tracesSampler)
  ) {
    if (!integrations.some((integration) => integration.name === PageTracing.id))
      integrations.push(new PageTracing());
  }

  // 网络状态实时监控（默认启用）
  if (options.enableNetworkStatusMonitoring !== false) {
    integrations.push(new NetworkStatusIntegration());
  }

  // Console 面包屑（默认禁用，需手动开启）
  if (options.enableConsoleBreadcrumbs) {
    integrations.push(new ConsoleBreadcrumbs());
  }

  // 小游戏专属能力：纯增量，仅在检测到小游戏（或显式开启）时追加。
  // 小游戏无 App()/Page()，PageBreadcrumbs / SessionIntegration 已安全 no-op，这里不删除它们。
  // 若用户已通过 integrations 自行传入同名集成，则不再自动追加，避免默认实例覆盖用户配置。
  const minigame = isMiniappEnvironment() && isMinigame();
  const hasIntegration = (id: string): boolean =>
    integrations.some((integration) => integration && integration.name === id) ||
    (Array.isArray(options.integrations) &&
      options.integrations.some((integration) => integration.name === id));

  // 入站过滤：让 allowUrls / denyUrls / ignoreErrors 真正生效（此前是声明了却无人消费的死选项）。
  // 仅在用户未自行传入同名集成时追加；按 exactOptionalPropertyTypes 只填已定义的键。
  if (!hasIntegration('EventFilters') && !hasIntegration('InboundFilters')) {
    const filterOptions: {
      allowUrls?: Array<string | RegExp>;
      denyUrls?: Array<string | RegExp>;
      ignoreErrors?: Array<string | RegExp>;
    } = {};
    if (options.allowUrls) filterOptions.allowUrls = options.allowUrls;
    if (options.denyUrls) filterOptions.denyUrls = options.denyUrls;
    if (options.ignoreErrors) filterOptions.ignoreErrors = options.ignoreErrors;
    integrations.push(eventFiltersIntegration(filterOptions));
  }

  if (
    !hasIntegration(MinigameIntegration.id) &&
    (options.enableMinigameLifecycle === true ||
      (minigame && options.enableMinigameLifecycle !== false))
  ) {
    integrations.push(new MinigameIntegration());
  }
  if (
    !hasIntegration(MinigameFrameRateIntegration.id) &&
    (options.enableMinigameFrameRate === true ||
      (minigame && options.enableMinigameFrameRate !== false))
  ) {
    // 细调通过 minigameFrameRateOptions 传入（见 MiniappOptions）。
    integrations.push(new MinigameFrameRateIntegration(options.minigameFrameRateOptions));
  }

  if (options.traceLifecycle === 'stream') integrations.push(spanStreamingIntegration());

  return integrations;
}

/**
 * @deprecated 直接复用本数组的实例，会在多次 init / 多 client 间共享 setupOnce 状态、互相踩补丁。
 * 请改用 {@link getDefaultIntegrations}（每次返回全新实例）。导出仅为向后兼容保留。
 */
export const defaultIntegrations: Integration[] = getDefaultIntegrations();

/**
 * Initialize the Sentry Miniapp SDK
 * @param options Configuration options for the SDK
 */
export function init(options: MiniappOptions = {}): MiniappClient | undefined {
  if (!isMiniappEnvironment()) {
    console.warn('[sentry-miniapp] Not running in a supported miniapp environment');
    return undefined;
  }

  // Snapshot new privacy fields before any spread can execute their accessors.
  const networkDetails = snapshotNetworkOptions(options);
  const safeOptions: Record<string, unknown> = {};
  for (const key of Object.keys(options)) {
    if (!Object.prototype.hasOwnProperty.call(networkDetails, key)) {
      Object.defineProperty(safeOptions, key, {
        value: options[key as keyof MiniappOptions],
        enumerable: true,
      });
    }
  }
  options = { ...safeOptions, ...networkDetails } as MiniappOptions;

  const previous = getClient();
  if (previous instanceof MiniappClient) {
    // Cleanup is synchronous; the old transport may finish its already-started flush.
    void Promise.resolve(previous.close(0)).catch(() => {});
  }
  const opts = {
    ...options,
    stackParser: options.stackParser || miniappStackParser,
    transport: options.transport,
    // MiniappClient resolves the defaults/user callback once, as part of constructing its options.
    defaultIntegrations: options.defaultIntegrations ?? getDefaultIntegrations(options),
  };

  // 平台标记。device / os / app context 由 MiniappClient._prepareEvent 在每个事件上统一写入
  // （唯一权威），此处不再重复设置，避免字段不一致与覆盖歧义（见架构 review P2-b）。
  setContext('miniapp', {
    platform: appName(),
    environment: 'miniapp',
  });

  // initAndBind 要求预先解析 transport；MiniappClient 构造器在绑定前统一解析平台 transport，
  // 因此仅在此处桥接初始化类型，不把未解析的选项暴露为 client.getOptions()。
  return initAndBind(MiniappClient, opts as MiniappClientOptions) as MiniappClient;
}

/**
 * @deprecated Miniapp environment does not support Sentry's default HTML report dialog.
 * Please implement your own UI form to collect user feedback (name, email, comments)
 * and use `Sentry.captureFeedback()` to submit it to Sentry.
 *
 * 小程序环境不支持 Sentry 官方的 HTML 反馈弹窗。
 * 请自行实现 UI 表单收集用户反馈，并调用 `Sentry.captureFeedback()` 进行上报。
 */
export function showReportDialog(_options: ReportDialogOptions = {}): void {
  console.warn(
    '[sentry-miniapp] showReportDialog is deprecated and does nothing. ' +
      'Please build your own UI and use `Sentry.captureFeedback()` instead.',
  );
}

/**
 * Miniapp compatibility API: return a callback which captures synchronous errors and rethrows.
 * This is not a public API of @sentry/browser 10.76.2. It preserves the existing beta contract.
 */
export function wrap<T extends (...args: any[]) => any>(fn: T): T {
  return wrapCallback(fn) as T;
}

/**
 * 设置用户对隐私协议的同意状态（配合 `init({ requireConsent: true })` 使用）。
 *
 * - `setConsent(true)`：补发「同意前」缓冲的事件，并恢复正常上报。
 * - `setConsent(false)`：重新闸断网络上报，后续事件继续进入本地缓冲。
 *
 * 未开启 `requireConsent` 时调用本函数无门禁副作用（门禁本就放行）。
 */
export function setConsent(granted: boolean): void {
  setConsentGranted(granted);
  const client = getClient<MiniappClient>();
  if (client?.setConsent) {
    client.setConsent(granted);
    return;
  }
  if (granted) {
    // 不传 timeout → 触发 core offline transport 立即排空缓冲队列（见 makeOfflineTransport.flush，
    // 内部 retryDelay 复位 + flushIn(MIN_DELAY)）。fire-and-forget：排空走定时器，无需 await。
    getClient()?.getTransport()?.flush?.();
  }
}

/** 读取当前同意状态（未开启 requireConsent 时恒为 true）。 */
export function getConsent(): boolean {
  return getClient<MiniappClient>()?.getConsent?.() ?? isConsentGranted();
}

// Preserve the core feedback contract, including an explicit scope and event IDs without a client.
export { captureFeedback } from '@sentry/core';
