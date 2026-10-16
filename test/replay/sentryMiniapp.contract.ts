import type * as Sentry from '../../src/sdk/index';

import type { SentryMiniappReplaySdk } from '../../src/replay/types';

type AssertSdk<T extends SentryMiniappReplaySdk> = T;

export type WorkspaceSdkContract = AssertSdk<typeof Sentry>;
