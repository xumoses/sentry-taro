import type * as Sentry from '../../sdk/src/index';

import type { SentryMiniappReplaySdk } from '../src/types';

type AssertSdk<T extends SentryMiniappReplaySdk> = T;

export type WorkspaceSdkContract = AssertSdk<typeof Sentry>;
